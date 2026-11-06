import { Controller, Get, Query } from '@nestjs/common';
import { Permission } from '@bookorbit/types';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import type { RequestUser } from '../../common/types/request-user';
import { ListLibraryIntegrityDto } from './dto/library-integrity.dto';
import { LibraryIntegrityService } from './library-integrity.service';

@Controller('maintenance/library-integrity')
@RequirePermission(Permission.LibraryDeleteBooks)
export class LibraryIntegrityController {
  constructor(private readonly service: LibraryIntegrityService) {}

  @Get('sidecar-files')
  listSidecarFiles(@Query() dto: ListLibraryIntegrityDto, @CurrentUser() user: RequestUser) {
    return this.service.listSidecarFiles(user, dto.page, dto.pageSize);
  }

  @Get('duplicate-formats')
  listDuplicateFormats(@Query() dto: ListLibraryIntegrityDto, @CurrentUser() user: RequestUser) {
    return this.service.listDuplicateFormats(user, dto.page, dto.pageSize);
  }
}
