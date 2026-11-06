import { Injectable, Logger } from '@nestjs/common';
import type { MissingSeriesBook, MissingSeriesBooksStatus } from '@bookorbit/types';

import { MAX_SERIES_TOTAL_BOOKS } from '../../common/utils/series-total-books.utils';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { HardcoverApiError, HardcoverClientService } from './hardcover-client.service';
import { HardcoverSettingsService } from './hardcover-settings.service';

const MAX_SERIES_BOOKS = 1000;

type HardcoverCatalogBook = {
  canonical_id?: number | null;
  title?: string | null;
  default_cover_edition?: {
    language?: { code2?: string | null } | null;
  } | null;
  cached_contributors?: Array<{
    contribution?: string | null;
    author?: { name?: string | null };
  }> | null;
};

type HardcoverSeriesBookRow = {
  position: number | string | null;
  book_id?: number | string | null;
  book?: HardcoverCatalogBook | null;
};

type HardcoverSeriesResponse = {
  series?: Array<{
    name: string;
    book_series?: HardcoverSeriesBookRow[] | null;
  }> | null;
};

type HardcoverBooksResponse = {
  books?: (HardcoverCatalogBook & { id: number | string })[] | null;
};

export type MissingSeriesBooksResult = {
  books: MissingSeriesBook[];
  missingPositions: number[];
  expectedBookCount: number | null;
  catalogFound: boolean;
  status: MissingSeriesBooksStatus;
};

function seriesAuthors(row: HardcoverSeriesBookRow): string[] {
  return contributorAuthors(row.book?.cached_contributors);
}

function isEnglishCatalogBook(book: HardcoverCatalogBook | null | undefined): boolean {
  if (!book || book.canonical_id != null) return false;
  const languageCode = book.default_cover_edition?.language?.code2?.trim().toLowerCase();
  return languageCode == null || languageCode === '' || languageCode === 'en';
}

function contributorAuthors(contributors: Array<{ contribution?: string | null; author?: { name?: string | null } }> | null | undefined): string[] {
  return (contributors ?? [])
    .filter((contributor) => contributor.contribution == null || contributor.contribution.trim().toLowerCase() === 'author')
    .map((contributor) => contributor.author?.name?.trim())
    .filter((name): name is string => Boolean(name));
}

function normalizeSeriesName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
}

function seriesNameMatchRank(actualName: string, requestedName: string): number {
  const actual = normalizeSeriesName(actualName);
  const requested = normalizeSeriesName(requestedName);
  if (!actual || !requested) return Number.MAX_SAFE_INTEGER;
  if (actual === requested) return 0;
  if (actual.startsWith(requested) || actual.endsWith(requested)) return Math.abs(actual.length - requested.length);
  if (actual.includes(requested) || requested.includes(actual)) return 100 + Math.abs(actual.length - requested.length);
  return Number.MAX_SAFE_INTEGER;
}

@Injectable()
export class HardcoverSeriesCatalogService {
  private readonly logger = new Logger(HardcoverSeriesCatalogService.name);

  constructor(
    private readonly client: HardcoverClientService,
    private readonly settings: HardcoverSettingsService,
  ) {}

  async findMissingBooks(userId: number, seriesName: string, ownedIndices: readonly string[]): Promise<MissingSeriesBooksResult> {
    const token = await this.settings.getMetadataToken(userId);
    if (!token) return { books: [], missingPositions: [], expectedBookCount: null, catalogFound: false, status: 'not_configured' };

    const startedAt = Date.now();
    const safeSeriesName = sanitizeLogValue(seriesName);
    this.logger.log(
      `[hardcover.series_catalog] [start] userId=${userId} seriesName="${safeSeriesName}" ownedIndices=${ownedIndices.length} - series catalog lookup started`,
    );

    try {
      const seriesNamePattern = `%${seriesName.trim().replace(/[\\%_]/g, '\\$&')}%`;

      const query = `query SeriesCatalog($seriesNamePattern: String!) {
                        series(
                          where: {
                            name: { _ilike: $seriesNamePattern }
                            state: { _eq: "active" }
                          }
                          limit: 10
                        ) {
                          name
                          book_series(order_by: { position: asc }, limit: ${MAX_SERIES_BOOKS}) {
                            position
                            book_id
                            book {
                              canonical_id
                              title
                              cached_contributors
                              default_cover_edition {
                                language {
                                  code2
                                }
                              }
                            }
                          }
                        }
                      } `;

      const data = await this.client.query<HardcoverSeriesResponse>(userId, token, query, { seriesNamePattern });

      if (!Array.isArray(data?.series)) throw new Error('Hardcover series lookup returned an invalid response');
      const matchingSeries = data.series
        .map((series) => ({ series, rank: seriesNameMatchRank(series.name, seriesName) }))
        .filter(({ rank }) => rank !== Number.MAX_SAFE_INTEGER)
        .sort((a, b) => a.rank - b.rank)
        .slice(0, 1)
        .map(({ series }) => series);

      const catalog = new Map<number, MissingSeriesBook>();
      const missingBookIds = new Map<number, number>();
      for (const series of matchingSeries) {
        for (const row of series.book_series ?? []) {
          const index = Number(row.position);
          if (!Number.isSafeInteger(index) || index < 1 || index > MAX_SERIES_TOTAL_BOOKS || catalog.has(index)) continue;
          if (!isEnglishCatalogBook(row.book)) continue;
          const title = row.book?.title?.trim();
          catalog.set(index, { index, title: title ?? '', authors: seriesAuthors(row) });
          const bookId = Number(row.book_id);
          if (!title && Number.isSafeInteger(bookId) && bookId > 0) missingBookIds.set(index, bookId);
        }
      }

      if (missingBookIds.size > 0) {
        const booksQuery = `
          query SeriesCatalogBookTitles($bookIds: [Int!]!) {
            books(where: { id: { _in: $bookIds } }) {
              id
              canonical_id
              title
              cached_contributors
              default_cover_edition {
                language {
                  code2
                }
              }
            }
          }
        `;
        const booksData = await this.client.query<HardcoverBooksResponse>(userId, token, booksQuery, {
          bookIds: [...missingBookIds.values()],
        });
        if (!Array.isArray(booksData?.books)) throw new Error('Hardcover book title lookup returned an invalid response');
        const booksById = new Map(booksData.books.map((book) => [Number(book.id), book]));
        for (const [index, bookId] of missingBookIds) {
          const book = booksById.get(bookId);
          if (!isEnglishCatalogBook(book)) {
            catalog.delete(index);
            continue;
          }
          const title = book?.title?.trim();
          const catalogBook = catalog.get(index);
          if (catalogBook && title) {
            catalogBook.title = title;
            catalogBook.authors = contributorAuthors(book?.cached_contributors);
          }
        }
      }

      const catalogFound = catalog.size > 0;
      const ownedPositions = new Set(
        ownedIndices
          .filter((index) => /^\d+$/.test(index))
          .map(Number)
          .filter((index) => Number.isSafeInteger(index) && index > 0),
      );
      const missingPositions = [...catalog.keys()].filter((index) => !ownedPositions.has(index)).sort((a, b) => a - b);
      const missingBooks = missingPositions.flatMap((index) => {
        const book = catalog.get(index);
        return book?.title ? [book] : [];
      });
      const expectedBookCount = catalogFound ? Math.max(...catalog.keys()) : null;
      const status: MissingSeriesBooksStatus = missingPositions.length === 0 ? 'no_missing' : missingBooks.length > 0 ? 'available' : 'not_found';
      this.logger.log(
        `[hardcover.series_catalog] [end] userId=${userId} seriesName="${safeSeriesName}" durationMs=${Date.now() - startedAt} catalogBooks=${catalog.size} missing=${missingPositions.length} titled=${missingBooks.length} - series catalog lookup completed`,
      );
      return {
        books: missingBooks,
        missingPositions,
        expectedBookCount,
        catalogFound,
        status: catalogFound ? status : 'not_found',
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.warn(
        `[hardcover.series_catalog] [fail] userId=${userId} seriesName="${safeSeriesName}" durationMs=${Date.now() - startedAt} errorClass=${err.constructor.name} error="${sanitizeLogValue(err.message)}" - series catalog lookup failed`,
      );
      if (err instanceof HardcoverApiError && err.errorCode === 'insufficient_scope') {
        return { books: [], missingPositions: [], expectedBookCount: null, catalogFound: false, status: 'insufficient_scope' };
      }
      return { books: [], missingPositions: [], expectedBookCount: null, catalogFound: false, status: 'failed' };
    }
  }
}
