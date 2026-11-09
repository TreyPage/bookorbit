import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { Permission } from '@bookorbit/types';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import type { RequestUser } from '../../common/types/request-user';
import { ContentVerificationService } from './content-verification.service';
import { ContentVerificationSchedulerService } from './content-verification-scheduler.service';
import { ListContentVerificationDto } from './dto/list-content-verification.dto';
import { ReviewContentVerificationDto } from './dto/review-content-verification.dto';

@Controller('maintenance/content-verification')
@RequirePermission(Permission.LibraryDownload)
export class ContentVerificationController {
  constructor(
    private readonly service: ContentVerificationService,
    private readonly scheduler: ContentVerificationSchedulerService,
  ) {}

  @Get('background/status')
  getBackgroundStatus() {
    return this.scheduler.getStatus();
  }

  @Post('background/run')
  runBackgroundBatch() {
    return this.scheduler.startBatch();
  }

  @Get()
  list(@Query() dto: ListContentVerificationDto, @CurrentUser() user: RequestUser) {
    return this.service.list(user, dto.page, dto.pageSize, dto.filter);
  }

  @Get(':fileId')
  getResult(@Param('fileId', ParseIntPipe) fileId: number, @CurrentUser() user: RequestUser) {
    return this.service.getResult(user, fileId);
  }

  @Patch(':fileId/review')
  @RequirePermission(Permission.LibraryDownload)
  reviewFile(@Param('fileId', ParseIntPipe) fileId: number, @Body() dto: ReviewContentVerificationDto, @CurrentUser() user: RequestUser) {
    return this.service.reviewFile(user, fileId, dto.reviewStatus, dto.reviewNote);
  }

  @Post(':fileId/verify')
  verifyFile(@Param('fileId', ParseIntPipe) fileId: number, @CurrentUser() user: RequestUser) {
    return this.service.verifyFile(user, fileId);
  }
}
