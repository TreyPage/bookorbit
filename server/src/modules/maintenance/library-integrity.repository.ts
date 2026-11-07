import { Inject, Injectable } from '@nestjs/common';
import { and, asc, count, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { LibraryIntegrityScanStatus } from '@bookorbit/types';

import { DB } from '../../db';
import * as schema from '../../db/schema';
import { bookFiles, bookMetadata, books, libraries, libraryIntegrityScanStatus } from '../../db/schema';
type Db = NodePgDatabase<typeof schema>;

const intArray = (values: number[]) =>
  sql`ARRAY[${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )}]::int[]`;

export type DuplicateFormatFileRow = {
  id: number;
  absolutePath: string;
  sizeBytes: number | null;
  fileHash: string | null;
};

@Injectable()
export class LibraryIntegrityRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  async getLibraryIntegrityScanStatus(): Promise<LibraryIntegrityScanStatus | null> {
    const [row] = await this.db.select().from(libraryIntegrityScanStatus).where(eq(libraryIntegrityScanStatus.id, 'latest')).limit(1);
    if (!row) return null;
    return {
      status: row.status as LibraryIntegrityScanStatus['status'],
      startedAt: row.startedAt.toISOString(),
      completedAt: row.completedAt?.toISOString() ?? null,
      summary: row.summary ?? null,
      errorMessage: row.errorMessage ?? null,
    };
  }

  async saveLibraryIntegrityScanStatus(status: LibraryIntegrityScanStatus): Promise<void> {
    const values = {
      status: status.status,
      startedAt: new Date(status.startedAt),
      completedAt: status.completedAt ? new Date(status.completedAt) : null,
      summary: status.summary,
      errorMessage: status.errorMessage,
    };
    await this.db
      .insert(libraryIntegrityScanStatus)
      .values({ id: 'latest', ...values })
      .onConflictDoUpdate({ target: libraryIntegrityScanStatus.id, set: values });
  }

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

    // Numbered audiobook parts are distinct segments, not duplicate formats.
    // Compare files only when their part number (or lack of one) also matches.
    const partNumber = sql`(regexp_match(regexp_replace(${bookFiles.absolutePath}, '^.*/', ''), '(?i)(?:[-_ .]part[-_ .]?([0-9]+))'))[1]`;
    const groups = this.db
      .select({
        bookId: books.id,
        title: bookMetadata.title,
        libraryId: books.libraryId,
        libraryName: libraries.name,
        folderPath: books.folderPath,
        format: sql<string>`lower(trim(${bookFiles.format}))`.as('format'),
        partLabel: sql<string | null>`CASE WHEN ${partNumber} IS NULL THEN NULL ELSE 'Part ' || ${partNumber} END`.as('partLabel'),
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
      .groupBy(books.id, bookMetadata.title, libraries.name, sql`lower(trim(${bookFiles.format}))`, partNumber)
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
        partLabel: groups.partLabel,
        fileCount: groups.fileCount,
        files: groups.files,
      })
      .from(groups)
      .orderBy(asc(groups.libraryId), asc(groups.bookId), asc(groups.format), asc(groups.partLabel))
      .offset(offset)
      .limit(limit);

    return { items, total: countRow?.total ?? 0 };
  }

  async removeDuplicateFormatFile(
    libraryIds: number[],
    fileId: number,
    removeFile: (file: { absolutePath: string; libraryId: number }) => Promise<void>,
  ): Promise<'removed' | 'not_found' | 'not_duplicate'> {
    if (libraryIds.length === 0) return 'not_found';
    return this.db.transaction(async (tx) => {
      // Resolve the owning book first, then lock that parent row before checking the
      // duplicate count. This serializes deletes for different files on the same book,
      // so concurrent requests cannot both observe two files and remove both.
      const [candidate] = await tx
        .select({ bookId: bookFiles.bookId })
        .from(bookFiles)
        .innerJoin(books, eq(books.id, bookFiles.bookId))
        .where(
          and(
            eq(bookFiles.id, fileId),
            eq(bookFiles.role, 'content'),
            isNotNull(bookFiles.format),
            inArray(books.libraryId, libraryIds),
            eq(books.status, 'present'),
          ),
        );
      if (!candidate) return 'not_found';

      const [lockedBook] = await tx
        .select({ id: books.id })
        .from(books)
        .where(and(eq(books.id, candidate.bookId), inArray(books.libraryId, libraryIds), eq(books.status, 'present')))
        .for('update');
      if (!lockedBook) return 'not_found';

      // Re-read and lock the selected file after acquiring the book lock. It may have
      // been removed by a request that held the same book lock first.
      const [file] = await tx
        .select({
          id: bookFiles.id,
          bookId: bookFiles.bookId,
          libraryId: books.libraryId,
          absolutePath: bookFiles.absolutePath,
          format: sql<string>`lower(trim(${bookFiles.format}))`,
        })
        .from(bookFiles)
        .innerJoin(books, eq(books.id, bookFiles.bookId))
        .where(
          and(
            eq(bookFiles.id, fileId),
            eq(bookFiles.role, 'content'),
            isNotNull(bookFiles.format),
            inArray(books.libraryId, libraryIds),
            eq(books.status, 'present'),
          ),
        )
        .for('update');
      if (!file) return 'not_found';

      const selectedPartNumber = sql`(regexp_match(regexp_replace(${bookFiles.absolutePath}, '^.*/', ''), '(?i)(?:[-_ .]part[-_ .]?([0-9]+))'))[1]`;
      const [countRow] = await tx
        .select({ total: count() })
        .from(bookFiles)
        .where(
          and(
            eq(bookFiles.bookId, file.bookId),
            eq(bookFiles.role, 'content'),
            sql`lower(trim(${bookFiles.format})) = ${file.format}`,
            sql`${selectedPartNumber} IS NOT DISTINCT FROM (
              SELECT (regexp_match(regexp_replace(${file.absolutePath}, '^.*/', ''), '(?i)(?:[-_ .]part[-_ .]?([0-9]+))'))[1]
            )`,
          ),
        );
      if ((countRow?.total ?? 0) <= 1) return 'not_duplicate';

      await removeFile({ absolutePath: file.absolutePath, libraryId: file.libraryId });
      await tx.delete(bookFiles).where(eq(bookFiles.id, file.id));
      return 'removed';
    });
  }

  async findSimilarSeriesPairs(libraryIds: number[], similarityPercent = 85) {
    if (libraryIds.length === 0) return { items: [], truncated: false };

    // Series are global records, while library access is user-scoped. Keep both counts so
    // the UI can explain when a merge would also affect books outside the user's libraries.
    const result = await this.db.execute(sql`
      WITH series_scope AS (
        SELECT
          membership.series_id,
          count(DISTINCT visible_book.id)::int AS total_book_count,
          count(DISTINCT visible_book.id) FILTER (
            WHERE visible_book.library_id = ANY(${intArray(libraryIds)})
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
        WHERE scope.accessible_book_count > 0 AND series.merge_ignored = false
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
      WHERE GREATEST(
        similarity(left_series.normalized_name, right_series.normalized_name),
        similarity(left_series.article_free_name, right_series.article_free_name),
        similarity(left_series.suffix_free_name, right_series.suffix_free_name)
      ) >= ${similarityPercent / 100}
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
      ignoredSeries: (
        await this.db.execute(sql`
          SELECT series.id, series.name, count(DISTINCT visible_book.id)::int AS book_count
          FROM book_series series
          INNER JOIN book_series_memberships membership ON membership.series_id = series.id
          INNER JOIN books visible_book ON visible_book.id = membership.book_id
          WHERE series.merge_ignored = true
            AND visible_book.library_id = ANY(${intArray(libraryIds)})
          GROUP BY series.id, series.name
          ORDER BY series.name
        `)
      ).rows.map((row) => ({
        id: Number((row as { id: number }).id),
        name: String((row as { name: string }).name),
        bookCount: Number((row as { book_count: number }).book_count),
      })),
      truncated: rows.length > 500,
    };
  }

  async setSeriesMergeIgnored(libraryIds: number[], seriesId: number, ignored: boolean): Promise<boolean> {
    if (libraryIds.length === 0) return false;
    const result = await this.db.execute(sql`
      UPDATE book_series
      SET merge_ignored = ${ignored}, updated_at = now()
      WHERE id = ${seriesId}
        AND EXISTS (
          SELECT 1 FROM book_series_memberships membership
          INNER JOIN books visible_book ON visible_book.id = membership.book_id
          WHERE membership.series_id = book_series.id
            AND visible_book.library_id = ANY(${intArray(libraryIds)})
        )
      RETURNING id
    `);
    return result.rows.length > 0;
  }

  async mergeSeries(libraryIds: number[], targetSeriesId: number, sourceSeriesIds: number[], confirmPositionConflicts: boolean) {
    if (libraryIds.length === 0) return { status: 'not_accessible' as const };
    if (sourceSeriesIds.length === 0 || sourceSeriesIds.includes(targetSeriesId)) return { status: 'invalid_request' as const };

    return this.db.transaction(async (tx) => {
      const seriesResult = await tx.execute(sql`
        SELECT id, name, expected_book_count, expected_book_count_source
        FROM book_series
        WHERE id = ANY(${intArray([targetSeriesId, ...sourceSeriesIds])})
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
          AND visible_book.library_id = ANY(${intArray(libraryIds)}) LIMIT 1
      `);
      if (visibleTarget.rows.length === 0) return { status: 'not_accessible' as const };

      const hiddenRefs = await tx.execute(sql`
        SELECT count(DISTINCT visible_book.id)::int AS count
        FROM books visible_book
        LEFT JOIN book_series_memberships membership
          ON membership.book_id = visible_book.id AND membership.series_id = ANY(${intArray(sourceSeriesIds)})
        LEFT JOIN book_metadata metadata ON metadata.book_id = visible_book.id
        WHERE (membership.series_id IS NOT NULL OR metadata.series_id = ANY(${intArray(sourceSeriesIds)}))
          AND NOT (visible_book.library_id = ANY(${intArray(libraryIds)}))
      `);
      const inaccessibleBookCount = Number((hiddenRefs.rows[0] as { count?: number } | undefined)?.count ?? 0);
      if (inaccessibleBookCount > 0) return { status: 'inaccessible_books' as const, inaccessibleBookCount };

      await tx.execute(sql`
        SELECT membership.book_id
        FROM book_series_memberships membership
        INNER JOIN books visible_book ON visible_book.id = membership.book_id
        WHERE membership.series_id = ANY(${intArray([targetSeriesId, ...sourceSeriesIds])})
          AND visible_book.library_id = ANY(${intArray(libraryIds)})
        FOR UPDATE OF membership, visible_book
      `);
      await tx.execute(sql`
        SELECT metadata.book_id
        FROM book_metadata metadata
        INNER JOIN books visible_book ON visible_book.id = metadata.book_id
        WHERE metadata.series_id = ANY(${intArray(sourceSeriesIds)})
          AND visible_book.library_id = ANY(${intArray(libraryIds)})
        FOR UPDATE OF metadata
      `);

      const invisibleSources = await tx.execute(sql`
        SELECT source.id
        FROM unnest(${intArray(sourceSeriesIds)}) AS source(id)
        WHERE NOT EXISTS (
          SELECT 1
          FROM book_series_memberships membership
          INNER JOIN books visible_book ON visible_book.id = membership.book_id
          WHERE membership.series_id = source.id
            AND visible_book.library_id = ANY(${intArray(libraryIds)})
        )
        AND NOT EXISTS (
          SELECT 1
          FROM book_metadata metadata
          INNER JOIN books visible_book ON visible_book.id = metadata.book_id
          WHERE metadata.series_id = source.id
            AND visible_book.library_id = ANY(${intArray(libraryIds)})
        )
      `);
      if (invisibleSources.rows.length > 0) return { status: 'not_accessible' as const };

      const conflictsResult = await tx.execute(sql`
        WITH relevant AS (
          SELECT membership.book_id, membership.series_id, membership.series_index
          FROM book_series_memberships membership
          INNER JOIN books visible_book ON visible_book.id = membership.book_id
          WHERE membership.series_id = ANY(${intArray([targetSeriesId, ...sourceSeriesIds])})
            AND visible_book.library_id = ANY(${intArray(libraryIds)})
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
        WHERE visible_book.library_id = ANY(${intArray(libraryIds)})
          AND (membership.series_id = ANY(${intArray(sourceSeriesIds)}) OR metadata.series_id = ANY(${intArray(sourceSeriesIds)}))
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
             AND source_membership.series_id = ANY(${intArray(sourceSeriesIds)})
             AND source_membership.series_index IS NOT NULL
           ORDER BY source_membership.display_order, source_membership.series_id LIMIT 1)
        ), updated_at = now()
        WHERE target_membership.series_id = ${targetSeriesId}
          AND EXISTS (
            SELECT 1 FROM book_series_memberships source_membership
            WHERE source_membership.book_id = target_membership.book_id
              AND source_membership.series_id = ANY(${intArray(sourceSeriesIds)})
          )
          AND EXISTS (
            SELECT 1 FROM books visible_book
            WHERE visible_book.id = target_membership.book_id
              AND visible_book.library_id = ANY(${intArray(libraryIds)})
          )
      `);

      await tx.execute(sql`
        WITH ranked AS (
          SELECT membership.ctid,
            row_number() OVER (PARTITION BY membership.book_id ORDER BY membership.display_order, membership.series_id) AS position,
            bool_or(membership.series_id = ${targetSeriesId}) OVER (PARTITION BY membership.book_id) AS has_target
          FROM book_series_memberships membership
          INNER JOIN books visible_book ON visible_book.id = membership.book_id
          WHERE membership.series_id = ANY(${intArray([targetSeriesId, ...sourceSeriesIds])})
            AND visible_book.library_id = ANY(${intArray(libraryIds)})
        )
        DELETE FROM book_series_memberships membership
        USING ranked
        WHERE membership.ctid = ranked.ctid
          AND membership.series_id = ANY(${intArray(sourceSeriesIds)})
          AND (ranked.has_target OR ranked.position > 1)
      `);

      await tx.execute(sql`
        UPDATE book_series_memberships membership
        SET series_id = ${targetSeriesId}, updated_at = now()
        FROM books visible_book
        WHERE membership.book_id = visible_book.id
          AND membership.series_id = ANY(${intArray(sourceSeriesIds)})
          AND visible_book.library_id = ANY(${intArray(libraryIds)})
      `);

      await tx.execute(sql`
        INSERT INTO book_series_memberships (book_id, series_id, series_index, display_order)
        SELECT metadata.book_id, ${targetSeriesId}, metadata.series_index, 0
        FROM book_metadata metadata
        INNER JOIN books visible_book ON visible_book.id = metadata.book_id
        WHERE metadata.series_id = ANY(${intArray(sourceSeriesIds)})
          AND visible_book.library_id = ANY(${intArray(libraryIds)})
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
          SELECT unnest(${intArray(affectedBookIds)}) AS book_id
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
        UPDATE books SET updated_at = now() WHERE id = ANY(${intArray(affectedBookIds)})
      `);
      await tx.execute(sql`DELETE FROM book_series WHERE id = ANY(${intArray(sourceSeriesIds)})`);

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
