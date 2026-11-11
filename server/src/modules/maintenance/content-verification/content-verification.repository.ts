import { Inject, Injectable } from '@nestjs/common';
import { and, asc, count, eq, gt, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { DB } from '../../../db';
import * as schema from '../../../db/schema';
import { authors, bookAuthors, bookContentVerifications, bookFiles, bookMetadata, books, libraries, libraryFolders } from '../../../db/schema';

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
      .select({ id: bookFiles.id, format: bookFiles.format, role: bookFiles.role })
      .from(bookFiles)
      .where(eq(bookFiles.bookId, source.bookId));
    const contentFileCount = sourceFiles.filter((file) => file.role === 'content').length;
    const audioContentCount = sourceFiles.filter(
      (file) => file.role === 'content' && file.format && ['m4b', 'm4a', 'mp3', 'aac', 'flac', 'ogg', 'opus', 'wav'].includes(file.format.toLowerCase()),
    ).length;

    let target: null | { bookId: number; libraryId: number; libraryFolderId: number; folderPath: string; title: string | null } = null;
    let targetFormatCount = 0;
    if (targetBookId !== undefined) {
      const [targetRow] = await this.db
        .select({
          bookId: books.id,
          libraryId: books.libraryId,
          libraryFolderId: books.libraryFolderId,
          folderPath: books.folderPath,
          title: bookMetadata.title,
        })
        .from(books)
        .leftJoin(bookMetadata, eq(bookMetadata.bookId, books.id))
        .where(and(eq(books.id, targetBookId), eq(books.status, 'present')))
        .limit(1);
      if (targetRow) {
        target = targetRow;
        const matching = await this.db
          .select({ id: bookFiles.id })
          .from(bookFiles)
          .where(and(eq(bookFiles.bookId, targetBookId), eq(bookFiles.role, 'content'), sql`lower(${bookFiles.format}) = ${String(source.format ?? '').toLowerCase()}`));
        targetFormatCount = matching.length;
      }
    }

    return { source, contentFileCount, audioContentCount, target, targetFormatCount };
  }

}
