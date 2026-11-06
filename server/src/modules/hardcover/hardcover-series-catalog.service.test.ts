import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { HardcoverClientService } from './hardcover-client.service';
import type { HardcoverSettingsService } from './hardcover-settings.service';
import { HardcoverSeriesCatalogService } from './hardcover-series-catalog.service';
import { HardcoverApiError } from './hardcover-client.service';

describe('HardcoverSeriesCatalogService', () => {
  const client = {
    query: vi.fn<HardcoverClientService['query']>(),
  };
  const settings = {
    getMetadataToken: vi.fn<HardcoverSettingsService['getMetadataToken']>(),
  };
  const cache = { findByNormalizedName: vi.fn(), upsert: vi.fn() };
  let service: HardcoverSeriesCatalogService;

  beforeEach(() => {
    vi.resetAllMocks();
    cache.findByNormalizedName.mockResolvedValue(null);
    cache.upsert.mockResolvedValue(undefined);
    service = new HardcoverSeriesCatalogService(client as unknown as HardcoverClientService, settings as unknown as HardcoverSettingsService, cache as any);
    settings.getMetadataToken.mockResolvedValue('catalog-token');
  });


  it('uses a fresh shared cache without calling Hardcover', async () => {
    cache.findByNormalizedName.mockResolvedValue({
      books: [{ index: 1, title: 'Book One', authors: ['Author'] }, { index: 2, title: 'Book Two', authors: ['Author'] }],
      catalogFound: true,
      expectedBookCount: 2,
      fetchedAt: new Date(),
    });

    await expect(service.findMissingBooks(7, 'My Series', ['1'])).resolves.toEqual({
      books: [{ index: 2, title: 'Book Two', authors: ['Author'] }],
      missingPositions: [2],
      expectedBookCount: 2,
      catalogFound: true,
      status: 'available',
    });
    expect(settings.getMetadataToken).not.toHaveBeenCalled();
    expect(client.query).not.toHaveBeenCalled();
  });

  it('refreshes an expired cache and replaces it after a successful lookup', async () => {
    cache.findByNormalizedName.mockResolvedValue({
      books: [{ index: 1, title: 'Book One', authors: [] }],
      catalogFound: true,
      expectedBookCount: 1,
      fetchedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000),
    });
    client.query.mockResolvedValue({
      series: [{ name: 'My Series', book_series: [
        { position: 1, book: { title: 'Book One', canonical_id: null } },
        { position: 2, book: { title: 'New Book', canonical_id: null } },
      ] }],
    });

    await expect(service.findMissingBooks(7, 'My Series', ['1'])).resolves.toMatchObject({
      books: [{ index: 2, title: 'New Book' }],
      missingPositions: [2],
      expectedBookCount: 2,
      status: 'available',
    });
    expect(cache.upsert).toHaveBeenCalledWith(expect.objectContaining({
      normalizedName: 'myseries',
      catalogFound: true,
      expectedBookCount: 2,
      books: expect.arrayContaining([{ index: 2, title: 'New Book', authors: [] }]),
    }));
  });

  it('serves stale cached data if an automatic refresh fails', async () => {
    cache.findByNormalizedName.mockResolvedValue({
      books: [{ index: 1, title: 'Book One', authors: [] }, { index: 2, title: 'Book Two', authors: [] }],
      catalogFound: true,
      expectedBookCount: 2,
      fetchedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000),
    });
    client.query.mockRejectedValue(new Error('Hardcover unavailable'));

    await expect(service.findMissingBooks(7, 'My Series', ['1'])).resolves.toMatchObject({
      books: [{ index: 2, title: 'Book Two', authors: [] }],
      missingPositions: [2],
      expectedBookCount: 2,
      catalogFound: true,
      status: 'available',
    });
    expect(cache.upsert).not.toHaveBeenCalled();
  });

  it('does not claim a manual refresh succeeded when Hardcover fails', async () => {
    cache.findByNormalizedName.mockResolvedValue({
      books: [{ index: 1, title: 'Book One', authors: [] }],
      catalogFound: true,
      expectedBookCount: 1,
      fetchedAt: new Date(),
    });
    client.query.mockRejectedValue(new Error('Hardcover unavailable'));

    await expect(service.forceRefresh(7, 'My Series', ['1'])).resolves.toMatchObject({
      status: 'failed',
      catalogFound: false,
    });
    expect(cache.upsert).not.toHaveBeenCalled();
  });

  it('discovers missing titles and the expected total from the full Hardcover catalog', async () => {
    client.query.mockResolvedValue({
      series: [
        {
          name: 'Dungeon Crawler Carl',
          book_series: [
            { position: 1, book: { title: 'Dungeon Crawler Carl', canonical_id: null } },
            {
              position: 4,
              book: {
                title: 'The Gate of the Feral Gods',
                canonical_id: null,
                default_cover_edition: { language: { code2: 'en' } },
                cached_contributors: [{ author: { name: 'Matt Dinniman' } }],
              },
            },
            {
              position: 2,
              book: {
                title: "Carl's Doomsday Scenario",
                canonical_id: null,
                default_cover_edition: { language: { code2: 'en' } },
                cached_contributors: [
                  { contribution: 'author', author: { name: 'Matt Dinniman' } },
                  { contribution: 'illustrator', author: { name: 'Cover Artist' } },
                ],
              },
            },
          ],
        },
      ],
    });

    await expect(service.findMissingBooks(7, 'Dungeon Crawler Carl', ['1'])).resolves.toEqual({
      status: 'available',
      catalogFound: true,
      expectedBookCount: 4,
      missingPositions: [2, 4],
      books: [
        { index: 2, title: "Carl's Doomsday Scenario", authors: ['Matt Dinniman'] },
        { index: 4, title: 'The Gate of the Feral Gods', authors: ['Matt Dinniman'] },
      ],
    });
    expect(settings.getMetadataToken).toHaveBeenCalledWith(7);
    expect(client.query).toHaveBeenCalledWith(
      7,
      'catalog-token',
      expect.stringContaining('book_series(order_by: { position: asc }, limit: 1000)'),
      expect.objectContaining({ seriesName: 'Dungeon Crawler Carl' }),
    );
    const sentQuery = client.query.mock.calls[0]?.[2] ?? '';
    expect(sentQuery).toContain('name: { _eq: $seriesName }');
    expect(sentQuery).not.toContain('_ilike');
    expect(sentQuery).toContain('default_cover_edition');
    expect(sentQuery).toContain('canonical_id');
  });

  it('matches a Hardcover series name case-insensitively and tolerates a suffix in the catalog name', async () => {
    client.query.mockResolvedValue({
      series: [
        {
          name: 'Dungeon Crawler Carl Series',
          book_series: [
            { position: 1, book: { title: 'Dungeon Crawler Carl', canonical_id: null } },
            {
              position: 2,
              book: {
                title: "Carl's Doomsday Scenario",
                canonical_id: null,
                default_cover_edition: { language: { code2: 'en' } },
              },
            },
          ],
        },
      ],
    });

    await expect(service.findMissingBooks(7, 'dungeon crawler carl', ['1'])).resolves.toEqual({
      status: 'available',
      catalogFound: true,
      expectedBookCount: 2,
      missingPositions: [2],
      books: [{ index: 2, title: "Carl's Doomsday Scenario", authors: [] }],
    });
  });

  it('omits translated and duplicate catalog entries while retaining English originals', async () => {
    client.query.mockResolvedValue({
      series: [
        {
          name: 'Dungeon Crawler Carl',
          book_series: [
            { position: 1, book: { title: 'Dungeon Crawler Carl', canonical_id: null, default_cover_edition: { language: { code2: 'en' } } } },
            { position: 2, book: { title: 'El Iniciador de Mazmorras', canonical_id: null, default_cover_edition: { language: { code2: 'es' } } } },
            { position: 2, book: { title: "Carl's Doomsday Scenario", canonical_id: null, default_cover_edition: { language: { code2: 'en' } } } },
            {
              position: 3,
              book: { title: 'Dungeon Crawler Carl Translation', canonical_id: 100, default_cover_edition: { language: { code2: 'en' } } },
            },
            {
              position: 4,
              book: { title: 'The Gate of the Feral Gods', canonical_id: null, default_cover_edition: { language: { code2: 'en' } } },
            },
          ],
        },
      ],
    });

    await expect(service.findMissingBooks(7, 'Dungeon Crawler Carl', ['1'])).resolves.toMatchObject({
      expectedBookCount: 4,
      missingPositions: [2, 4],
      books: [
        { index: 2, title: "Carl's Doomsday Scenario" },
        { index: 4, title: 'The Gate of the Feral Gods' },
      ],
    });
  });

  it('loads missing titles by book id when nested book relations omit their titles', async () => {
    client.query
      .mockResolvedValueOnce({
        series: [
          {
            name: 'Dungeon Crawler Carl',
            book_series: [
              { position: 1, book_id: 10, book: { title: 'Dungeon Crawler Carl', canonical_id: null } },
              { position: 2, book_id: 20, book: { title: null, canonical_id: null } },
            ],
          },
        ],
      })
      .mockResolvedValueOnce({
        books: [
          {
            id: 20,
            canonical_id: null,
            title: "Carl's Doomsday Scenario",
            default_cover_edition: { language: { code2: 'en' } },
            cached_contributors: [{ contribution: 'author', author: { name: 'Matt Dinniman' } }],
          },
        ],
      });

    await expect(service.findMissingBooks(7, 'Dungeon Crawler Carl', ['1'])).resolves.toMatchObject({
      status: 'available',
      missingPositions: [2],
      books: [{ index: 2, title: "Carl's Doomsday Scenario", authors: ['Matt Dinniman'] }],
    });
    expect(client.query).toHaveBeenNthCalledWith(2, 7, 'catalog-token', expect.stringContaining('SeriesCatalogBookTitles'), { bookIds: [20] });
  });

  it('returns no gaps when every catalog position is already owned', async () => {
    client.query.mockResolvedValue({
      series: [{ name: 'Dungeon Crawler Carl', book_series: [{ position: 1, book: { title: 'Dungeon Crawler Carl' } }] }],
    });

    await expect(service.findMissingBooks(7, 'Dungeon Crawler Carl', ['1'])).resolves.toEqual({
      books: [],
      missingPositions: [],
      expectedBookCount: 1,
      catalogFound: true,
      status: 'no_missing',
    });
  });

  it('uses a fresh persistent catalog without calling Hardcover', async () => {
    cache.findByNormalizedName.mockResolvedValue({
      normalizedName: 'dungeoncrawlercarl',
      seriesName: 'Dungeon Crawler Carl',
      books: [{ index: 1, title: 'Dungeon Crawler Carl', authors: ['Matt Dinniman'] }, { index: 2, title: "Carl's Doomsday Scenario", authors: ['Matt Dinniman'] }],
      catalogFound: true,
      expectedBookCount: 2,
      fetchedAt: new Date(),
    });

    await expect(service.findMissingBooks(7, 'Dungeon Crawler Carl', ['1'])).resolves.toEqual({
      books: [{ index: 2, title: "Carl's Doomsday Scenario", authors: ['Matt Dinniman'] }],
      missingPositions: [2],
      expectedBookCount: 2,
      catalogFound: true,
      status: 'available',
    });
    expect(settings.getMetadataToken).not.toHaveBeenCalled();
    expect(client.query).not.toHaveBeenCalled();
  });

  it('falls back to stale cached data when Hardcover refresh fails', async () => {
    cache.findByNormalizedName.mockResolvedValue({
      normalizedName: 'dungeoncrawlercarl',
      seriesName: 'Dungeon Crawler Carl',
      books: [{ index: 1, title: 'Dungeon Crawler Carl', authors: [] }, { index: 2, title: "Carl's Doomsday Scenario", authors: [] }],
      catalogFound: true,
      expectedBookCount: 2,
      fetchedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000),
    });
    client.query.mockRejectedValue(new Error('Hardcover unavailable'));

    await expect(service.findMissingBooks(7, 'Dungeon Crawler Carl', ['1'])).resolves.toMatchObject({
      missingPositions: [2],
      books: [{ index: 2, title: "Carl's Doomsday Scenario" }],
      catalogFound: true,
      status: 'available',
    });
    expect(cache.upsert).not.toHaveBeenCalled();
  });

  it('reports an unconfigured Hardcover connection without hiding the state', async () => {
    settings.getMetadataToken.mockResolvedValue(null);

    await expect(service.findMissingBooks(7, 'Dungeon Crawler Carl', ['1'])).resolves.toEqual({
      books: [],
      missingPositions: [],
      expectedBookCount: null,
      catalogFound: false,
      status: 'not_configured',
    });
    expect(client.query).not.toHaveBeenCalled();
  });

  it('returns a visible lookup failure when the Hardcover request fails', async () => {
    client.query.mockRejectedValue(new Error('GraphQL request failed'));

    await expect(service.findMissingBooks(7, 'Dungeon Crawler Carl', ['1'])).resolves.toEqual({
      books: [],
      missingPositions: [],
      expectedBookCount: null,
      catalogFound: false,
      status: 'failed',
    });
  });

  it('reports the missing catalog scope separately from other lookup failures', async () => {
    client.query.mockRejectedValue(new HardcoverApiError(403, 'insufficient_scope', 'Missing catalog access', 'read:catalog'));

    await expect(service.findMissingBooks(7, 'Dungeon Crawler Carl', ['1'])).resolves.toEqual({
      books: [],
      missingPositions: [],
      expectedBookCount: null,
      catalogFound: false,
      status: 'insufficient_scope',
    });
  });
});
