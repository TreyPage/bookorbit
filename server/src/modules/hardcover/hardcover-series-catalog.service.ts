import { Injectable, Logger } from '@nestjs/common';
import type { MissingSeriesBook, MissingSeriesBooksStatus } from '@bookorbit/types';

import { MAX_SERIES_TOTAL_BOOKS } from '../../common/utils/series-total-books.utils';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { HardcoverApiError, HardcoverClientService } from './hardcover-client.service';
import { HardcoverSettingsService } from './hardcover-settings.service';
import { HardcoverSeriesCatalogRepository } from './hardcover-series-catalog.repository';

const MAX_SERIES_BOOKS = 1000;
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

type HardcoverCatalogBook = {
  canonical_id?: number | null;
  title?: string | null;
  default_cover_edition?: { language?: { code2?: string | null } | null } | null;
  cached_contributors?: Array<{ contribution?: string | null; author?: { name?: string | null } }> | null;
};
type HardcoverSeriesBookRow = { position: number | string | null; book_id?: number | string | null; book?: HardcoverCatalogBook | null };
type HardcoverSeriesResponse = { series?: Array<{ name: string; book_series?: HardcoverSeriesBookRow[] | null }> | null };
type HardcoverBooksResponse = { books?: (HardcoverCatalogBook & { id: number | string })[] | null };

export type MissingSeriesBooksResult = {
  books: MissingSeriesBook[];
  missingPositions: number[];
  expectedBookCount: number | null;
  catalogFound: boolean;
  status: MissingSeriesBooksStatus;
};

function contributorAuthors(contributors: HardcoverCatalogBook['cached_contributors']): string[] {
  return (contributors ?? [])
    .filter((item) => item.contribution == null || item.contribution.trim().toLowerCase() === 'author')
    .map((item) => item.author?.name?.trim())
    .filter((name): name is string => Boolean(name));
}
function isEnglishCatalogBook(book: HardcoverCatalogBook | null | undefined): boolean {
  if (!book || book.canonical_id != null) return false;
  const language = book.default_cover_edition?.language?.code2?.trim().toLowerCase();
  return language == null || language === '' || language === 'en';
}
function normalizeSeriesName(value: string): string {
  return value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}
function normalizeSeriesCacheKey(value: string): string {
  // Keep punctuation and word boundaries in cache identity to avoid collisions such as
  // "A-B" and "AB". Case, diacritics, and repeated whitespace remain equivalent.
  return value.normalize('NFD').replace(/\p{Diacritic}/gu, '').trim().toLowerCase().replace(/\s+/gu, ' ');
}
function seriesNameMatchRank(actualName: string, requestedName: string): number {
  const actual = normalizeSeriesName(actualName);
  const requested = normalizeSeriesName(requestedName);
  if (!actual || !requested) return Number.MAX_SAFE_INTEGER;
  if (actual === requested) return 0;
  // Accept only boundary variants (for example, a trailing "Series"). Arbitrary
  // interior substring matches can select an unrelated series with a short name.
  if (actual.startsWith(requested) || actual.endsWith(requested)) return Math.abs(actual.length - requested.length);
  return Number.MAX_SAFE_INTEGER;
}

@Injectable()
export class HardcoverSeriesCatalogService {
  private readonly logger = new Logger(HardcoverSeriesCatalogService.name);
  private readonly refreshes = new Map<string, Promise<MissingSeriesBook[]>>();
  private readonly lastRefreshAttempt = new Map<string, number>();
  private readonly RETRY_COOLDOWN_MS = 60 * 60 * 1000;

  constructor(
    private readonly client: HardcoverClientService,
    private readonly settings: HardcoverSettingsService,
    private readonly cache: HardcoverSeriesCatalogRepository,
  ) {}

  async findMissingBooks(userId: number, seriesName: string, ownedIndices: readonly string[]): Promise<MissingSeriesBooksResult> {
    const key = normalizeSeriesCacheKey(seriesName);
    const cached = key ? await this.cache.findByNormalizedName(key) : null;
    if (cached && Date.now() - cached.fetchedAt.getTime() < CACHE_TTL_MS) {
      return this.toResult(cached.books, cached.catalogFound, cached.expectedBookCount, ownedIndices);
    }
    // Avoid repeatedly hitting Hardcover during an outage. The successful cache remains
    // stale, but a failed refresh is retried at most once per hour per series per process.
    const refreshKey = `${userId}:${key}`;
    const lastAttempt = this.lastRefreshAttempt.get(refreshKey);
    if (cached && lastAttempt != null && Date.now() - lastAttempt < this.RETRY_COOLDOWN_MS) {
      return this.toResult(cached.books, cached.catalogFound, cached.expectedBookCount, ownedIndices);
    }

    const token = await this.settings.getMetadataToken(userId);
    if (!token) {
      return cached
        ? this.toResult(cached.books, cached.catalogFound, cached.expectedBookCount, ownedIndices)
        : this.emptyResult('not_configured');
    }

    try {
      const books = await this.refreshCatalog(userId, token, seriesName, key);
      const expectedBookCount = books.length ? Math.max(...books.map((book) => book.index)) : null;
      const catalogFound = books.length > 0;
      await this.cache.upsert({
        normalizedName: key,
        seriesName,
        books,
        catalogFound,
        expectedBookCount,
        fetchedAt: new Date(),
      });
      return this.toResult(books, catalogFound, expectedBookCount, ownedIndices);
    } catch (error) {
      this.logFailure(userId, seriesName, error);
      if (cached) return this.toResult(cached.books, cached.catalogFound, cached.expectedBookCount, ownedIndices);
      return this.emptyResult(error instanceof HardcoverApiError && error.errorCode === 'insufficient_scope' ? 'insufficient_scope' : 'failed');
    }
  }

  async forceRefresh(userId: number, seriesName: string, ownedIndices: readonly string[]): Promise<MissingSeriesBooksResult> {
    const key = normalizeSeriesCacheKey(seriesName);
    const token = await this.settings.getMetadataToken(userId);
    if (!token) return this.emptyResult('not_configured');
    try {
      const books = await this.refreshCatalog(userId, token, seriesName, key);
      const expectedBookCount = books.length ? Math.max(...books.map((book) => book.index)) : null;
      const catalogFound = books.length > 0;
      await this.cache.upsert({
        normalizedName: key,
        seriesName,
        books,
        catalogFound,
        expectedBookCount,
        fetchedAt: new Date(),
      });
      return this.toResult(books, catalogFound, expectedBookCount, ownedIndices);
    } catch (error) {
      this.logFailure(userId, seriesName, error);
      return this.emptyResult(error instanceof HardcoverApiError && error.errorCode === 'insufficient_scope' ? 'insufficient_scope' : 'failed');
    }
  }

  private async refreshCatalog(userId: number, token: string, seriesName: string, key: string): Promise<MissingSeriesBook[]> {
    // Credentials are user-scoped even though the resulting public catalog is shared.
    const refreshKey = `${userId}:${key}`;
    const existing = this.refreshes.get(refreshKey);
    if (existing) return existing;
    this.lastRefreshAttempt.set(refreshKey, Date.now());
    const pending = this.fetchCatalog(userId, token, seriesName);
    this.refreshes.set(refreshKey, pending);
    try {
      return await pending;
    } finally {
      if (this.refreshes.get(refreshKey) === pending) this.refreshes.delete(refreshKey);
    }
  }

  private async fetchCatalog(userId: number, token: string, seriesName: string): Promise<MissingSeriesBook[]> {
    const query = `
      query SeriesCatalog($seriesName: String!) {
        series(where: { name: { _eq: $seriesName }, state: { _eq: "active" } }, limit: 10) {
          name
          book_series(order_by: { position: asc }, limit: ${MAX_SERIES_BOOKS}) {
            position book_id
            book {
              canonical_id title cached_contributors
              default_cover_edition { language { code2 } }
            }
          }
        }
      }
    `;
    let data = await this.client.query<HardcoverSeriesResponse>(userId, token, query, { seriesName });
    if (!Array.isArray(data?.series)) throw new Error('Hardcover series lookup returned an invalid response');

    // The exact lookup is the cheapest and most precise path. If Hardcover stores a
    // slightly different display name (for example, a trailing "Series"), retry with
    // a bounded substring lookup so the ranking below can select the closest match.
    if (data.series.length === 0) {
      const fallbackQuery = `
        query SeriesCatalogFallback($seriesName: String!) {
          series(where: { name: { _ilike: $seriesName }, state: { _eq: "active" } }, limit: 25) {
            name
            book_series(order_by: { position: asc }, limit: ${MAX_SERIES_BOOKS}) {
              position book_id
              book {
                canonical_id title cached_contributors
                default_cover_edition { language { code2 } }
              }
            }
          }
        }
      `;
      // Escape LIKE metacharacters so user-supplied '%' and '_' stay literal.
      const escapedSeriesName = seriesName.replace(/[\\%_]/gu, '\\$&');
      data = await this.client.query<HardcoverSeriesResponse>(userId, token, fallbackQuery, { seriesName: `%${escapedSeriesName}%` });
      if (!Array.isArray(data?.series)) throw new Error('Hardcover fallback series lookup returned an invalid response');
    }

    const matching = data.series
      .map((series) => ({ series, rank: seriesNameMatchRank(series.name, seriesName) }))
      .filter(({ rank }) => rank !== Number.MAX_SAFE_INTEGER)
      .sort((a, b) => a.rank - b.rank)
      .slice(0, 1)
      .map(({ series }) => series);
    const catalog = new Map<number, MissingSeriesBook>();
    const missingBookIds = new Map<number, number>();
    for (const series of matching) {
      for (const row of series.book_series ?? []) {
        const index = Number(row.position);
        if (!Number.isSafeInteger(index) || index < 1 || index > MAX_SERIES_TOTAL_BOOKS || catalog.has(index)) continue;
        if (!isEnglishCatalogBook(row.book)) continue;
        const title = row.book?.title?.trim();
        catalog.set(index, { index, title: title ?? '', authors: contributorAuthors(row.book?.cached_contributors) });
        const bookId = Number(row.book_id);
        if (!title && Number.isSafeInteger(bookId) && bookId > 0) missingBookIds.set(index, bookId);
      }
    }
    if (missingBookIds.size) {
      const titlesQuery = `
        query SeriesCatalogBookTitles($bookIds: [Int!]!) {
          books(where: { id: { _in: $bookIds } }) {
            id canonical_id title cached_contributors
            default_cover_edition { language { code2 } }
          }
        }
      `;
      const titles = await this.client.query<HardcoverBooksResponse>(userId, token, titlesQuery, { bookIds: [...missingBookIds.values()] });
      if (!Array.isArray(titles?.books)) throw new Error('Hardcover book title lookup returned an invalid response');
      const byId = new Map(titles.books.map((book) => [Number(book.id), book]));
      for (const [index, bookId] of missingBookIds) {
        const book = byId.get(bookId);
        if (!isEnglishCatalogBook(book)) { catalog.delete(index); continue; }
        const title = book?.title?.trim();
        const entry = catalog.get(index);
        if (entry && title) { entry.title = title; entry.authors = contributorAuthors(book?.cached_contributors); }
      }
    }
    return [...catalog.values()].sort((a, b) => a.index - b.index);
  }

  private toResult(books: MissingSeriesBook[], catalogFound: boolean, expectedBookCount: number | null, ownedIndices: readonly string[]): MissingSeriesBooksResult {
    const owned = new Set(ownedIndices.filter((value) => /^\d+$/.test(value)).map(Number).filter((value) => Number.isSafeInteger(value) && value > 0));
    const missingPositions = books.map((book) => book.index).filter((index) => !owned.has(index)).sort((a, b) => a - b);
    const missingBooks = books.filter((book) => missingPositions.includes(book.index) && Boolean(book.title));
    const status: MissingSeriesBooksStatus = !catalogFound ? 'not_found' : missingPositions.length === 0 ? 'no_missing' : missingBooks.length ? 'available' : 'not_found';
    return { books: missingBooks, missingPositions, expectedBookCount, catalogFound, status };
  }

  private emptyResult(status: MissingSeriesBooksStatus): MissingSeriesBooksResult {
    return { books: [], missingPositions: [], expectedBookCount: null, catalogFound: false, status };
  }

  private logFailure(userId: number, seriesName: string, error: unknown): void {
    const err = error instanceof Error ? error : new Error(String(error));
    this.logger.warn(`[hardcover.series_catalog] [fail] userId=${userId} seriesName="${sanitizeLogValue(seriesName)}" errorClass=${err.constructor.name} error="${sanitizeLogValue(err.message)}" - series catalog refresh failed`);
  }
}
