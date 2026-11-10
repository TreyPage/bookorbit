import { Controller, Get } from '@nestjs/common';
import { AuditAction, Permission } from '@bookorbit/types';

import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { AuditService } from '../audit/audit.service';

@Controller('admin/book-request-automation/runs')
@RequirePermission(Permission.ManageBookRequests)
export class BookRequestAutomationRunsController {
  constructor(private readonly audit: AuditService) {}

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
