import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { Permission } from '@bookorbit/types';

import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../../common/decorators/require-permission.decorator';
import { RequireAnyPermission } from '../../../common/decorators/require-any-permission.decorator';
import type { RequestUser } from '../../../common/types/request-user';
import { ContentVerificationService } from './content-verification.service';
import { ContentVerificationSchedulerService, type ContentVerificationSchedule } from './content-verification-scheduler.service';
import { ListContentVerificationDto } from './dto/list-content-verification.dto';
import { ReviewContentVerificationDto } from './dto/review-content-verification.dto';
import { PreviewContentVerificationCorrectionDto } from './dto/preview-content-verification-correction.dto';

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

  @Get('background/settings')
  @RequireAnyPermission(Permission.ManageLibraries, Permission.ManageAppSettings, Permission.LibraryDownload)
  getBackgroundSettings() {
    return this.scheduler.getSchedule();
  }

  @Put('background/settings')
  @RequireAnyPermission(Permission.ManageLibraries, Permission.ManageAppSettings, Permission.LibraryDownload)
  updateBackgroundSettings(@Body() body: Partial<ContentVerificationSchedule>) {
    return this.scheduler.updateSchedule(body);
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

  @Get(':fileId/correction/targets')
  @RequirePermission(Permission.LibraryDownload)
  searchCorrectionTargets(@Param('fileId', ParseIntPipe) fileId: number, @Query('q') query: string | undefined, @CurrentUser() user: RequestUser) {
    return this.service.searchCorrectionTargets(user, fileId, query);
  }

  @Post(':fileId/correction/preview')
  @RequirePermission(Permission.LibraryDownload)
  previewCorrection(
    @Param('fileId', ParseIntPipe) fileId: number,
    @Body() dto: PreviewContentVerificationCorrectionDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.previewCorrection(user, fileId, dto);
  }

  @Post(':fileId/correction/execute')
  @RequirePermission(Permission.LibraryDownload)
  executeCorrection(
    @Param('fileId', ParseIntPipe) fileId: number,
    @Body() dto: PreviewContentVerificationCorrectionDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.executeCorrection(user, fileId, dto);
  }

  @Post(':fileId/verify')
  verifyFile(@Param('fileId', ParseIntPipe) fileId: number, @CurrentUser() user: RequestUser) {
    return this.service.verifyFile(user, fileId);
  }
}
