import { Controller, Get, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { Permission } from '@bookorbit/types';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import type { RequestUser } from '../../common/types/request-user';
import { ContentVerificationService } from './content-verification.service';
import { ListContentVerificationDto } from './dto/list-content-verification.dto';

@Controller('maintenance/content-verification')
@RequirePermission(Permission.LibraryDownload)
export class ContentVerificationController {
  constructor(private readonly service: ContentVerificationService) {}

  @Get()
  list(@Query() dto: ListContentVerificationDto, @CurrentUser() user: RequestUser) {
    return this.service.list(user, dto.page, dto.pageSize);
  }

  @Get(':fileId')
  getResult(@Param('fileId', ParseIntPipe) fileId: number, @CurrentUser() user: RequestUser) {
    return this.service.getResult(user, fileId);
  }

  @Post(':fileId/verify')
  verifyFile(@Param('fileId', ParseIntPipe) fileId: number, @CurrentUser() user: RequestUser) {
    return this.service.verifyFile(user, fileId);
  }
}
