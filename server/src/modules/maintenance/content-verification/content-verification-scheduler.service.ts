import { BadRequestException, Injectable, Logger } from '@nestjs/common';

import { SystemCron } from '../../../common/decorators/system-cron.decorator';
import { sanitizeLogValue } from '../../../common/utils/log-sanitize.utils';
import { SYSTEM_TIME_ZONE } from '../../../common/utils/timezone.utils';
import { AppSettingsService } from '../../app-settings/app-settings.service';
import { AudiobookOpeningTranscriptionService } from './audiobook-opening-transcription.service';
import { ContentVerificationRepository } from './content-verification.repository';
import { ContentVerificationService } from './content-verification.service';

const SETTINGS_KEY = 'content_verification_schedule';
const DEFAULT_SCHEDULE: ContentVerificationSchedule = {
  enabled: true,
  startTime: '01:00',
  endTime: '06:00',
  batchSize: 3,
  delaySeconds: 30,
};
const MIN_BATCH_SIZE = 1;
const MAX_BATCH_SIZE = 25;
const MIN_DELAY_SECONDS = 0;
const MAX_DELAY_SECONDS = 3600;

export interface ContentVerificationSchedule {
  enabled: boolean;
  startTime: string;
  endTime: string;
  batchSize: number;
  delaySeconds: number;
}

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
 * Import events only enqueue candidates. Scheduled work is admitted during the configured
 * maintenance window, in bounded batches, and stops starting new files as soon as the window ends.
 * A manual "run batch" is an explicit operator override, but still uses the same bounded batch.
 */
@Injectable()
export class ContentVerificationSchedulerService {
  private readonly logger = new Logger(ContentVerificationSchedulerService.name);
  private running = false;
  private afterFileId = 0;
  private readonly pendingFileIds: number[] = [];
  private readonly queuedFileIds = new Set<number>();
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
    private readonly appSettings: AppSettingsService,
  ) {}

  getStatus(): ContentVerificationJobStatus {
    return { ...this.status };
  }

  private requeueCandidates(candidates: Array<{ fileId: number; format: string | null }>): void {
    for (const candidate of candidates.reverse()) {
      if (this.queuedFileIds.has(candidate.fileId)) this.pendingFileIds.unshift(candidate.fileId);
    }
  }

  async getSchedule(): Promise<ContentVerificationSchedule> {
    const raw = await this.appSettings.getValue(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SCHEDULE };
    try {
      return normalizeSchedule(JSON.parse(raw));
    } catch {
      return { ...DEFAULT_SCHEDULE };
    }
  }

  async updateSchedule(input: Partial<ContentVerificationSchedule>): Promise<ContentVerificationSchedule> {
    const current = await this.getSchedule();
    const next = normalizeSchedule({ ...current, ...input });
    await this.appSettings.setValue(SETTINGS_KEY, JSON.stringify(next));
    return next;
  }

  async enqueueBooks(bookIds: number[]): Promise<void> {
    if (!this.verification.isAiConfigured() || bookIds.length === 0) return;
    try {
      const fileIds = await this.repository.listVerificationFileIdsForBooks([...new Set(bookIds)], this.transcription.isConfigured());
      for (const fileId of fileIds) {
        if (this.queuedFileIds.has(fileId)) continue;
        this.queuedFileIds.add(fileId);
        this.pendingFileIds.push(fileId);
      }
      // Deliberately do not start AI work here. Imports can happen at any hour.
    } catch (error) {
      const message = sanitizeLogValue(error instanceof Error ? error.message : String(error));
      this.logger.warn(`[content-verification.import] error="${message}" - imported files remain eligible for scheduled verification`);
    }
  }

  startBatch(): ContentVerificationJobStatus {
    if (!this.running) void this.runBatch(true);
    return this.getStatus();
  }

  @SystemCron('0 * * * * *')
  async runScheduledBatch(): Promise<void> {
    const schedule = await this.getSchedule();
    if (!schedule.enabled || !isWithinMaintenanceWindow(schedule)) return;
    await this.runBatch(false, schedule);
  }

  async runBatch(manual = false, suppliedSchedule?: ContentVerificationSchedule): Promise<ContentVerificationJobStatus> {
    if (this.running) return this.getStatus();
    if (!this.verification.isAiConfigured()) {
      this.status = { ...this.status, status: 'waiting_for_provider' };
      return this.getStatus();
    }

    const schedule = suppliedSchedule ?? (await this.getSchedule());
    if (!manual && (!schedule.enabled || !isWithinMaintenanceWindow(schedule))) return this.getStatus();

    this.running = true;
    this.status = { ...this.status, status: 'running', lastRunAt: new Date().toISOString(), lastError: null };
    try {
      const queuedCandidates = this.pendingFileIds.splice(0, schedule.batchSize).map((fileId) => ({ fileId, format: null }));
      const candidates =
        queuedCandidates.length > 0
          ? queuedCandidates
          : await this.repository.listPendingCandidates(this.afterFileId, schedule.batchSize, this.transcription.isConfigured());

      if (candidates.length === 0) {
        this.afterFileId = 0;
        this.status = { ...this.status, status: 'idle' };
        return this.getStatus();
      }

      let processedInBatch = 0;
      for (let index = 0; index < candidates.length; index++) {
        const candidate = candidates[index];
        if (!manual && (!schedule.enabled || !isWithinMaintenanceWindow(schedule))) {
          if (queuedCandidates.length > 0) this.requeueCandidates(candidates.slice(index));
          break;
        }
        if (processedInBatch > 0 && schedule.delaySeconds > 0) {
          await delay(schedule.delaySeconds * 1000);
          if (!manual && (!schedule.enabled || !isWithinMaintenanceWindow(schedule))) {
            if (queuedCandidates.length > 0) this.requeueCandidates(candidates.slice(index));
            break;
          }
        }

        this.afterFileId = Math.max(this.afterFileId, candidate.fileId);
        this.queuedFileIds.delete(candidate.fileId);
        processedInBatch++;
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

function normalizeSchedule(value: unknown): ContentVerificationSchedule {
  if (typeof value !== 'object' || value === null) throw new BadRequestException('Content verification schedule must be an object');
  const candidate = value as Partial<ContentVerificationSchedule>;
  const startTime = candidate.startTime ?? DEFAULT_SCHEDULE.startTime;
  const endTime = candidate.endTime ?? DEFAULT_SCHEDULE.endTime;
  const batchSize = candidate.batchSize ?? DEFAULT_SCHEDULE.batchSize;
  const delaySeconds = candidate.delaySeconds ?? DEFAULT_SCHEDULE.delaySeconds;
  if (typeof candidate.enabled !== 'boolean') throw new BadRequestException('Schedule enabled must be a boolean');
  if (!isClockTime(startTime) || !isClockTime(endTime) || startTime === endTime) {
    throw new BadRequestException('Maintenance window must use valid, different HH:MM start and end times');
  }
  if (!Number.isInteger(batchSize) || batchSize < MIN_BATCH_SIZE || batchSize > MAX_BATCH_SIZE) {
    throw new BadRequestException(`Batch size must be between ${MIN_BATCH_SIZE} and ${MAX_BATCH_SIZE}`);
  }
  if (!Number.isInteger(delaySeconds) || delaySeconds < MIN_DELAY_SECONDS || delaySeconds > MAX_DELAY_SECONDS) {
    throw new BadRequestException(`Delay must be between ${MIN_DELAY_SECONDS} and ${MAX_DELAY_SECONDS} seconds`);
  }
  return { enabled: candidate.enabled, startTime, endTime, batchSize, delaySeconds };
}

function isClockTime(value: unknown): value is string {
  return typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function isWithinMaintenanceWindow(schedule: ContentVerificationSchedule, now = new Date()): boolean {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: SYSTEM_TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? 0);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? 0);
  const current = hour * 60 + minute;
  const start = clockMinutes(schedule.startTime);
  const end = clockMinutes(schedule.endTime);
  return start < end ? current >= start && current < end : current >= start || current < end;
}

function clockMinutes(value: string): number {
  const [hour, minute] = value.split(':').map(Number);
  return hour * 60 + minute;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
