import { Injectable, Logger } from '@nestjs/common';

import { SystemCron } from '../../../common/decorators/system-cron.decorator';
import { sanitizeLogValue } from '../../../common/utils/log-sanitize.utils';
import { AudiobookOpeningTranscriptionService } from './audiobook-opening-transcription.service';
import { ContentVerificationRepository } from './content-verification.repository';
import { ContentVerificationService } from './content-verification.service';

const BATCH_SIZE = 5;

export interface ContentVerificationJobStatus {
  status: 'idle' | 'running' | 'waiting_for_provider';
  processed: number;
  matches: number;
  mismatches: number;
  inconclusive: number;
  errors: number;
  lastRunAt: string | null;
  lastError: string | null;
}

/**
 * Processes a small number of pending files per tick. It never modifies book metadata
 * or library files; failed files do not block later candidates in the same batch.
 */
@Injectable()
export class ContentVerificationSchedulerService {
  private readonly logger = new Logger(ContentVerificationSchedulerService.name);
  private running = false;
  private afterFileId = 0;
  private status: ContentVerificationJobStatus = {
    status: 'idle',
    processed: 0,
    matches: 0,
    mismatches: 0,
    inconclusive: 0,
    errors: 0,
    lastRunAt: null,
    lastError: null,
  };

  constructor(
    private readonly repository: ContentVerificationRepository,
    private readonly verification: ContentVerificationService,
    private readonly transcription: AudiobookOpeningTranscriptionService,
  ) {}

  getStatus(): ContentVerificationJobStatus {
    return { ...this.status };
  }

  startBatch(): ContentVerificationJobStatus {
    if (!this.running) void this.runBatch();
    return this.getStatus();
  }

  @SystemCron('0 */15 * * * *')
  async runScheduledBatch(): Promise<void> {
    await this.runBatch();
  }

  async runBatch(): Promise<ContentVerificationJobStatus> {
    if (this.running) return this.getStatus();
    if (!this.verification.isAiConfigured()) {
      this.status = { ...this.status, status: 'waiting_for_provider' };
      return this.getStatus();
    }

    this.running = true;
    this.status = { ...this.status, status: 'running', lastRunAt: new Date().toISOString(), lastError: null };
    try {
      const candidates = await this.repository.listPendingCandidates(
        this.afterFileId,
        BATCH_SIZE,
        this.transcription.isConfigured(),
      );

      if (candidates.length === 0) {
        this.afterFileId = 0;
        this.status = { ...this.status, status: 'idle' };
        return this.getStatus();
      }

      for (const candidate of candidates) {
        this.afterFileId = candidate.fileId;
        try {
          const result = await this.verification.verifyFileForSystem(candidate.fileId);
          this.status = {
            ...this.status,
            processed: this.status.processed + 1,
            matches: this.status.matches + Number(result.status === 'match'),
            mismatches: this.status.mismatches + Number(result.status === 'mismatch'),
            inconclusive: this.status.inconclusive + Number(result.status === 'inconclusive'),
          };
        } catch (error) {
          const message = sanitizeLogValue(error instanceof Error ? error.message : String(error));
          this.status = { ...this.status, processed: this.status.processed + 1, errors: this.status.errors + 1, lastError: message };
          this.logger.warn(`[content-verification.background] fileId=${candidate.fileId} error="${message}" - candidate failed; continuing batch`);
        }
      }

      this.status = { ...this.status, status: 'idle' };
      return this.getStatus();
    } catch (error) {
      const message = sanitizeLogValue(error instanceof Error ? error.message : String(error));
      this.status = { ...this.status, status: 'idle', lastError: message };
      this.logger.error(`[content-verification.background] error="${message}" - batch failed`);
      return this.getStatus();
    } finally {
      this.running = false;
    }
  }
}
