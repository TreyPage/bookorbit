import { Body, Controller, Post } from '@nestjs/common';
import { AuditAction, AuditResource, Permission } from '@bookorbit/types';

import { Auditable } from '../../common/decorators/auditable.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import type { RequestUser } from '../../common/types/request-user';
import { BookMergeCandidatesDto } from './dto/book-merge-candidates.dto';
import { MergeBooksDto } from './dto/merge-books.dto';
import { BookMergeService } from './book-merge.service';

@Controller('books')
@RequirePermission(Permission.LibraryDeleteBooks)
export class BookMergeController {
  constructor(private readonly service: BookMergeService) {}

  @Post('merge-candidates')
  findCandidates(@Body() dto: BookMergeCandidatesDto, @CurrentUser() user: RequestUser) {
    return this.service.findCandidates(dto, user);
  }

  @Post('merge')
  @Auditable({
    action: AuditAction.BookMerge,
    resource: AuditResource.Book,
    description: (req) => {
      const body = req.body as { sourceBookIds?: number[]; targetBookId?: number };
      return `Merged ${body?.sourceBookIds?.length ?? 0} books into book #${body?.targetBookId ?? 'unknown'}`;
    },
  })
  mergeBooks(@Body() dto: MergeBooksDto, @CurrentUser() user: RequestUser) {
    return this.service.mergeBooks(dto.sourceBookIds, dto.targetBookId, user);
  }
}
