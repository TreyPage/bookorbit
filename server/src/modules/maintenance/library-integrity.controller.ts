import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { Permission } from '@bookorbit/types';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import type { RequestUser } from '../../common/types/request-user';
import { LibraryIntegrityScanSchedulerService } from './library-integrity-scan-scheduler.service';
import { ListLibraryIntegrityDto } from './dto/library-integrity.dto';
import { CleanupEmptyBookFolderDto } from './dto/cleanup-empty-book-folder.dto';
import { MergeSeriesDto } from './dto/merge-series.dto';
import { LibraryIntegrityService } from './library-integrity.service';

@Controller('maintenance/library-integrity')
@RequirePermission(Permission.LibraryDeleteBooks)
export class LibraryIntegrityController {
  constructor(
    private readonly service: LibraryIntegrityService,
    private readonly scanScheduler: LibraryIntegrityScanSchedulerService,
  ) {}

  @Get('scan-status')
  getScanStatus() {
    return this.scanScheduler.getLastScan();
  }

  @Post('scan-now')
  startScan() {
    return this.scanScheduler.startScan();
  }

  @Get('filesystem-findings')
  listFilesystemFindings(@CurrentUser() user: RequestUser) {
    return this.service.listFilesystemFindings(user);
  }

  @Post('filesystem-findings/cleanup-empty-folder')
  cleanupEmptyBookFolder(@Body() dto: CleanupEmptyBookFolderDto, @CurrentUser() user: RequestUser) {
    return this.service.cleanupEmptyBookFolder(user, dto.libraryId, dto.path);
  }

  @Post('filesystem-findings/cleanup-orphaned-file')
  cleanupOrphanedFile(@Body() dto: CleanupEmptyBookFolderDto, @CurrentUser() user: RequestUser) {
    return this.service.cleanupOrphanedFile(user, dto.libraryId, dto.path);
  }

  @Get('sidecar-files')
  listSidecarFiles(@Query() dto: ListLibraryIntegrityDto, @CurrentUser() user: RequestUser) {
    return this.service.listSidecarFiles(user, dto.page, dto.pageSize);
  }

  @Get('duplicate-formats')
  listDuplicateFormats(@Query() dto: ListLibraryIntegrityDto, @CurrentUser() user: RequestUser) {
    return this.service.listDuplicateFormats(user, dto.page, dto.pageSize);
  }
  @Get('series-name-candidates')
  listSimilarSeries(@CurrentUser() user: RequestUser) {
    return this.service.listSimilarSeries(user);
  }

  @Post('series-name-merge')
  mergeSeries(@Body() dto: MergeSeriesDto, @CurrentUser() user: RequestUser) {
    return this.service.mergeSeries(user, dto);
  }
}
