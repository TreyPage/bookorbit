import { Injectable, Logger } from '@nestjs/common';
import { AuditAction, AuditResource } from '@bookorbit/types';
import { CronExpression } from '@nestjs/schedule';

import { SystemCron } from '../../../common/decorators/system-cron.decorator';
import { AUDIT_EVENT, AuditEventsService } from '../../audit/audit-events.service';
import { sanitizeLogValue } from '../../../common/utils/log-sanitize.utils';
import { DownloadClientConfigService } from '../download-clients/download-client-config.service';
import { DownloadClientRegistry } from '../download-clients/download-client-registry';
import type { DownloadStatus } from '../download-clients/download-client-adapter';
import { BookRequestDownloadRepository } from './book-request-download.repository';
import { DownloadRemovalService } from './download-removal.service';

/**
 * Checks completed, imported torrents rather than adding them to the hot download poll loop.
 * Seed goals are attached to the torrent by the existing per-indexer policy and reported back
 * by the client, so the worker does not invent a second, potentially conflicting goal.
 *
 * Reaching either configured goal is sufficient. Removing a seed always keeps its files: the
 * imported library copy may be a hardlink to those bytes, and deleting them would delete the book.
 */
@Injectable()
export class RequestSeedCleanupSchedulerService {
  private readonly logger = new Logger(RequestSeedCleanupSchedulerService.name);
  private running = false;

  constructor(
    private readonly downloads: BookRequestDownloadRepository,
    private readonly clients: DownloadClientConfigService,
    private readonly registry: DownloadClientRegistry,
    private readonly removal: DownloadRemovalService,
    private readonly auditEvents: AuditEventsService,
  ) {}

  @SystemCron(CronExpression.EVERY_MINUTE)
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.cleanupDueSeeds();
    } catch (error) {
      this.logFailure('sweep', error);
    } finally {
      this.running = false;
    }
  }

  private async cleanupDueSeeds(): Promise<void> {
    let afterId = 0;
    let candidatesTotal = 0;
    let checkedTotal = 0;
    let removedTotal = 0;

    // Keyset pagination prevents the oldest 500 rows without goals from starving newer torrents.
    while (true) {
      const candidates = await this.downloads.findImportedTorrentSeeds(afterId);
      if (candidates.length === 0) break;
      afterId = candidates[candidates.length - 1].id;
      candidatesTotal += candidates.length;

      const result = await this.cleanupBatch(candidates);
      checkedTotal += result.checked;
      removedTotal += result.removed;
      if (candidates.length < 500) break;
    }

    if (checkedTotal > 0 || removedTotal > 0) {
      this.logger.log(
        `[book_request.seed_cleanup] [sweep] candidates=${candidatesTotal} checked=${checkedTotal} removed=${removedTotal} - seed cleanup sweep finished`,
      );
    }
  }

  private async cleanupBatch(candidates: Awaited<ReturnType<BookRequestDownloadRepository['findImportedTorrentSeeds']>>): Promise<{ checked: number; removed: number }> {
    const byClient = new Map<number, typeof candidates>();
    for (const download of candidates) {
      if (download.downloadClientId === null || download.clientKey === null) continue;
      const rows = byClient.get(download.downloadClientId) ?? [];
      rows.push(download);
      byClient.set(download.downloadClientId, rows);
    }

    let checked = 0;
    let removed = 0;
    for (const [clientId, rows] of byClient) {
      try {
        const config = await this.clients.resolveConfig(clientId);
        const adapter = this.registry.require(config.adapterType);
        const statuses = await adapter.status(rows.map((row) => row.clientKey!).filter(Boolean), config);
        const statusByKey = new Map(statuses.map((status) => [status.clientKey.toLowerCase(), status]));

        for (const download of rows) {
          if (!download.clientKey) continue;
          const status = statusByKey.get(download.clientKey.toLowerCase());
          if (!status) continue;
          checked++;
          if (!this.goalReached(status)) continue;
          // The candidate query filters protected requests, but the setting can change while the
          // download client is answering. Re-read immediately before the destructive client action.
          if (await this.downloads.isSeedCleanupProtected(download.requestId)) continue;

          // detachAttempt is best-effort and deliberately leaves the imported DB attempt intact.
          // deleteFiles=false is non-negotiable: the library may hardlink to the seeded payload.
          const error = await this.removal.detachAttempt(download, false);
          if (error !== null) {
            this.logFailure('remove', new Error(`downloadId=${download.id}: ${error}`));
            continue;
          }
          // Retire the client identity after a successful detach. The imported attempt stays
          // in history, but no longer needs to be queried on every future scheduler tick.
          await this.downloads.updateIf(download.id, ['imported'], { clientKey: null });
          this.auditEvents.emit(AUDIT_EVENT, {
            userId: null,
            actorUsername: 'system',
            action: AuditAction.BookRequestSeedCleanup,
            resource: AuditResource.BookRequest,
            resourceId: download.requestId,
            description: 'Removed the torrent from the download client after its seed goal was reached; retained downloaded files',
            meta: { requestId: download.requestId, downloadId: download.id, downloadClientId: clientId },
          });
          removed++;
          this.logger.log(
            `[book_request.seed_cleanup] [end] requestId=${download.requestId} downloadId=${download.id} clientId=${clientId} - removed torrent after its seed goal was reached; retained downloaded files`,
          );
        }
      } catch (error) {
        this.logFailure(`client_${clientId}`, error);
      }
    }

    return { checked, removed };
  }

  private goalReached(status: DownloadStatus): boolean {
    const seed = status.seed;
    if (!seed) return false;

    const ratioReached =
      seed.ratioGoal !== null && seed.ratioGoal > 0 && seed.ratio !== null && seed.ratio >= seed.ratioGoal;
    const timeReached =
      seed.seedingTimeGoalMinutes !== null &&
      seed.seedingTimeGoalMinutes > 0 &&
      seed.seedingTimeSeconds !== null &&
      seed.seedingTimeSeconds >= seed.seedingTimeGoalMinutes * 60;

    return ratioReached || timeReached;
  }

  private logFailure(event: string, error: unknown): void {
    const message = sanitizeLogValue(error instanceof Error ? error.message : String(error));
    this.logger.warn(
      `[book_request.seed_cleanup] [fail] event=${event} errorClass=${error instanceof Error ? error.constructor.name : 'Error'} error="${message}" - seed cleanup could not complete`,
    );
  }
}
