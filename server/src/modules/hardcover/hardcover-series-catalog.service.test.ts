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
  let service: HardcoverSeriesCatalogService;

  beforeEach(() => {
    vi.resetAllMocks();
    service = new HardcoverSeriesCatalogService(client as unknown as HardcoverClientService, settings as unknown as HardcoverSettingsService);
    settings.getMetadataToken.mockResolvedValue('catalog-token');
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
