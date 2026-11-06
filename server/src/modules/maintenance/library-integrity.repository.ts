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

  async findBookFolderPaths(libraryIds: number[]): Promise<string[]> {
    if (libraryIds.length === 0) return [];
    const rows = await this.db.select({ folderPath: books.folderPath }).from(books).where(inArray(books.libraryId, libraryIds));
    return [...new Set(rows.map((row) => row.folderPath))];
  }

  async findExistingBookIds(bookIds: number[]): Promise<number[]> {
    if (bookIds.length === 0) return [];
    const rows = await this.db.select({ id: books.id }).from(books).where(inArray(books.id, bookIds));
    return rows.map((row) => row.id);
  }

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

    // Series are global records, while library access is user-scoped. Keep both counts so
    // the UI can explain when a merge would also affect books outside the user's libraries.
    const result = await this.db.execute(sql`
      WITH series_scope AS (
        SELECT
          membership.series_id,
          count(DISTINCT visible_book.id)::int AS total_book_count,
          count(DISTINCT visible_book.id) FILTER (
            WHERE visible_book.library_id = ANY(${libraryIds}::int[])
          )::int AS accessible_book_count
        FROM book_series_memberships membership
        INNER JOIN books visible_book ON visible_book.id = membership.book_id
        GROUP BY membership.series_id
      ),
      normalized_series AS (
        SELECT
          series.id,
          series.name,
          lower(public.bookorbit_unaccent(btrim(series.name))) AS normalized_name,
          regexp_replace(lower(public.bookorbit_unaccent(btrim(series.name))), '^the\\s+', '') AS article_free_name,
          regexp_replace(lower(public.bookorbit_unaccent(btrim(series.name))), '\\s+(universe|world|saga)$', '') AS suffix_free_name,
          scope.total_book_count,
          scope.accessible_book_count
        FROM book_series series
        INNER JOIN series_scope scope ON scope.series_id = series.id
        WHERE scope.accessible_book_count > 0
      )
      SELECT
        left_series.id AS left_id,
        left_series.name AS left_name,
        left_series.accessible_book_count AS left_book_count,
        left_series.total_book_count AS left_total_book_count,
        right_series.id AS right_id,
        right_series.name AS right_name,
        right_series.accessible_book_count AS right_book_count,
        right_series.total_book_count AS right_total_book_count,
        GREATEST(
          similarity(left_series.normalized_name, right_series.normalized_name),
          similarity(left_series.article_free_name, right_series.article_free_name),
          similarity(left_series.suffix_free_name, right_series.suffix_free_name)
        )::real AS similarity
      FROM normalized_series left_series
      INNER JOIN normalized_series right_series ON right_series.id > left_series.id
      WHERE (
        similarity(left_series.normalized_name, right_series.normalized_name) >= 0.3
        OR left_series.article_free_name = right_series.article_free_name
        OR left_series.suffix_free_name = right_series.suffix_free_name
        OR left_series.article_free_name = right_series.suffix_free_name
        OR left_series.suffix_free_name = right_series.article_free_name
      )
      ORDER BY similarity DESC, left_series.name, right_series.name
      LIMIT 501
    `);

    const rows = result.rows as Array<{
      left_id: number;
      left_name: string;
      left_book_count: number;
      left_total_book_count: number;
      right_id: number;
      right_name: string;
      right_book_count: number;
      right_total_book_count: number;
      similarity: number;
    }>;

    return {
      items: rows.slice(0, 500).map((row) => ({
        left: {
          id: row.left_id,
          name: row.left_name,
          bookCount: row.left_book_count,
          inaccessibleBookCount: row.left_total_book_count - row.left_book_count,
        },
        right: {
          id: row.right_id,
          name: row.right_name,
          bookCount: row.right_book_count,
          inaccessibleBookCount: row.right_total_book_count - row.right_book_count,
        },
        similarity: Number(row.similarity),
        mergeAllowed: row.left_total_book_count === row.left_book_count && row.right_total_book_count === row.right_book_count,
      })),
      truncated: rows.length > 500,
    };
  }
  async mergeSeries(libraryIds: number[], targetSeriesId: number, sourceSeriesIds: number[], confirmPositionConflicts: boolean) {
    if (libraryIds.length === 0) return { status: 'not_accessible' as const };
    if (sourceSeriesIds.length === 0 || sourceSeriesIds.includes(targetSeriesId)) return { status: 'invalid_request' as const };

    return this.db.transaction(async (tx) => {
      const seriesResult = await tx.execute(sql`
        SELECT id, name, expected_book_count, expected_book_count_source
        FROM book_series
        WHERE id = ANY(${[targetSeriesId, ...sourceSeriesIds]}::int[])
        ORDER BY id FOR UPDATE
      `);
      const seriesRows = seriesResult.rows as Array<{
        id: number;
        name: string;
        expected_book_count: number | null;
        expected_book_count_source: string | null;
      }>;
      if (seriesRows.length !== sourceSeriesIds.length + 1) return { status: 'not_found' as const };
      const target = seriesRows.find((row) => row.id === targetSeriesId)!;
      const sources = sourceSeriesIds.map((id) => seriesRows.find((row) => row.id === id)!);

      const visibleTarget = await tx.execute(sql`
        SELECT 1 FROM book_series_memberships membership
        INNER JOIN books visible_book ON visible_book.id = membership.book_id
        WHERE membership.series_id = ${targetSeriesId}
          AND visible_book.library_id = ANY(${libraryIds}::int[]) LIMIT 1
      `);
      if (visibleTarget.rows.length === 0) return { status: 'not_accessible' as const };

      const hiddenRefs = await tx.execute(sql`
        SELECT count(DISTINCT visible_book.id)::int AS count
        FROM books visible_book
        LEFT JOIN book_series_memberships membership
          ON membership.book_id = visible_book.id AND membership.series_id = ANY(${sourceSeriesIds}::int[])
        LEFT JOIN book_metadata metadata ON metadata.book_id = visible_book.id
        WHERE (membership.series_id IS NOT NULL OR metadata.series_id = ANY(${sourceSeriesIds}::int[]))
          AND NOT (visible_book.library_id = ANY(${libraryIds}::int[]))
      `);
      const inaccessibleBookCount = Number((hiddenRefs.rows[0] as { count?: number } | undefined)?.count ?? 0);
      if (inaccessibleBookCount > 0) return { status: 'inaccessible_books' as const, inaccessibleBookCount };

      await tx.execute(sql`
        SELECT membership.book_id
        FROM book_series_memberships membership
        INNER JOIN books visible_book ON visible_book.id = membership.book_id
        WHERE membership.series_id = ANY(${[targetSeriesId, ...sourceSeriesIds]}::int[])
          AND visible_book.library_id = ANY(${libraryIds}::int[])
        FOR UPDATE OF membership, visible_book
      `);
      await tx.execute(sql`
        SELECT metadata.book_id
        FROM book_metadata metadata
        INNER JOIN books visible_book ON visible_book.id = metadata.book_id
        WHERE metadata.series_id = ANY(${sourceSeriesIds}::int[])
          AND visible_book.library_id = ANY(${libraryIds}::int[])
        FOR UPDATE OF metadata
      `);

      const invisibleSources = await tx.execute(sql`
        SELECT source.id
        FROM unnest(${sourceSeriesIds}::int[]) AS source(id)
        WHERE NOT EXISTS (
          SELECT 1
          FROM book_series_memberships membership
          INNER JOIN books visible_book ON visible_book.id = membership.book_id
          WHERE membership.series_id = source.id
            AND visible_book.library_id = ANY(${libraryIds}::int[])
        )
        AND NOT EXISTS (
          SELECT 1
          FROM book_metadata metadata
          INNER JOIN books visible_book ON visible_book.id = metadata.book_id
          WHERE metadata.series_id = source.id
            AND visible_book.library_id = ANY(${libraryIds}::int[])
        )
      `);
      if (invisibleSources.rows.length > 0) return { status: 'not_accessible' as const };

      const conflictsResult = await tx.execute(sql`
        WITH relevant AS (
          SELECT membership.book_id, membership.series_id, membership.series_index
          FROM book_series_memberships membership
          INNER JOIN books visible_book ON visible_book.id = membership.book_id
          WHERE membership.series_id = ANY(${[targetSeriesId, ...sourceSeriesIds]}::int[])
            AND visible_book.library_id = ANY(${libraryIds}::int[])
        )
        SELECT book_id,
          max(series_index) FILTER (WHERE series_id = ${targetSeriesId}) AS target_index,
          array_agg(DISTINCT series_index) FILTER (WHERE series_id <> ${targetSeriesId} AND series_index IS NOT NULL) AS source_indices
        FROM relevant
        GROUP BY book_id
        HAVING count(DISTINCT series_index::numeric) FILTER (WHERE series_index IS NOT NULL) > 1
      `);
      const conflicts = conflictsResult.rows as Array<{ book_id: number; target_index: string | null; source_indices: string[] }>;
      if (conflicts.length > 0 && !confirmPositionConflicts) {
        return {
          status: 'position_conflicts' as const,
          conflicts: conflicts.map((row) => ({ bookId: row.book_id, targetIndex: row.target_index, sourceIndices: row.source_indices ?? [] })),
        };
      }

      const affectedResult = await tx.execute(sql`
        SELECT DISTINCT visible_book.id AS book_id
        FROM books visible_book
        LEFT JOIN book_series_memberships membership ON membership.book_id = visible_book.id
        LEFT JOIN book_metadata metadata ON metadata.book_id = visible_book.id
        WHERE visible_book.library_id = ANY(${libraryIds}::int[])
          AND (membership.series_id = ANY(${sourceSeriesIds}::int[]) OR metadata.series_id = ANY(${sourceSeriesIds}::int[]))
      `);
      const affectedBookIds = (affectedResult.rows as Array<{ book_id: number }>).map((row) => row.book_id);
      const affectedBooks = affectedBookIds.length;

      // Existing target memberships keep their position. If there is no target membership,
      // retain one source membership (lowest display order, then series id) for that book.
      await tx.execute(sql`
        UPDATE book_series_memberships target_membership
        SET series_index = COALESCE(
          target_membership.series_index,
          (SELECT source_membership.series_index
           FROM book_series_memberships source_membership
           WHERE source_membership.book_id = target_membership.book_id
             AND source_membership.series_id = ANY(${sourceSeriesIds}::int[])
             AND source_membership.series_index IS NOT NULL
           ORDER BY source_membership.display_order, source_membership.series_id LIMIT 1)
        ), updated_at = now()
        WHERE target_membership.series_id = ${targetSeriesId}
          AND EXISTS (
            SELECT 1 FROM book_series_memberships source_membership
            WHERE source_membership.book_id = target_membership.book_id
              AND source_membership.series_id = ANY(${sourceSeriesIds}::int[])
          )
          AND EXISTS (
            SELECT 1 FROM books visible_book
            WHERE visible_book.id = target_membership.book_id
              AND visible_book.library_id = ANY(${libraryIds}::int[])
          )
      `);

      await tx.execute(sql`
        WITH ranked AS (
          SELECT membership.ctid,
            row_number() OVER (PARTITION BY membership.book_id ORDER BY membership.display_order, membership.series_id) AS position,
            bool_or(membership.series_id = ${targetSeriesId}) OVER (PARTITION BY membership.book_id) AS has_target
          FROM book_series_memberships membership
          INNER JOIN books visible_book ON visible_book.id = membership.book_id
          WHERE membership.series_id = ANY(${[targetSeriesId, ...sourceSeriesIds]}::int[])
            AND visible_book.library_id = ANY(${libraryIds}::int[])
        )
        DELETE FROM book_series_memberships membership
        USING ranked
        WHERE membership.ctid = ranked.ctid
          AND membership.series_id = ANY(${sourceSeriesIds}::int[])
          AND (ranked.has_target OR ranked.position > 1)
      `);

      await tx.execute(sql`
        UPDATE book_series_memberships membership
        SET series_id = ${targetSeriesId}, updated_at = now()
        FROM books visible_book
        WHERE membership.book_id = visible_book.id
          AND membership.series_id = ANY(${sourceSeriesIds}::int[])
          AND visible_book.library_id = ANY(${libraryIds}::int[])
      `);

      await tx.execute(sql`
        INSERT INTO book_series_memberships (book_id, series_id, series_index, display_order)
        SELECT metadata.book_id, ${targetSeriesId}, metadata.series_index, 0
        FROM book_metadata metadata
        INNER JOIN books visible_book ON visible_book.id = metadata.book_id
        WHERE metadata.series_id = ANY(${sourceSeriesIds}::int[])
          AND visible_book.library_id = ANY(${libraryIds}::int[])
          AND NOT EXISTS (
            SELECT 1 FROM book_series_memberships membership
            WHERE membership.book_id = metadata.book_id
          )
        ON CONFLICT DO NOTHING
      `);

      const sourceWithExpected = sources.find((row) => row.expected_book_count !== null);
      if (target.expected_book_count === null && sourceWithExpected) {
        await tx.execute(sql`
          UPDATE book_series
          SET expected_book_count = ${sourceWithExpected.expected_book_count},
              expected_book_count_source = ${sourceWithExpected.expected_book_count_source},
              expected_book_count_updated_at = now(), updated_at = now()
          WHERE id = ${targetSeriesId}
        `);
      }

      await tx.execute(sql`
        WITH affected AS (
          SELECT unnest(${affectedBookIds}::int[]) AS book_id
        ), primary_membership AS (
          SELECT DISTINCT ON (membership.book_id)
            membership.book_id, membership.series_id, series.name, membership.series_index
          FROM book_series_memberships membership
          INNER JOIN book_series series ON series.id = membership.series_id
          INNER JOIN affected ON affected.book_id = membership.book_id
          ORDER BY membership.book_id, membership.display_order, membership.series_id
        )
        UPDATE book_metadata metadata
        SET series_id = primary_membership.series_id,
            series_name = primary_membership.name,
            series_index = primary_membership.series_index,
            updated_at = now()
        FROM primary_membership
        WHERE metadata.book_id = primary_membership.book_id
      `);

      await tx.execute(sql`
        UPDATE books SET updated_at = now() WHERE id = ANY(${affectedBookIds}::int[])
      `);
      await tx.execute(sql`DELETE FROM book_series WHERE id = ANY(${sourceSeriesIds}::int[])`);

      return {
        status: 'merged' as const,
        target: { id: targetSeriesId, name: target.name },
        merged: sources.map((row) => ({ id: row.id, name: row.name })),
        affectedBooks,
        positionConflicts: conflicts.length,
      };
    });
  }
}
