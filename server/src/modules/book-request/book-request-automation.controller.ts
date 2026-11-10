import { Body, Controller, Get, Put } from '@nestjs/common';
import { AuditAction, AuditResource, Permission } from '@bookorbit/types';

import { Auditable } from '../../common/decorators/auditable.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { UpdateAutomationSettingsDto } from './dto/automation-settings.dto';
import { AuditService } from '../audit/audit.service';
import { RequestAutomationSettingsService } from './fulfillment/request-automation-settings.service';

/**
 * Gated on `ManageAppSettings`, matching the indexer and download-client rows: deciding that the
 * instance may grab releases unattended is an instance-configuration decision, not a moderation
 * one, and an approver should not get it by having the queue.
 *
 * Its own path rather than a segment under `admin/book-requests`, where it would be matched by
 * that controller's `:id` routes and rejected by their integer pipe.
 */
@Controller('admin/book-request-automation')
@RequirePermission(Permission.ManageAppSettings)
export class BookRequestAutomationController {
  constructor(private readonly settings: RequestAutomationSettingsService, private readonly audit: AuditService) {}

  @Get('runs')
  getRuns() {
    return this.audit.getAuditLogs({ action: AuditAction.BookRequestAutomationRun, page: 1, pageSize: 50 });
  }

  @Get()
  get() {
    return this.settings.get();
  }

  @Put()
  @Auditable({
    action: AuditAction.AppSettingsUpdate,
    resource: AuditResource.AppSettings,
    description: 'Updated book request automation settings',
  })
  update(@Body() dto: UpdateAutomationSettingsDto) {
    return this.settings.update(dto);
  }
}
