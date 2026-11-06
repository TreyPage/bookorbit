import { Injectable } from '@nestjs/common';
import type { DuplicateFormatGroup, DuplicateFormatPage } from '@bookorbit/types';

import type { RequestUser } from '../../common/types/request-user';
import { LibraryService } from '../library/library.service';
import { LibraryIntegrityRepository } from './library-integrity.repository';

@Injectable()
export class LibraryIntegrityService {
  constructor(
    private readonly repo: LibraryIntegrityRepository,
    private readonly libraryService: LibraryService,
  ) {}

  async listDuplicateFormats(user: RequestUser, page: number, pageSize: number): Promise<DuplicateFormatPage> {
    const libraryIds = await this.libraryService.findAccessibleLibraryIds(user);
    const result = await this.repo.findDuplicateFormatGroups(libraryIds, (page - 1) * pageSize, pageSize);

    return {
      items: result.items.map((item) => ({
        bookId: item.bookId,
        title: item.title,
        libraryId: item.libraryId,
        libraryName: item.libraryName,
        folderPath: item.folderPath,
        format: item.format,
        fileCount: item.fileCount,
        files: item.files,
      })) as DuplicateFormatGroup[],
      total: result.total,
      page,
      pageSize,
    };
  }
}
