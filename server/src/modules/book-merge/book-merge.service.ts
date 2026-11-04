import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import type { BookMergeCandidateCursor, BookMergeCandidatePage } from '@bookorbit/types';

import type { RequestUser } from '../../common/types/request-user';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { LibraryService } from '../library/library.service';
import type { BookMergeCandidatesDto } from './dto/book-merge-candidates.dto';
import { BookMergeRepository } from './book-merge.repository';

@Injectable()
export class BookMergeService {
  private readonly logger = new Logger(BookMergeService.name);

  constructor(
    private readonly repository: BookMergeRepository,
    private readonly libraryService: LibraryService,
  ) {}

  async findCandidates(dto: BookMergeCandidatesDto, user: RequestUser): Promise<BookMergeCandidatePage> {
    const startedAt = Date.now();
    const accessibleLibraryIds = await this.libraryService.findAccessibleLibraryIds(user);
    if (dto.libraryId !== undefined && !accessibleLibraryIds.includes(dto.libraryId)) {
      throw new ForbiddenException('Library is not accessible');
    }
    if ((dto.cursorBookIdA === undefined) !== (dto.cursorBookIdB === undefined)) {
      throw new BadRequestException('Both cursor book IDs must be provided together');
    }
    const cursor: BookMergeCandidateCursor | null =
      dto.cursorBookIdA !== undefined && dto.cursorBookIdB !== undefined ? { bookIdA: dto.cursorBookIdA, bookIdB: dto.cursorBookIdB } : null;
    const libraryIds = dto.libraryId === undefined ? accessibleLibraryIds : [dto.libraryId];
    const similarityPercent = dto.similarityPercent ?? 85;
    this.logger.log(
      `[book.merge_candidates] [start] userId=${user.id} libraryCount=${libraryIds.length} similarityPercent=${similarityPercent} - merge candidate search started`,
    );
    try {
      const result = await this.repository.findCandidates(libraryIds, user, similarityPercent, cursor);
      this.logger.log(
        `[book.merge_candidates] [end] userId=${user.id} durationMs=${Date.now() - startedAt} candidateCount=${result.candidates.length} hasMore=${result.nextCursor !== null} - merge candidate search completed`,
      );
      return result;
    } catch (error) {
      const errorClass = error instanceof Error ? error.name : 'Error';
      const errorMessage = sanitizeLogValue(error instanceof Error ? error.message : String(error));
      this.logger.warn(
        `[book.merge_candidates] [fail] userId=${user.id} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${errorMessage}" - merge candidate search failed`,
      );
      throw error;
    }
  }

  async mergeBooks(sourceBookIds: number[], targetBookId: number, user: RequestUser): Promise<{ merged: number; targetBookId: number }> {
    const uniqueIds = [...new Set([...sourceBookIds, targetBookId])];
    const accessibleLibraryIds = await this.libraryService.findAccessibleLibraryIds(user);
    const accessibleIds = await this.repository.findAccessibleBookIds(uniqueIds, accessibleLibraryIds, user);
    if (accessibleIds.length !== uniqueIds.length) throw new ForbiddenException('One or more books are not accessible');
    if (sourceBookIds.includes(targetBookId)) throw new BadRequestException('The target book cannot also be a source book');

    const startedAt = Date.now();
    this.logger.log(`[book.merge] [start] userId=${user.id} targetBookId=${targetBookId} sourceCount=${sourceBookIds.length} - book merge started`);
    try {
      const merged = await this.repository.mergeBooks(sourceBookIds, targetBookId);
      this.logger.log(
        `[book.merge] [end] userId=${user.id} targetBookId=${targetBookId} durationMs=${Date.now() - startedAt} mergedCount=${merged} - book merge completed`,
      );
      return { merged, targetBookId };
    } catch (error) {
      const errorClass = error instanceof Error ? error.name : 'Error';
      const errorMessage = sanitizeLogValue(error instanceof Error ? error.message : String(error));
      this.logger.warn(
        `[book.merge] [fail] userId=${user.id} targetBookId=${targetBookId} sourceCount=${sourceBookIds.length} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${errorMessage}" - book merge failed`,
      );
      throw error;
    }
  }
}
