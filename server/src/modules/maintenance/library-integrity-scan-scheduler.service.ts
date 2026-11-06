import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { LibraryIntegrityScanStatus } from '@bookorbit/types';

import { SystemCron } from '../../common/decorators/system-cron.decorator';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { LibraryIntegrityRepository } from './library-integrity.repository';
import { LibraryIntegrityService } from './library-integrity.service';

@Injectable()
export class LibraryIntegrityScanSchedulerService implements OnModuleInit {
  private readonly logger = new Logger(LibraryIntegrityScanSchedulerService.name);
  private running = false;
  private lastScan: LibraryIntegrityScanStatus | null = null;

  constructor(
    private readonly integrityService: LibraryIntegrityService,
    private readonly repository: LibraryIntegrityRepository,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      this.lastScan = await this.repository.getLibraryIntegrityScanStatus();
      if (this.lastScan?.status === 'running') {
        this.lastScan = {
          ...this.lastScan,
          status: 'failed',
          completedAt: new Date().toISOString(),
          errorMessage: 'Scan interrupted by application restart.',
        };
        await this.persist(this.lastScan);
      }
    } catch (error) {
      this.logger.error(
        `[library.integrity.scan] [restore-fail] error="${sanitizeLogValue(error instanceof Error ? error.message : String(error))}" - could not restore persisted scan status`,
      );
    }
  }

  getLastScan(): LibraryIntegrityScanStatus | null {
    return this.lastScan;
  }

  /** Starts a scan without holding the HTTP request open until filesystem traversal completes. */
  startScan(): LibraryIntegrityScanStatus | null {
    if (!this.running) void this.runNow();
    return this.lastScan;
  }

  @SystemCron('0 0 3 * * *')
  async runScheduledScan(): Promise<void> {
    await this.runNow();
  }

  async runNow(): Promise<LibraryIntegrityScanStatus | null> {
    if (this.running) return this.lastScan;
    this.running = true;
    const startedAt = new Date().toISOString();
    this.lastScan = { status: 'running', startedAt, completedAt: null, summary: null, errorMessage: null };
    await this.persist(this.lastScan);
    this.logger.log('[library.integrity.scan] [start] - read-only library integrity scan started');
    try {
      const summary = await this.integrityService.scanAllLibraries();
      this.lastScan = { status: 'completed', startedAt, completedAt: new Date().toISOString(), summary, errorMessage: null };
      this.logger.log(
        `[library.integrity.scan] [end] libraryCount=${summary.libraryCount} duplicateFormatGroups=${summary.duplicateFormatGroups} duplicateFormatFiles=${summary.duplicateFormatFiles} sidecarEntries=${summary.sidecarEntries} sidecarScanTruncated=${summary.sidecarScanTruncated} orphanedMetadataFiles=${summary.orphanedMetadataFiles} emptyBookFolders=${summary.emptyBookFolders} orphanedCoverDirectories=${summary.orphanedCoverDirectories} orphanedCoverBytes=${summary.orphanedCoverBytes} filesystemScanTruncated=${summary.filesystemScanTruncated} - read-only library integrity scan completed`,
      );
    } catch (error) {
      const message = sanitizeLogValue(error instanceof Error ? error.message : String(error));
      this.lastScan = { status: 'failed', startedAt, completedAt: new Date().toISOString(), summary: null, errorMessage: message };
      this.logger.error(`[library.integrity.scan] [fail] error="${message}" - read-only library integrity scan failed`);
    } finally {
      this.running = false;
      if (this.lastScan) await this.persist(this.lastScan);
    }
    return this.lastScan;
  }

  private async persist(status: LibraryIntegrityScanStatus): Promise<void> {
    try {
      await this.repository.saveLibraryIntegrityScanStatus(status);
    } catch (error) {
      this.logger.error(
        `[library.integrity.scan] [persist-fail] error="${sanitizeLogValue(error instanceof Error ? error.message : String(error))}" - could not persist scan status`,
      );
    }
  }
}
