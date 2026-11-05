import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { BookMergeCandidateBook, BookMergeCandidateCursor, BookMergeCandidatePair } from '@bookorbit/types';

import { buildContentFilterClauses } from '../../common/utils/content-filter-sql.utils';
import type { RequestUser } from '../../common/types/request-user';
import { DB } from '../../db';
import * as schema from '../../db/schema';
import { bookFiles, bookMergeSources, bookMetadata, books, libraries } from '../../db/schema';

type Db = NodePgDatabase<typeof schema>;
type DbTransaction = Parameters<Parameters<Db['transaction']>[0]>[0];
type CandidateIdRow = { book_id_a: number; book_id_b: number; title_similarity: number };
type CandidateBookRow = Record<string, unknown> & BookMergeCandidateBook & { id: number };

const PAGE_SIZE = 25;

const USER_KEY_TABLES = [
  'audiobook_progress',
  'user_book_status',
  'user_book_ratings',
  'user_book_notes',
  'kobo_reading_states',
  'kobo_book_entitlements',
  'hardcover_book_state',
  'storygraph_book_state',
  'user_book_read_aloud_sync_settings',
  'tts_book_preferences',
] as const;

const DEDUPLICATED_TABLES = [
  ['book_authors', 'author_id'],
  ['book_genres', 'genre_id'],
  ['book_tags', 'tag_id'],
  ['book_narrators', 'narrator_id'],
  ['collection_books', 'collection_id'],
  ['book_community_ratings', 'provider'],
  ['book_custom_metadata_values', 'field_id'],
  ['book_covers', 'medium'],
  ['book_provider_ids', 'provider'],
  ['audiobook_manifest_revisions', 'revision'],
  ['kobo_snapshot_books', 'snapshot_id'],
  ['kobo_device_snapshot_books', 'snapshot_id'],
] as const;

const METADATA_COLUMNS = [
  'title',
  'subtitle',
  'description',
  'isbn10',
  'isbn13',
  'publisher',
  'published_date',
  'published_year',
  'language',
  'page_count',
  'series_id',
  'series_name',
  'series_index',
  'rating',
  'cover_source',
  'google_books_id',
  'goodreads_id',
  'amazon_id',
  'hardcover_id',
  'hardcover_edition_id',
  'open_library_id',
  'itunes_id',
  'kobo_id',
  'metadata_score',
  'last_metadata_fetch_at',
  'embedding',
  'last_written_at',
  'duration_seconds',
  'abridged',
  'audible_id',
  'librofm_id',
  'comicvine_id',
  'ranobedb_id',
  'lubimyczytac_id',
  'aladin_id',
  'chapters',
  'chapters_source',
  'chapters_updated_at',
  'chapters_updated_by',
  'manifest_legacy_recorded',
  'locked_fields',
  'cover_updated_at',
] as const;

const COMIC_METADATA_COLUMNS = [
  'issue_number',
  'volume_name',
  'pencillers',
  'inkers',
  'colorists',
  'letterers',
  'cover_artists',
  'characters',
  'teams',
  'locations',
  'story_arcs',
] as const;

function sqlIdList(ids: number[]) {
  return sql`(${sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  )})`;
}

@Injectable()
export class BookMergeRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  async findCandidates(
    libraryIds: number[],
    user: RequestUser,
    similarityPercent: number,
    cursor: BookMergeCandidateCursor | null,
  ): Promise<{ candidates: BookMergeCandidatePair[]; nextCursor: BookMergeCandidateCursor | null }> {
    if (libraryIds.length === 0) return { candidates: [], nextCursor: null };
    const scope = and(
      inArray(books.libraryId, libraryIds),
      ne(books.status, 'processing'),
      ...(user.isSuperuser ? [] : buildContentFilterClauses(user.contentFilters, this.db)),
    )!;
    const cursorClause = cursor ? sql`(a.id > ${cursor.bookIdA} OR (a.id = ${cursor.bookIdA} AND b.id > ${cursor.bookIdB}))` : sql`true`;
    const limit = PAGE_SIZE + 1;
    const pairs = await this.db.execute<CandidateIdRow>(sql`
      WITH eligible AS NOT MATERIALIZED (
        SELECT
          ${books.id} AS id,
          ${books.libraryId} AS library_id,
          ${bookMetadata.title} AS title,
          COALESCE(family.has_ebook, false) AS has_ebook,
          COALESCE(family.has_audiobook, false) AS has_audiobook
        FROM ${books}
        JOIN ${bookMetadata} ON ${bookMetadata.bookId} = ${books.id}
        LEFT JOIN LATERAL (
          SELECT
            bool_or(lower(${bookFiles.format}) IN ('epub', 'pdf', 'djvu', 'mobi', 'azw', 'azw3', 'fb2', 'kepub')) AS has_ebook,
            bool_or(lower(${bookFiles.format}) IN ('m4b', 'mp3', 'm4a', 'opus', 'ogg', 'flac')) AS has_audiobook
          FROM ${bookFiles}
          WHERE ${bookFiles.bookId} = ${books.id} AND ${bookFiles.role} = 'content'
        ) family ON true
        WHERE ${scope}
          AND ${bookMetadata.title} IS NOT NULL
          AND btrim(${bookMetadata.title}) <> ''
      ),
      matches AS (
        SELECT
          a.id AS book_id_a,
          b.id AS book_id_b,
          max(similarity(
            lower(btrim(regexp_replace(regexp_replace(public.bookorbit_unaccent(a.title), '[^[:alnum:]]+', ' ', 'g'), '[[:space:]]+', ' ', 'g'))),
            lower(btrim(regexp_replace(regexp_replace(public.bookorbit_unaccent(b.title), '[^[:alnum:]]+', ' ', 'g'), '[[:space:]]+', ' ', 'g')))
          )) AS title_similarity
        FROM eligible a
        JOIN eligible b
          ON a.id < b.id
          AND a.library_id = b.library_id
          AND public.bookorbit_unaccent(a.title) % public.bookorbit_unaccent(b.title)
        JOIN book_authors author_link_a ON author_link_a.book_id = a.id
        JOIN authors author_a ON author_a.id = author_link_a.author_id
        JOIN book_authors author_link_b ON author_link_b.book_id = b.id
        JOIN authors author_b ON author_b.id = author_link_b.author_id
          AND lower(btrim(regexp_replace(regexp_replace(public.bookorbit_unaccent(author_a.name), '[^[:alnum:]]+', ' ', 'g'), '[[:space:]]+', ' ', 'g')))
            = lower(btrim(regexp_replace(regexp_replace(public.bookorbit_unaccent(author_b.name), '[^[:alnum:]]+', ' ', 'g'), '[[:space:]]+', ' ', 'g')))
        WHERE ${cursorClause}
          AND similarity(
            lower(btrim(regexp_replace(regexp_replace(public.bookorbit_unaccent(a.title), '[^[:alnum:]]+', ' ', 'g'), '[[:space:]]+', ' ', 'g'))),
            lower(btrim(regexp_replace(regexp_replace(public.bookorbit_unaccent(b.title), '[^[:alnum:]]+', ' ', 'g'), '[[:space:]]+', ' ', 'g')))
          ) >= ${similarityPercent / 100}
        GROUP BY a.id, b.id
      )
      SELECT book_id_a, book_id_b, title_similarity
      FROM matches
      ORDER BY book_id_a, book_id_b
      LIMIT ${limit}
    `);
    const hasMore = pairs.rows.length > PAGE_SIZE;
    const visiblePairs = pairs.rows.slice(0, PAGE_SIZE);
    if (visiblePairs.length === 0) return { candidates: [], nextCursor: null };

    const bookIds = [...new Set(visiblePairs.flatMap((pair) => [pair.book_id_a, pair.book_id_b]))];
    const previews = await this.findCandidateBooks(bookIds);
    const previewById = new Map(previews.map((book) => [book.id, book]));
    const candidates = visiblePairs.flatMap((pair) => {
      const bookA = previewById.get(pair.book_id_a);
      const bookB = previewById.get(pair.book_id_b);
      return bookA && bookB
        ? [
            {
              bookIdA: pair.book_id_a,
              bookIdB: pair.book_id_b,
              titleSimilarity: Number(pair.title_similarity),
              books: [bookA, bookB] as [CandidateBookRow, CandidateBookRow],
            },
          ]
        : [];
    });
    const last = visiblePairs.at(-1)!;
    return {
      candidates,
      nextCursor: hasMore ? { bookIdA: last.book_id_a, bookIdB: last.book_id_b } : null,
    };
  }

  async findAccessibleBookIds(bookIds: number[], libraryIds: number[], user: RequestUser): Promise<number[]> {
    if (bookIds.length === 0 || libraryIds.length === 0) return [];
    const where = and(
      inArray(books.id, bookIds),
      inArray(books.libraryId, libraryIds),
      ne(books.status, 'processing'),
      ...(user.isSuperuser ? [] : buildContentFilterClauses(user.contentFilters, this.db)),
    )!;
    const rows = await this.db.select({ id: books.id }).from(books).where(where);
    return rows.map((row) => row.id);
  }

  private async findCandidateBooks(bookIds: number[]): Promise<CandidateBookRow[]> {
    const ids = sqlIdList(bookIds);
    const rows = await this.db.execute<CandidateBookRow>(sql`
      SELECT
        ${books.id} AS id,
        ${bookMetadata.title} AS title,
        COALESCE((
          SELECT array_agg(author.name ORDER BY link.display_order, author.id)
          FROM book_authors link
          JOIN authors author ON author.id = link.author_id
          WHERE link.book_id = ${books.id}
        ), ARRAY[]::varchar[]) AS authors,
        COALESCE((
          SELECT array_agg(DISTINCT file.format ORDER BY file.format)
          FROM book_files file
          WHERE file.book_id = ${books.id} AND file.role = 'content' AND file.format IS NOT NULL
        ), ARRAY[]::varchar[]) AS formats,
        ${books.folderPath} AS "folderPath",
        ${libraries.name} AS "libraryName"
      FROM ${books}
      JOIN ${bookMetadata} ON ${bookMetadata.bookId} = ${books.id}
      JOIN ${libraries} ON ${libraries.id} = ${books.libraryId}
      WHERE ${books.id} IN ${ids}
    `);
    return rows.rows;
  }

  async mergeBooks(sourceBookIds: number[], targetBookId: number): Promise<number> {
    const uniqueSourceIds = [...new Set(sourceBookIds)].filter((id) => id !== targetBookId);
    if (uniqueSourceIds.length === 0) throw new NotFoundException('At least one source book is required');
    const allIds = [...uniqueSourceIds, targetBookId];

    await this.db.transaction(async (tx) => {
      const rows = await tx
        .select({
          id: books.id,
          libraryId: books.libraryId,
          libraryFolderId: books.libraryFolderId,
          folderPath: books.folderPath,
          status: books.status,
          primaryFileId: books.primaryFileId,
        })
        .from(books)
        .where(inArray(books.id, allIds))
        .for('update');
      if (rows.length !== allIds.length || new Set(rows.map((row) => row.libraryId)).size !== 1) {
        throw new NotFoundException('Books were not found in the same library');
      }

      const activeReadAloudJobs = await tx.execute(sql`
        SELECT book_id
        FROM read_aloud_jobs
        WHERE book_id IN ${sqlIdList(allIds)}
          AND status IN ('queued', 'processing', 'awaiting_review')
      `);
      if (new Set(activeReadAloudJobs.rows.map((row) => Number(row.book_id))).size > 1) {
        throw new ConflictException('Cancel or complete active read-aloud jobs before merging these books');
      }

      await tx.update(bookMergeSources).set({ targetBookId }).where(inArray(bookMergeSources.targetBookId, uniqueSourceIds));
      await tx
        .insert(bookMergeSources)
        .values(
          rows
            .filter((row) => row.id !== targetBookId)
            .map((row) => ({ libraryFolderId: row.libraryFolderId, folderPath: row.folderPath, targetBookId })),
        )
        .onConflictDoUpdate({
          target: [bookMergeSources.libraryFolderId, bookMergeSources.folderPath],
          set: { targetBookId },
        });

      await this.reconcileDependents(tx, uniqueSourceIds, targetBookId);
      await tx.update(bookFiles).set({ bookId: targetBookId, updatedAt: new Date() }).where(inArray(bookFiles.bookId, uniqueSourceIds));
      const target = rows.find((row) => row.id === targetBookId)!;
      const sourcePresent = rows.some((row) => row.id !== targetBookId && row.status === 'present');
      const sourceWithPrimaryFile = rows.find((row) => row.id !== targetBookId && row.status === 'present' && row.primaryFileId !== null);
      if ((target.status === 'missing' && sourcePresent) || (target.primaryFileId === null && sourceWithPrimaryFile)) {
        await tx
          .update(books)
          .set({
            status: target.status === 'missing' && sourcePresent ? 'present' : target.status,
            ...(sourceWithPrimaryFile?.primaryFileId ? { primaryFileId: sourceWithPrimaryFile.primaryFileId } : {}),
            updatedAt: new Date(),
          })
          .where(eq(books.id, targetBookId));
      }
      await tx.delete(books).where(inArray(books.id, uniqueSourceIds));
    });
    return uniqueSourceIds.length;
  }

  private async reconcileDependents(tx: DbTransaction, sourceIds: number[], targetId: number): Promise<void> {
    const allIds = [...sourceIds, targetId];
    const idList = sqlIdList(allIds);
    for (const [table, key] of DEDUPLICATED_TABLES) {
      const tableSql = sql.raw(table);
      const keySql = sql.raw(key);
      await tx.execute(sql`
        DELETE FROM ${tableSql}
        WHERE ctid IN (
          SELECT ctid FROM (
            SELECT ctid, row_number() OVER (
              PARTITION BY ${keySql}
              ORDER BY CASE WHEN book_id = ${targetId} THEN 0 ELSE 1 END, book_id, ctid
            ) AS row_number
            FROM ${tableSql}
            WHERE book_id IN ${idList}
          ) duplicates WHERE row_number > 1
        )
      `);
      await tx.execute(sql`UPDATE ${tableSql} SET book_id = ${targetId} WHERE book_id IN ${sqlIdList(sourceIds)}`);
    }

    await tx.execute(sql`
      DELETE FROM book_series_memberships
      WHERE ctid IN (
        SELECT ctid FROM (
          SELECT ctid, row_number() OVER (
            PARTITION BY series_id
            ORDER BY CASE WHEN book_id = ${targetId} THEN 0 ELSE 1 END, book_id, ctid
          ) AS row_number
          FROM book_series_memberships WHERE book_id IN ${idList}
        ) duplicates WHERE row_number > 1
      )
    `);
    await tx.execute(sql`
      WITH source_memberships AS (
        SELECT ctid, row_number() OVER (ORDER BY display_order, series_id) AS row_number
        FROM book_series_memberships WHERE book_id IN ${sqlIdList(sourceIds)}
      ), target_order AS (
        SELECT COALESCE(max(display_order), -1) AS max_order
        FROM book_series_memberships WHERE book_id = ${targetId}
      )
      UPDATE book_series_memberships membership
      SET book_id = ${targetId}, display_order = target_order.max_order + source_memberships.row_number
      FROM source_memberships, target_order
      WHERE membership.ctid = source_memberships.ctid
    `);

    for (const table of USER_KEY_TABLES) {
      const tableSql = sql.raw(table);
      await tx.execute(sql`
        DELETE FROM ${tableSql}
        WHERE ctid IN (
          SELECT ctid FROM (
            SELECT ctid, row_number() OVER (
              PARTITION BY user_id
              ORDER BY updated_at DESC, CASE WHEN book_id = ${targetId} THEN 0 ELSE 1 END, book_id
            ) AS row_number
            FROM ${tableSql} WHERE book_id IN ${idList}
          ) duplicates WHERE row_number > 1
        )
      `);
      await tx.execute(sql`UPDATE ${tableSql} SET book_id = ${targetId} WHERE book_id IN ${sqlIdList(sourceIds)}`);
    }

    for (const table of ['annotations', 'kobo_bookmark_links', 'email_send_log', 'file_write_log'] as const) {
      await tx.execute(sql`UPDATE ${sql.raw(table)} SET book_id = ${targetId} WHERE book_id IN ${sqlIdList(sourceIds)}`);
    }
    await tx.execute(sql`UPDATE book_requests SET matched_book_id = ${targetId} WHERE matched_book_id IN ${sqlIdList(sourceIds)}`);

    await this.mergeReadingAttempts(tx, sourceIds, targetId, idList);
    await this.mergeReadingSessions(tx, sourceIds, targetId, idList);
    await this.mergeBookmarks(tx, sourceIds, targetId, idList);
    await this.mergeReadingSessionCursors(tx, sourceIds, targetId, idList);
    await this.mergeChapterLookupQueue(tx, sourceIds, targetId, idList);
    await tx.execute(sql`
      DELETE FROM book_chapter_jobs
      WHERE ctid IN (
        SELECT ctid FROM (
          SELECT ctid, row_number() OVER (
            PARTITION BY user_id, kind, base_revision
            ORDER BY updated_at DESC, CASE WHEN book_id = ${targetId} THEN 0 ELSE 1 END, id
          ) AS row_number
          FROM book_chapter_jobs WHERE book_id IN ${idList}
        ) duplicates WHERE row_number > 1
      )
    `);
    await tx.execute(sql`UPDATE book_chapter_jobs SET book_id = ${targetId} WHERE book_id IN ${sqlIdList(sourceIds)}`);
    await this.mergeOneToOneMetadata(tx, 'book_metadata', METADATA_COLUMNS, sourceIds, targetId);
    await this.mergeOneToOneMetadata(tx, 'comic_metadata', COMIC_METADATA_COLUMNS, sourceIds, targetId);
    await tx.execute(sql`UPDATE book_chapter_versions SET book_id = ${targetId} WHERE book_id IN ${sqlIdList(sourceIds)}`);
    await tx.execute(sql`UPDATE read_aloud_jobs SET book_id = ${targetId} WHERE book_id IN ${sqlIdList(sourceIds)}`);

    await tx.execute(sql`DELETE FROM book_duplicate_pairs WHERE book_id_a IN ${sqlIdList(sourceIds)} OR book_id_b IN ${sqlIdList(sourceIds)}`);
    await tx.execute(sql`DELETE FROM book_duplicate_scan_keys WHERE book_id IN ${sqlIdList(sourceIds)}`);
    await tx.execute(sql`DELETE FROM book_duplicate_groups WHERE root_book_id IN ${sqlIdList(sourceIds)}`);
    await tx.execute(sql`UPDATE book_requests SET target_book_id = ${targetId} WHERE target_book_id IN ${sqlIdList(sourceIds)}`);
    await tx.execute(sql`
      UPDATE upload_sessions
      SET target_book_id = CASE WHEN target_book_id IN ${sqlIdList(sourceIds)} THEN ${targetId} ELSE target_book_id END,
          result_book_id = CASE WHEN result_book_id IN ${sqlIdList(sourceIds)} THEN ${targetId} ELSE result_book_id END
      WHERE target_book_id IN ${sqlIdList(sourceIds)} OR result_book_id IN ${sqlIdList(sourceIds)}
    `);
    await tx.execute(sql`
      DELETE FROM book_journal_entries
      WHERE ctid IN (
        SELECT ctid FROM (
          SELECT ctid, row_number() OVER (
            PARTITION BY user_id, client_id
            ORDER BY CASE WHEN book_id = ${targetId} THEN 0 ELSE 1 END, updated_at DESC, id
          ) AS row_number
          FROM book_journal_entries WHERE book_id IN ${idList}
        ) duplicates WHERE row_number > 1
      )
    `);
    await tx.execute(sql`UPDATE book_journal_entries SET book_id = ${targetId} WHERE book_id IN ${sqlIdList(sourceIds)}`);
    await this.mergeKoboState(tx, sourceIds, targetId, idList);
    await this.mergeKoboDeliveries(tx, sourceIds, targetId, idList);
    await this.mergeKoboAnnotationServes(tx, sourceIds, targetId, idList);
    await tx.execute(sql`
      DELETE FROM book_metadata_fetch_queue
      WHERE ctid IN (
        SELECT ctid FROM (
          SELECT ctid, row_number() OVER (
            ORDER BY CASE WHEN book_id = ${targetId} THEN 0 ELSE 1 END, updated_at DESC, book_id
          ) AS row_number
          FROM book_metadata_fetch_queue WHERE book_id IN ${idList}
        ) duplicates WHERE row_number > 1
      )
    `);
    await tx.execute(sql`UPDATE book_metadata_fetch_queue SET book_id = ${targetId} WHERE book_id IN ${sqlIdList(sourceIds)}`);
  }

  private async mergeKoboState(tx: DbTransaction, sourceIds: number[], targetId: number, allIds: ReturnType<typeof sqlIdList>): Promise<void> {
    for (const [table, timeColumn] of [
      ['kobo_device_reading_states', 'updated_at'],
      ['kobo_known_positions', 'updated_at'],
    ] as const) {
      const tableSql = sql.raw(table);
      const timeColumnSql = sql.raw(timeColumn);
      await tx.execute(sql`
        DELETE FROM ${tableSql}
        WHERE ctid IN (
          SELECT ctid FROM (
            SELECT ctid, row_number() OVER (
              PARTITION BY user_id, device_id
              ORDER BY CASE WHEN book_id = ${targetId} THEN 0 ELSE 1 END, ${timeColumnSql} DESC, book_id
            ) AS row_number
            FROM ${tableSql} WHERE book_id IN ${allIds}
          ) duplicates WHERE row_number > 1
        )
      `);
      await tx.execute(sql`UPDATE ${tableSql} SET book_id = ${targetId} WHERE book_id IN ${sqlIdList(sourceIds)}`);
    }
  }

  private async mergeKoboDeliveries(tx: DbTransaction, sourceIds: number[], targetId: number, allIds: ReturnType<typeof sqlIdList>): Promise<void> {
    await tx.execute(sql`
      DELETE FROM kobo_device_deliveries
      WHERE ctid IN (
        SELECT ctid FROM (
          SELECT ctid, row_number() OVER (
            PARTITION BY user_id, device_id
            ORDER BY CASE WHEN book_id = ${targetId} THEN 0 ELSE 1 END, updated_at DESC, id
          ) AS row_number
          FROM kobo_device_deliveries
          WHERE book_id IN ${allIds} AND current = true
        ) duplicates WHERE row_number > 1
      )
    `);
    await tx.execute(sql`UPDATE kobo_device_deliveries SET book_id = ${targetId} WHERE book_id IN ${sqlIdList(sourceIds)}`);
  }

  private async mergeKoboAnnotationServes(
    tx: DbTransaction,
    sourceIds: number[],
    targetId: number,
    allIds: ReturnType<typeof sqlIdList>,
  ): Promise<void> {
    await tx.execute(sql`
      DELETE FROM kobo_annotation_serves
      WHERE ctid IN (
        SELECT ctid FROM (
          SELECT ctid, row_number() OVER (
            PARTITION BY user_id, device_id
            ORDER BY CASE WHEN book_id = ${targetId} THEN 0 ELSE 1 END, served_at DESC, id
          ) AS row_number
          FROM kobo_annotation_serves WHERE book_id IN ${allIds}
        ) duplicates WHERE row_number > 1
      )
    `);
    await tx.execute(sql`UPDATE kobo_annotation_serves SET book_id = ${targetId} WHERE book_id IN ${sqlIdList(sourceIds)}`);
  }

  private async mergeReadingSessions(tx: DbTransaction, sourceIds: number[], targetId: number, allIds: ReturnType<typeof sqlIdList>): Promise<void> {
    await tx.execute(sql`
      DELETE FROM reading_sessions
      WHERE ctid IN (
        SELECT ctid FROM (
          SELECT ctid, row_number() OVER (
            PARTITION BY user_id, session_id
            ORDER BY CASE WHEN book_id = ${targetId} THEN 0 ELSE 1 END, ended_at DESC, id
          ) AS row_number
          FROM reading_sessions WHERE book_id IN ${allIds}
        ) duplicates WHERE row_number > 1
      )
    `);
    await tx.execute(sql`UPDATE reading_sessions SET book_id = ${targetId} WHERE book_id IN ${sqlIdList(sourceIds)}`);
  }

  private async mergeBookmarks(tx: DbTransaction, sourceIds: number[], targetId: number, allIds: ReturnType<typeof sqlIdList>): Promise<void> {
    const uniquenessRules = [
      { partition: sql`user_id, client_id`, condition: sql`true` },
      { partition: sql`user_id, cfi`, condition: sql`cfi IS NOT NULL` },
      {
        partition: sql`user_id, position_seconds`,
        condition: sql`cfi IS NULL AND position_seconds IS NOT NULL AND deleted_at IS NULL`,
      },
    ] as const;
    for (const rule of uniquenessRules) {
      await tx.execute(sql`
        DELETE FROM bookmarks
        WHERE ctid IN (
          SELECT ctid FROM (
            SELECT ctid, row_number() OVER (
              PARTITION BY ${rule.partition}
              ORDER BY CASE WHEN book_id = ${targetId} THEN 0 ELSE 1 END, updated_at DESC, id
            ) AS row_number
            FROM bookmarks WHERE book_id IN ${allIds} AND ${rule.condition}
          ) duplicates WHERE row_number > 1
        )
      `);
    }
    await tx.execute(sql`UPDATE bookmarks SET book_id = ${targetId} WHERE book_id IN ${sqlIdList(sourceIds)}`);
  }

  private async mergeReadingSessionCursors(
    tx: DbTransaction,
    sourceIds: number[],
    targetId: number,
    allIds: ReturnType<typeof sqlIdList>,
  ): Promise<void> {
    await tx.execute(sql`
      DELETE FROM reading_session_sync_cursors
      WHERE ctid IN (
        SELECT ctid FROM (
          SELECT ctid, row_number() OVER (
            PARTITION BY user_id, source, source_device_key
            ORDER BY CASE WHEN book_id = ${targetId} THEN 0 ELSE 1 END, last_modified DESC, book_id
          ) AS row_number
          FROM reading_session_sync_cursors WHERE book_id IN ${allIds}
        ) duplicates WHERE row_number > 1
      )
    `);
    await tx.execute(sql`UPDATE reading_session_sync_cursors SET book_id = ${targetId} WHERE book_id IN ${sqlIdList(sourceIds)}`);
  }

  private async mergeChapterLookupQueue(
    tx: DbTransaction,
    sourceIds: number[],
    targetId: number,
    allIds: ReturnType<typeof sqlIdList>,
  ): Promise<void> {
    await tx.execute(sql`
      DELETE FROM chapter_lookup_queue
      WHERE ctid IN (
        SELECT ctid FROM (
          SELECT ctid, row_number() OVER (
            ORDER BY CASE WHEN book_id = ${targetId} THEN 0 ELSE 1 END, updated_at DESC, book_id
          ) AS row_number
          FROM chapter_lookup_queue WHERE book_id IN ${allIds}
        ) duplicates WHERE row_number > 1
      )
    `);
    await tx.execute(sql`UPDATE chapter_lookup_queue SET book_id = ${targetId} WHERE book_id IN ${sqlIdList(sourceIds)}`);
  }

  private async mergeReadingAttempts(tx: DbTransaction, sourceIds: number[], targetId: number, allIds: ReturnType<typeof sqlIdList>): Promise<void> {
    const result = await tx.execute(sql`
      SELECT id, user_id, book_id, outcome, deleted_at, external_provider, external_id
      FROM reading_attempts WHERE book_id IN ${allIds}
    `);
    const attempts = result.rows as {
      id: number;
      user_id: number;
      book_id: number;
      outcome: string | null;
      deleted_at: Date | null;
      external_provider: string | null;
      external_id: string | null;
    }[];
    await tx.execute(sql`
      UPDATE reading_sessions SET book_id = ${targetId}
      WHERE attempt_id IN (SELECT id FROM reading_attempts WHERE book_id IN ${sqlIdList(sourceIds)})
    `);

    const survivors = new Map<number, number>();
    const attemptsByUser = new Map<number, typeof attempts>();
    for (const attempt of attempts) {
      const current = attemptsByUser.get(attempt.user_id) ?? [];
      current.push(attempt);
      attemptsByUser.set(attempt.user_id, current);
    }
    for (const userAttempts of attemptsByUser.values()) {
      const duplicatePairs = new Map<number, number>();
      const active = userAttempts.filter((attempt) => attempt.outcome === null && attempt.deleted_at === null);
      if (active.length > 1) {
        const keep = active.find((attempt) => attempt.book_id === targetId) ?? active[0]!;
        for (const attempt of active) if (attempt.id !== keep.id) duplicatePairs.set(attempt.id, keep.id);
      }
      for (const attempt of userAttempts) {
        if (attempt.external_provider == null || attempt.external_id == null) continue;
        const match = userAttempts.find(
          (other) => other.id !== attempt.id && other.external_provider === attempt.external_provider && other.external_id === attempt.external_id,
        );
        if (match) {
          const keep = match.book_id === targetId ? match : attempt.book_id === targetId ? attempt : match.id < attempt.id ? match : attempt;
          duplicatePairs.set(keep.id === attempt.id ? match.id : attempt.id, keep.id);
        }
      }
      for (const [duplicateId, keepId] of duplicatePairs) survivors.set(duplicateId, keepId);
    }
    for (const [duplicateId, keepId] of survivors) {
      await tx.execute(sql`UPDATE reading_sessions SET attempt_id = ${keepId} WHERE attempt_id = ${duplicateId}`);
    }
    if (survivors.size > 0) await tx.delete(schema.readingAttempts).where(inArray(schema.readingAttempts.id, [...survivors.keys()]));
    await tx.execute(
      sql`UPDATE reading_attempts SET book_id = ${targetId} WHERE book_id IN ${sqlIdList(sourceIds)} AND id NOT IN ${sqlIdList([...survivors.keys(), 0])}`,
    );
  }

  private async mergeOneToOneMetadata(
    tx: DbTransaction,
    table: 'book_metadata' | 'comic_metadata',
    columns: readonly string[],
    sourceIds: number[],
    targetId: number,
  ): Promise<void> {
    const tableSql = sql.raw(table);
    const sourceList = sqlIdList(sourceIds);
    const first = await tx.execute(sql`SELECT book_id FROM ${tableSql} WHERE book_id IN ${sourceList} ORDER BY updated_at DESC LIMIT 1`);
    const sourceBookId = first.rows[0]?.book_id;
    const target = await tx.execute(sql`SELECT book_id FROM ${tableSql} WHERE book_id = ${targetId} LIMIT 1`);
    if (!target.rows[0] && sourceBookId !== undefined) {
      await tx.execute(sql`UPDATE ${tableSql} SET book_id = ${targetId} WHERE book_id = ${Number(sourceBookId)}`);
    }

    for (const sourceId of sourceIds) {
      const updates = sql.join(
        columns.map((column) => {
          const field = sql.raw(column);
          if (column === 'locked_fields') {
            return sql`${field} = ARRAY(SELECT DISTINCT value FROM unnest(target.${field} || source.${field}) AS value)`;
          }
          if (column === 'manifest_legacy_recorded') return sql`${field} = target.${field} OR source.${field}`;
          if (column.startsWith('chapters_')) {
            return sql`${field} = CASE WHEN target.chapters IS NULL THEN source.${field} ELSE target.${field} END`;
          }
          return sql`${field} = COALESCE(target.${field}, source.${field})`;
        }),
        sql`, `,
      );
      await tx.execute(sql`
        UPDATE ${tableSql} AS target SET ${updates}
        FROM ${tableSql} AS source
        WHERE target.book_id = ${targetId} AND source.book_id = ${sourceId}
      `);
    }
    await tx.execute(sql`DELETE FROM ${tableSql} WHERE book_id IN ${sourceList}`);
  }
}
