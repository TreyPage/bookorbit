import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray } from 'drizzle-orm';
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
