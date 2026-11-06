import { Inject, Injectable } from '@nestjs/common';
import { and, asc, count, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { DB } from '../../db';
import * as schema from '../../db/schema';
import { bookFiles, bookMetadata, books, libraries } from '../../db/schema';

type Db = NodePgDatabase<typeof schema>;

export type DuplicateFormatFileRow = {
  id: number;
  absolutePath: string;
  sizeBytes: number | null;
  fileHash: string | null;
};

@Injectable()
export class LibraryIntegrityRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  async findDuplicateFormatGroups(libraryIds: number[], offset: number, limit: number) {
    if (libraryIds.length === 0) return { items: [], total: 0 };

    const groups = this.db
      .select({
        bookId: books.id,
        title: bookMetadata.title,
        libraryId: books.libraryId,
        libraryName: libraries.name,
        folderPath: books.folderPath,
        format: sql<string>`lower(trim(${bookFiles.format}))`,
        fileCount: count(bookFiles.id),
        files: sql<DuplicateFormatFileRow[]>`json_agg(
          json_build_object(
            'id', ${bookFiles.id},
            'absolutePath', ${bookFiles.absolutePath},
            'sizeBytes', ${bookFiles.sizeBytes},
            'fileHash', ${bookFiles.fileHash}
          ) order by ${bookFiles.absolutePath}
        )`,
      })
      .from(bookFiles)
      .innerJoin(books, eq(books.id, bookFiles.bookId))
      .innerJoin(libraries, eq(libraries.id, books.libraryId))
      .leftJoin(bookMetadata, eq(bookMetadata.bookId, books.id))
      .where(
        and(
          inArray(books.libraryId, libraryIds),
          eq(books.status, 'present'),
          eq(bookFiles.role, 'content'),
          isNotNull(bookFiles.format),
        ),
      )
      .groupBy(books.id, bookMetadata.title, libraries.name, sql`lower(trim(${bookFiles.format}))`)
      .having(sql`count(${bookFiles.id}) > 1`)
      .as('duplicate_format_groups');

    const [countRow] = await this.db.select({ total: count() }).from(groups);
    const items = await this.db
      .select({
        bookId: groups.bookId,
        title: groups.title,
        libraryId: groups.libraryId,
        libraryName: groups.libraryName,
        folderPath: groups.folderPath,
        format: groups.format,
        fileCount: groups.fileCount,
        files: groups.files,
      })
      .from(groups)
      .orderBy(asc(groups.libraryId), asc(groups.bookId), asc(groups.format))
      .offset(offset)
      .limit(limit);

    return { items, total: countRow?.total ?? 0 };
  }
}
