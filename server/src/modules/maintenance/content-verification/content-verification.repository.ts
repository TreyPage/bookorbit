import { Inject, Injectable } from '@nestjs/common';
import { dirname, extname } from 'node:path';
import { and, asc, count, eq, gt, ilike, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { DB } from '../../../db';
import * as schema from '../../../db/schema';
import { authors, bookAuthors, bookContentVerifications, bookFiles, bookMetadata, books, libraries, libraryFolders } from '../../../db/schema';
import { selectPrimaryFileKeepingCurrent } from '../../../common/utils/primary-file-selection.utils';

type Db = NodePgDatabase<typeof schema>;

@Injectable()
export class ContentVerificationRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  async listCandidates(libraryIds: number[], offset: number, limit: number, filter: 'all' | 'needs_review' | 'reviewed' | 'mismatch' = 'all') {
    if (libraryIds.length === 0) return { items: [], total: 0 };
    const supportedFormats = ['epub', 'm4b', 'm4a', 'mp3', 'aac', 'flac', 'ogg', 'opus', 'wav'];
    const where = and(
      inArray(books.libraryId, libraryIds),
      eq(books.status, 'present'),
      eq(bookFiles.role, 'content'),
      inArray(sql<string>`lower(${bookFiles.format})`, supportedFormats),
      filter === 'needs_review'
        ? or(
            and(
              inArray(bookContentVerifications.status, ['mismatch', 'inconclusive', 'error'] as const),
              or(isNull(bookContentVerifications.reviewStatus), eq(bookContentVerifications.reviewStatus, 'needs_recheck')),
            ),
            and(isNotNull(bookContentVerifications.id), sql`${bookContentVerifications.fileHash} is distinct from ${bookFiles.fileHash}`),
          )
        : filter === 'reviewed'
          ? inArray(bookContentVerifications.reviewStatus, ['confirmed_mismatch', 'false_positive'] as const)
          : filter === 'mismatch'
            ? eq(bookContentVerifications.status, 'mismatch')
            : undefined,
    )!;

    const [countRow] = await this.db
      .select({ total: count() })
      .from(bookFiles)
      .innerJoin(books, eq(books.id, bookFiles.bookId))
      .leftJoin(bookContentVerifications, eq(bookContentVerifications.bookFileId, bookFiles.id))
      .where(where);
    const items = await this.db
      .select({
        fileId: bookFiles.id,
        bookId: books.id,
        title: bookMetadata.title,
        format: bookFiles.format,
        fileHash: bookFiles.fileHash,
        status: bookContentVerifications.status,
        source: bookContentVerifications.source,
        detectedTitle: bookContentVerifications.detectedTitle,
        detectedAuthor: bookContentVerifications.detectedAuthor,
        confidence: bookContentVerifications.confidence,
        explanation: bookContentVerifications.explanation,
        evidence: bookContentVerifications.evidence,
        reviewStatus: bookContentVerifications.reviewStatus,
        reviewNote: bookContentVerifications.reviewNote,
        reviewedAt: bookContentVerifications.reviewedAt,
        reviewedBy: bookContentVerifications.reviewedBy,
        verifiedAt: bookContentVerifications.verifiedAt,
        stale: sql<boolean>`case when ${bookContentVerifications.id} is null then false else ${bookContentVerifications.fileHash} is distinct from ${bookFiles.fileHash} end`,
      })
      .from(bookFiles)
      .innerJoin(books, eq(books.id, bookFiles.bookId))
      .leftJoin(bookMetadata, eq(bookMetadata.bookId, books.id))
      .leftJoin(bookContentVerifications, eq(bookContentVerifications.bookFileId, bookFiles.id))
      .where(where)
      .orderBy(asc(bookMetadata.title), asc(books.id), asc(bookFiles.id))
      .offset(offset)
      .limit(limit);

    return { items, total: countRow?.total ?? 0 };
  }

  async listPendingCandidates(afterFileId: number, limit: number, includeAudiobooks: boolean) {
    const supportedFormats = includeAudiobooks ? ['epub', 'm4b', 'm4a', 'mp3', 'aac', 'flac', 'ogg', 'opus', 'wav'] : ['epub'];
    return this.db
      .select({ fileId: bookFiles.id, format: bookFiles.format })
      .from(bookFiles)
      .innerJoin(books, eq(books.id, bookFiles.bookId))
      .innerJoin(bookMetadata, eq(bookMetadata.bookId, books.id))
      .leftJoin(bookContentVerifications, eq(bookContentVerifications.bookFileId, bookFiles.id))
      .where(
        and(
          gt(bookFiles.id, afterFileId),
          eq(books.status, 'present'),
          eq(bookFiles.role, 'content'),
          sql`btrim(${bookMetadata.title}) <> ''`,
          inArray(sql<string>`lower(${bookFiles.format})`, supportedFormats),
          // A multipart audiobook is one book: verify its first segment, not every track as a separate title.
          or(
            sql`lower(${bookFiles.format}) not in ('m4b', 'm4a', 'mp3', 'aac', 'flac', 'ogg', 'opus', 'wav')`,
            isNull(bookFiles.sortOrder),
            eq(bookFiles.sortOrder, 0),
          ),
          or(
            isNull(bookContentVerifications.id),
            sql`${bookContentVerifications.fileHash} is distinct from ${bookFiles.fileHash}`,
            eq(bookContentVerifications.reviewStatus, 'needs_recheck'),
          ),
        ),
      )
      .orderBy(asc(bookFiles.id))
      .limit(limit);
  }

  async listVerificationFileIdsForBooks(bookIds: number[], includeAudiobooks: boolean): Promise<number[]> {
    if (bookIds.length === 0) return [];
    const supportedFormats = includeAudiobooks ? ['epub', 'm4b', 'm4a', 'mp3', 'aac', 'flac', 'ogg', 'opus', 'wav'] : ['epub'];
    const rows = await this.db
      .select({ fileId: bookFiles.id })
      .from(bookFiles)
      .innerJoin(books, eq(books.id, bookFiles.bookId))
      .innerJoin(bookMetadata, eq(bookMetadata.bookId, books.id))
      .leftJoin(bookContentVerifications, eq(bookContentVerifications.bookFileId, bookFiles.id))
      .where(
        and(
          inArray(books.id, bookIds),
          eq(books.status, 'present'),
          eq(bookFiles.role, 'content'),
          sql`btrim(${bookMetadata.title}) <> ''`,
          inArray(sql<string>`lower(${bookFiles.format})`, supportedFormats),
          // A multipart audiobook is one book: verify its first segment, not every track as a separate title.
          or(
            sql`lower(${bookFiles.format}) not in ('m4b', 'm4a', 'mp3', 'aac', 'flac', 'ogg', 'opus', 'wav')`,
            isNull(bookFiles.sortOrder),
            eq(bookFiles.sortOrder, 0),
          ),
          or(isNull(bookContentVerifications.id), sql`${bookContentVerifications.fileHash} is distinct from ${bookFiles.fileHash}`),
        ),
      )
      .orderBy(asc(bookFiles.id));
    return rows.map((row) => row.fileId);
  }

  async findFileForVerification(fileId: number, libraryIds: number[]) {
    if (libraryIds.length === 0) return null;
    const [file] = await this.db
      .select({
        fileId: bookFiles.id,
        bookId: books.id,
        libraryId: books.libraryId,
        absolutePath: bookFiles.absolutePath,
        fileHash: bookFiles.fileHash,
        format: bookFiles.format,
        title: bookMetadata.title,
      })
      .from(bookFiles)
      .innerJoin(books, eq(books.id, bookFiles.bookId))
      .leftJoin(bookMetadata, eq(bookMetadata.bookId, books.id))
      .where(and(eq(bookFiles.id, fileId), eq(bookFiles.role, 'content'), eq(books.status, 'present'), inArray(books.libraryId, libraryIds)))
      .limit(1);
    if (!file) return null;

    const authorRows = await this.db
      .select({ name: authors.name })
      .from(bookAuthors)
      .innerJoin(authors, eq(authors.id, bookAuthors.authorId))
      .where(eq(bookAuthors.bookId, file.bookId))
      .orderBy(asc(bookAuthors.displayOrder));

    return { ...file, authors: authorRows.map((author) => author.name) };
  }

  async findResultForFile(fileId: number) {
    const [result] = await this.db.select().from(bookContentVerifications).where(eq(bookContentVerifications.bookFileId, fileId)).limit(1);
    return result ?? null;
  }

  async updateReview(
    fileId: number,
    review: {
      reviewStatus: 'confirmed_mismatch' | 'false_positive' | 'needs_recheck' | null;
      reviewNote: string | null;
      reviewedBy: number | null;
      reviewedAt: Date | null;
    },
  ) {
    const [result] = await this.db
      .update(bookContentVerifications)
      .set({ ...review, updatedAt: new Date() })
      .where(eq(bookContentVerifications.bookFileId, fileId))
      .returning();
    return result ?? null;
  }

  async saveResult(input: typeof bookContentVerifications.$inferInsert) {
    const [result] = await this.db
      .insert(bookContentVerifications)
      .values(input)
      .onConflictDoUpdate({
        target: bookContentVerifications.bookFileId,
        set: {
          ...input,
          reviewStatus: null,
          reviewNote: null,
          reviewedBy: null,
          reviewedAt: null,
          verifiedAt: new Date(),
          updatedAt: new Date(),
        },
      })
      .returning();
    return result;
  }

  async findCorrectionContext(fileId: number, libraryIds: number[], targetBookId?: number) {
    if (libraryIds.length === 0) return null;
    const [source] = await this.db
      .select({
        fileId: bookFiles.id,
        bookId: books.id,
        libraryId: books.libraryId,
        libraryFolderId: books.libraryFolderId,
        libraryFolderPath: libraryFolders.path,
        organizationMode: libraries.organizationMode,
        bookFolderPath: books.folderPath,
        absolutePath: bookFiles.absolutePath,
        relPath: bookFiles.relPath,
        format: bookFiles.format,
        role: bookFiles.role,
        sortOrder: bookFiles.sortOrder,
        fileHash: bookFiles.fileHash,
        title: bookMetadata.title,
        verificationStatus: bookContentVerifications.status,
        verificationFileHash: bookContentVerifications.fileHash,
        reviewStatus: bookContentVerifications.reviewStatus,
      })
      .from(bookFiles)
      .innerJoin(books, eq(books.id, bookFiles.bookId))
      .innerJoin(libraryFolders, eq(libraryFolders.id, books.libraryFolderId))
      .innerJoin(libraries, eq(libraries.id, books.libraryId))
      .leftJoin(bookMetadata, eq(bookMetadata.bookId, books.id))
      .leftJoin(bookContentVerifications, eq(bookContentVerifications.bookFileId, bookFiles.id))
      .where(and(eq(bookFiles.id, fileId), eq(books.status, 'present'), inArray(books.libraryId, libraryIds)))
      .limit(1);
    if (!source) return null;

    const sourceFiles = await this.db
      .select({ id: bookFiles.id, format: bookFiles.format, absolutePath: bookFiles.absolutePath, role: bookFiles.role })
      .from(bookFiles)
      .where(eq(bookFiles.bookId, source.bookId));
    const contentFileCount = sourceFiles.filter((file) => file.role === 'content').length;
    const audioContentCount = sourceFiles.filter(
      (file) =>
        file.role === 'content' &&
        ['m4b', 'm4a', 'mp3', 'aac', 'flac', 'ogg', 'opus', 'wav'].includes((file.format || extname(file.absolutePath).slice(1)).toLowerCase()),
    ).length;

    let target: null | {
      bookId: number;
      libraryId: number;
      libraryFolderId: number;
      folderPath: string;
      destinationFolderPath: string;
      title: string | null;
    } = null;
    let targetFormatCount = 0;
    const sourceFormat = (source.format || extname(source.absolutePath).slice(1)).toLowerCase();
    if (targetBookId !== undefined) {
      const [targetRow] = await this.db
        .select({
          bookId: books.id,
          libraryId: books.libraryId,
          libraryFolderId: books.libraryFolderId,
          folderPath: books.folderPath,
          primaryFilePath: bookFiles.absolutePath,
          title: bookMetadata.title,
        })
        .from(books)
        .leftJoin(bookMetadata, eq(bookMetadata.bookId, books.id))
        .leftJoin(bookFiles, eq(bookFiles.id, books.primaryFileId))
        .where(and(eq(books.id, targetBookId), eq(books.status, 'present')))
        .limit(1);
      if (targetRow) {
        target = {
          ...targetRow,
          destinationFolderPath: targetRow.folderPath === targetRow.primaryFilePath ? dirname(targetRow.folderPath) : targetRow.folderPath,
        };
        const matching = await this.db
          .select({ format: bookFiles.format, absolutePath: bookFiles.absolutePath })
          .from(bookFiles)
          .where(and(eq(bookFiles.bookId, targetBookId), eq(bookFiles.role, 'content')));
        targetFormatCount = matching.filter(
          (candidate) => (candidate.format || extname(candidate.absolutePath).slice(1)).toLowerCase() === sourceFormat,
        ).length;
      }
    }

    return { source, contentFileCount, audioContentCount, target, targetFormatCount };
  }

  async isBookFolderPathTaken(libraryId: number, folderPath: string): Promise<boolean> {
    const [existing] = await this.db
      .select({ id: books.id })
      .from(books)
      .where(and(eq(books.libraryId, libraryId), eq(books.folderPath, folderPath)))
      .limit(1);
    return Boolean(existing);
  }

  async findCorrectionTargets(fileId: number, libraryIds: number[], query: string) {
    const context = await this.findCorrectionContext(fileId, libraryIds);
    if (!context || context.source.reviewStatus !== 'confirmed_mismatch') return null;
    const normalizedQuery = query.trim();
    return this.db
      .select({
        bookId: books.id,
        title: bookMetadata.title,
        authors: sql<string[]>`coalesce(array_agg(distinct ${authors.name}::text), ARRAY[]::text[])`,
      })
      .from(books)
      .innerJoin(bookMetadata, eq(bookMetadata.bookId, books.id))
      .leftJoin(bookAuthors, eq(bookAuthors.bookId, books.id))
      .leftJoin(authors, eq(authors.id, bookAuthors.authorId))
      .where(
        and(
          eq(books.libraryId, context.source.libraryId),
          eq(books.libraryFolderId, context.source.libraryFolderId),
          eq(books.status, 'present'),
          ne(books.id, context.source.bookId),
          sql`not exists (
            select 1 from book_files correction_target_file
            where correction_target_file.book_id = ${books.id}
              and correction_target_file.role = 'content'
              and lower(coalesce(correction_target_file.format, regexp_replace(correction_target_file.absolute_path, '^.*[.]', ''))) = ${(context.source.format || extname(context.source.absolutePath).slice(1)).toLowerCase()}
          )`,
          normalizedQuery ? ilike(bookMetadata.title, `%${normalizedQuery}%`) : undefined,
        ),
      )
      .groupBy(books.id, bookMetadata.title)
      .orderBy(asc(bookMetadata.title), asc(books.id))
      .limit(20);
  }

  async findCorrectionFileLocation(fileId: number) {
    const [file] = await this.db
      .select({
        fileId: bookFiles.id,
        bookId: bookFiles.bookId,
        absolutePath: bookFiles.absolutePath,
      })
      .from(bookFiles)
      .where(eq(bookFiles.id, fileId))
      .limit(1);
    return file ?? null;
  }

  async applyFileCorrection(input: {
    fileId: number;
    sourceBookId: number;
    targetBookId?: number;
    targetType: 'existing_book' | 'new_book';
    destinationPath: string;
    destinationFolderPath: string;
    targetBookFolderPath?: string;
    destinationRelPath: string;
    sourcePath: string;
    sourceHash: string;
    format: string;
    reviewedBy: number;
    fileStats: { ino: bigint; sizeBytes: number; mtime: Date };
    title?: string;
    author?: string;
  }) {
    return this.db.transaction(async (tx) => {
      const [source] = await tx
        .select({
          id: books.id,
          libraryId: books.libraryId,
          libraryFolderId: books.libraryFolderId,
          folderPath: books.folderPath,
          primaryFileId: books.primaryFileId,
          organizationMode: libraries.organizationMode,
          formatPriority: libraries.formatPriority,
          status: books.status,
        })
        .from(books)
        .innerJoin(libraries, eq(libraries.id, books.libraryId))
        .where(eq(books.id, input.sourceBookId))
        .for('update')
        .limit(1);
      if (!source || source.status !== 'present') throw new Error('Source book no longer exists or is no longer present');

      const [file] = await tx
        .select({
          id: bookFiles.id,
          bookId: bookFiles.bookId,
          libraryFolderId: bookFiles.libraryFolderId,
          role: bookFiles.role,
          format: bookFiles.format,
          absolutePath: bookFiles.absolutePath,
          fileHash: bookFiles.fileHash,
        })
        .from(bookFiles)
        .where(eq(bookFiles.id, input.fileId))
        .for('update')
        .limit(1);
      if (
        !file ||
        file.bookId !== source.id ||
        file.libraryFolderId !== source.libraryFolderId ||
        file.role !== 'content' ||
        file.absolutePath !== input.sourcePath ||
        file.fileHash !== input.sourceHash
      ) {
        throw new Error('Source file changed before correction could be applied');
      }

      const [verification] = await tx
        .select({
          fileHash: bookContentVerifications.fileHash,
          status: bookContentVerifications.status,
          reviewStatus: bookContentVerifications.reviewStatus,
        })
        .from(bookContentVerifications)
        .where(eq(bookContentVerifications.bookFileId, input.fileId))
        .for('update')
        .limit(1);
      if (
        !verification ||
        verification.fileHash !== input.sourceHash ||
        verification.reviewStatus !== 'confirmed_mismatch' ||
        !['mismatch', 'inconclusive'].includes(verification.status)
      ) {
        throw new Error('The confirmed mismatch or its verification evidence changed before correction could be applied');
      }

      const sourceFilesBefore = await tx
        .select({
          id: bookFiles.id,
          absolutePath: bookFiles.absolutePath,
          format: bookFiles.format,
          role: bookFiles.role,
          sizeBytes: bookFiles.sizeBytes,
          mediaOverlayAvailable: bookFiles.mediaOverlayAvailable,
        })
        .from(bookFiles)
        .where(eq(bookFiles.bookId, source.id));
      const remainingFiles = sourceFilesBefore.filter((candidate) => candidate.id !== input.fileId);
      const remainingContent = remainingFiles.filter((candidate) => candidate.role === 'content');
      if (remainingContent.length === 0) throw new Error('The source book would be left without a content file');

      let destinationBookId: number;
      if (input.targetType === 'existing_book') {
        if (!input.targetBookId || input.targetBookId === source.id) throw new Error('Invalid destination book');
        const [target] = await tx
          .select({
            id: books.id,
            libraryId: books.libraryId,
            libraryFolderId: books.libraryFolderId,
            primaryFileId: books.primaryFileId,
            folderPath: books.folderPath,
            status: books.status,
          })
          .from(books)
          .where(eq(books.id, input.targetBookId))
          .for('update')
          .limit(1);
        if (
          !target ||
          target.status !== 'present' ||
          target.libraryId !== source.libraryId ||
          target.libraryFolderId !== source.libraryFolderId ||
          target.folderPath !== input.targetBookFolderPath
        ) {
          throw new Error('Destination book is no longer in the source library folder');
        }
        const targetContentFiles = await tx
          .select({ format: bookFiles.format, absolutePath: bookFiles.absolutePath })
          .from(bookFiles)
          .where(and(eq(bookFiles.bookId, target.id), eq(bookFiles.role, 'content')));
        if (
          targetContentFiles.some(
            (candidate) => (candidate.format || extname(candidate.absolutePath).slice(1)).toLowerCase() === input.format.toLowerCase(),
          )
        ) {
          throw new Error('Destination book already contains this format');
        }
        destinationBookId = target.id;
      } else {
        const title = input.title?.trim();
        const authorName = input.author?.trim();
        if (!title || !authorName) throw new Error('A title and author are required to create a new book');
        const [createdBook] = await tx
          .insert(books)
          .values({
            libraryId: source.libraryId,
            libraryFolderId: source.libraryFolderId,
            folderPath: input.destinationFolderPath,
            status: 'present',
          })
          .returning({ id: books.id });
        destinationBookId = createdBook.id;
        await tx.insert(bookMetadata).values({ bookId: destinationBookId, title });
        await tx.insert(authors).values({ name: authorName }).onConflictDoNothing();
        const [authorRow] = await tx
          .select({ id: authors.id, sortName: authors.sortName })
          .from(authors)
          .where(sql`lower(${authors.name}) = ${authorName.toLowerCase()}`)
          .limit(1);
        if (!authorRow) throw new Error('Could not resolve the new book author');
        await tx.insert(bookAuthors).values({ bookId: destinationBookId, authorId: authorRow.id, displayOrder: 0 });
        await tx
          .update(books)
          .set({ primaryAuthorSortName: authorRow.sortName ?? authorName })
          .where(eq(books.id, destinationBookId));
      }

      await tx
        .update(bookFiles)
        .set({
          bookId: destinationBookId,
          libraryFolderId: source.libraryFolderId,
          absolutePath: input.destinationPath,
          relPath: input.destinationRelPath,
          ino: input.fileStats.ino,
          sizeBytes: input.fileStats.sizeBytes,
          mtime: input.fileStats.mtime,
          format: input.format,
          updatedAt: new Date(),
        })
        .where(eq(bookFiles.id, input.fileId));

      await tx
        .update(bookContentVerifications)
        .set({
          reviewStatus: 'needs_recheck',
          reviewedBy: input.reviewedBy,
          reviewedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(bookContentVerifications.bookFileId, input.fileId));

      const [targetPrimary] = await tx.select({ primaryFileId: books.primaryFileId }).from(books).where(eq(books.id, destinationBookId)).limit(1);
      if (input.targetType === 'new_book') {
        await tx.update(books).set({ primaryFileId: input.fileId, updatedAt: new Date() }).where(eq(books.id, destinationBookId));
      } else if (targetPrimary?.primaryFileId == null) {
        const destinationFiles = await tx
          .select({
            id: bookFiles.id,
            format: bookFiles.format,
            sizeBytes: bookFiles.sizeBytes,
            mediaOverlayAvailable: bookFiles.mediaOverlayAvailable,
          })
          .from(bookFiles)
          .where(and(eq(bookFiles.bookId, destinationBookId), eq(bookFiles.role, 'content')));
        const destinationPrimary = selectPrimaryFileKeepingCurrent(destinationFiles, null, source.formatPriority ?? []);
        await tx
          .update(books)
          .set({ primaryFileId: destinationPrimary?.id ?? input.fileId, updatedAt: new Date() })
          .where(eq(books.id, destinationBookId));
      } else {
        await tx.update(books).set({ updatedAt: new Date() }).where(eq(books.id, destinationBookId));
      }

      const nextSourcePrimary = selectPrimaryFileKeepingCurrent(
        remainingContent,
        source.primaryFileId === input.fileId ? null : source.primaryFileId,
        source.formatPriority ?? [],
      );
      await tx
        .update(books)
        .set({
          primaryFileId: nextSourcePrimary?.id ?? null,
          ...((source.organizationMode === 'book_per_file' || source.folderPath === input.sourcePath) && nextSourcePrimary
            ? { folderPath: nextSourcePrimary.absolutePath }
            : {}),
          updatedAt: new Date(),
        })
        .where(eq(books.id, source.id));

      return { fileId: input.fileId, sourceBookId: source.id, destinationBookId, targetType: input.targetType };
    });
  }
}
