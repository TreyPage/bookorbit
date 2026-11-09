import { Inject, Injectable } from '@nestjs/common';
import { and, asc, count, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { DB } from '../../db';
import * as schema from '../../db/schema';
import {
  authors,
  bookAuthors,
  bookContentVerifications,
  bookFiles,
  bookMetadata,
  books,
} from '../../db/schema';

type Db = NodePgDatabase<typeof schema>;

@Injectable()
export class ContentVerificationRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  async listCandidates(libraryIds: number[], offset: number, limit: number) {
    if (libraryIds.length === 0) return { items: [], total: 0 };
    const supportedFormats = ['epub', 'm4b', 'm4a', 'mp3', 'aac', 'flac', 'ogg', 'opus', 'wav'];
    const where = and(
      inArray(books.libraryId, libraryIds),
      eq(books.status, 'present'),
      eq(bookFiles.role, 'content'),
      inArray(sql<string>`lower(${bookFiles.format})`, supportedFormats),
    )!;

    const [countRow] = await this.db
      .select({ total: count() })
      .from(bookFiles)
      .innerJoin(books, eq(books.id, bookFiles.bookId))
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
    const supportedFormats = includeAudiobooks
      ? ['epub', 'm4b', 'm4a', 'mp3', 'aac', 'flac', 'ogg', 'opus', 'wav']
      : ['epub'];
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
          or(
            isNull(bookContentVerifications.id),
            sql`${bookContentVerifications.fileHash} is distinct from ${bookFiles.fileHash}`,
          ),
        ),
      )
      .orderBy(asc(bookFiles.id))
      .limit(limit);
  }

  async listVerificationFileIdsForBooks(bookIds: number[], includeAudiobooks: boolean): Promise<number[]> {
    if (bookIds.length === 0) return [];
    const supportedFormats = includeAudiobooks
      ? ['epub', 'm4b', 'm4a', 'mp3', 'aac', 'flac', 'ogg', 'opus', 'wav']
      : ['epub'];
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
          or(
            isNull(bookContentVerifications.id),
            sql`${bookContentVerifications.fileHash} is distinct from ${bookFiles.fileHash}`,
          ),
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
      .where(
        and(
          eq(bookFiles.id, fileId),
          eq(bookFiles.role, 'content'),
          eq(books.status, 'present'),
          inArray(books.libraryId, libraryIds),
        ),
      )
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
    const [result] = await this.db
      .select()
      .from(bookContentVerifications)
      .where(eq(bookContentVerifications.bookFileId, fileId))
      .limit(1);
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
          verifiedAt: new Date(),
          updatedAt: new Date(),
        },
      })
      .returning();
    return result;
  }
}
