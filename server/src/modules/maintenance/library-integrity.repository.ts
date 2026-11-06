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
        format: sql<string>`lower(trim(${bookFiles.format}))`.as('format'),
        fileCount: count(bookFiles.id).as('fileCount'),
        files: sql<DuplicateFormatFileRow[]>`json_agg(
          json_build_object(
            'id', ${bookFiles.id},
            'absolutePath', ${bookFiles.absolutePath},
            'sizeBytes', ${bookFiles.sizeBytes},
            'fileHash', ${bookFiles.fileHash}
          ) order by ${bookFiles.absolutePath}
        )`.as('files'),
      })
      .from(bookFiles)
      .innerJoin(books, eq(books.id, bookFiles.bookId))
      .innerJoin(libraries, eq(libraries.id, books.libraryId))
      .leftJoin(bookMetadata, eq(bookMetadata.bookId, books.id))
      .where(and(inArray(books.libraryId, libraryIds), eq(books.status, 'present'), eq(bookFiles.role, 'content'), isNotNull(bookFiles.format)))
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

  async findSimilarSeriesPairs(libraryIds: number[]) {
    if (libraryIds.length === 0) return { items: [], truncated: false };

    const result = await this.db.execute(sql`
      SELECT
        left_series.id AS left_id,
        left_series.name AS left_name,
        (
          SELECT count(DISTINCT visible_book.id)::int
          FROM book_series_memberships membership
          INNER JOIN books visible_book ON visible_book.id = membership.book_id
          WHERE membership.series_id = left_series.id
            AND visible_book.library_id = ANY(${libraryIds}::int[])
        ) AS left_book_count,
        right_series.id AS right_id,
        right_series.name AS right_name,
        (
          SELECT count(DISTINCT visible_book.id)::int
          FROM book_series_memberships membership
          INNER JOIN books visible_book ON visible_book.id = membership.book_id
          WHERE membership.series_id = right_series.id
            AND visible_book.library_id = ANY(${libraryIds}::int[])
        ) AS right_book_count,
        similarity(lower(left_series.name), lower(right_series.name))::real AS similarity
      FROM book_series left_series
      INNER JOIN book_series right_series ON right_series.id > left_series.id
      WHERE (
        similarity(lower(left_series.name), lower(right_series.name)) >= 0.3
        OR regexp_replace(lower(left_series.name), '^(the\\s+)', '') =
           regexp_replace(lower(right_series.name), '^(the\\s+)', '')
        OR regexp_replace(lower(left_series.name), '\\s+(universe|world|saga), '') =
           regexp_replace(lower(right_series.name), '\\s+(universe|world|saga), '')
      )
      AND EXISTS (
        SELECT 1 FROM book_series_memberships membership
        INNER JOIN books visible_book ON visible_book.id = membership.book_id
        WHERE membership.series_id = left_series.id
          AND visible_book.library_id = ANY(${libraryIds}::int[])
      )
      AND EXISTS (
        SELECT 1 FROM book_series_memberships membership
        INNER JOIN books visible_book ON visible_book.id = membership.book_id
        WHERE membership.series_id = right_series.id
          AND visible_book.library_id = ANY(${libraryIds}::int[])
      )
      ORDER BY similarity DESC, left_series.name, right_series.name
      LIMIT 501
    `);

    const rows = result.rows as Array<{
      left_id: number;
      left_name: string;
      left_book_count: number;
      right_id: number;
      right_name: string;
      right_book_count: number;
      similarity: number;
    }>;
    return {
      items: rows.slice(0, 500).map((row) => ({
        left: { id: row.left_id, name: row.left_name, bookCount: row.left_book_count },
        right: { id: row.right_id, name: row.right_name, bookCount: row.right_book_count },
        similarity: Number(row.similarity),
      })),
      truncated: rows.length > 500,
    };
  }
}
