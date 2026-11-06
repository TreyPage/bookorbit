import { Injectable, Logger } from '@nestjs/common';
import type { LibraryIntegrityScanStatus } from '@bookorbit/types';

import { SystemCron } from '../../common/decorators/system-cron.decorator';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { LibraryIntegrityService } from './library-integrity.service';

@Injectable()
export class LibraryIntegrityScanSchedulerService {
  private readonly logger = new Logger(LibraryIntegrityScanSchedulerService.name);
  private running = false;
  private lastScan: LibraryIntegrityScanStatus | null = null;

  constructor(private readonly integrityService: LibraryIntegrityService) {}

  getLastScan(): LibraryIntegrityScanStatus | null {
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
    }

    return this.lastScan;
  }
}
