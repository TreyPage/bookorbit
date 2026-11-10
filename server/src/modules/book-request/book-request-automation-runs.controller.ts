import { BadRequestException, Controller, Get, Param, Post } from '@nestjs/common';
import { AuditAction, Permission } from '@bookorbit/types';

import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { AuditService } from '../audit/audit.service';
import { RequestAutomationService } from './fulfillment/request-automation.service';
import { RequestSeedCleanupSchedulerService } from './fulfillment/request-seed-cleanup-scheduler.service';
import { RequestWatchdogService } from './fulfillment/request-watchdog.service';

@Controller('admin/book-request-automation/runs')
@RequirePermission(Permission.ManageBookRequests)
export class BookRequestAutomationRunsController {
  constructor(
    private readonly audit: AuditService,
    private readonly automation: RequestAutomationService,
    private readonly seedCleanup: RequestSeedCleanupSchedulerService,
    private readonly watchdog: RequestWatchdogService,
  ) {}

  @Post(':job/run')
  async runNow(@Param('job') job: string) {
    const started = job === 'periodic_search'
      ? await this.automation.sweepUnfulfilled()
      : job === 'seed_cleanup'
        ? await this.seedCleanup.tick()
        : job === 'watchdog'
          ? await this.watchdog.sweep()
          : null;
    if (started === null) throw new BadRequestException('Unknown request automation job');
    return { started };
  }

  @Get()
  async getRuns() {
    const actions = [
      AuditAction.BookRequestAutomationRun,
      AuditAction.BookRequestAutoRetry,
      AuditAction.BookRequestAutoRelease,
      AuditAction.BookRequestAutomationExhausted,
      AuditAction.BookRequestStalled,
      AuditAction.BookRequestImportStalled,
      AuditAction.BookRequestSeedCleanup,
    ];
    const pages = await Promise.all(actions.map((action) => this.audit.getAuditLogs({ action, page: 1, pageSize: 50 })));
    return {
      data: pages.flatMap((page) => page.data).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, 50),
    };
  }
}
