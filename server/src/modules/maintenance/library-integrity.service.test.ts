import { describe, expect, it, vi } from 'vitest';

import { LibraryIntegrityService } from './library-integrity.service';

describe('LibraryIntegrityService', () => {
  it('scopes duplicate-format results to libraries the user can access', async () => {
    const repo = {
      findDuplicateFormatGroups: vi.fn().mockResolvedValue({
        items: [
          {
            bookId: 12,
            title: 'Example',
            libraryId: 4,
            libraryName: 'Fiction',
            folderPath: '/books/example',
            format: 'epub',
            fileCount: 2,
            files: [
              { id: 101, absolutePath: '/books/example/a.epub', sizeBytes: 100, fileHash: 'a'.repeat(32) },
              { id: 102, absolutePath: '/books/example/b.epub', sizeBytes: 100, fileHash: 'a'.repeat(32) },
            ],
          },
        ],
        total: 1,
      }),
    };
    const libraryService = { findAccessibleLibraryIds: vi.fn().mockResolvedValue([4, 8]) };
    const service = new LibraryIntegrityService(repo as never, libraryService as never);

    await expect(service.listDuplicateFormats({ id: 7 } as never, 2, 25)).resolves.toEqual({
      items: [
        {
          bookId: 12,
          title: 'Example',
          libraryId: 4,
          libraryName: 'Fiction',
          folderPath: '/books/example',
          format: 'epub',
          fileCount: 2,
          files: [
            { id: 101, absolutePath: '/books/example/a.epub', sizeBytes: 100, fileHash: 'a'.repeat(32) },
            { id: 102, absolutePath: '/books/example/b.epub', sizeBytes: 100, fileHash: 'a'.repeat(32) },
          ],
        },
      ],
      total: 1,
      page: 2,
      pageSize: 25,
    });
    expect(libraryService.findAccessibleLibraryIds).toHaveBeenCalledWith({ id: 7 });
    expect(repo.findDuplicateFormatGroups).toHaveBeenCalledWith([4, 8], 25, 25);
  });

  it('passes accessible libraries to the transactional series merge', async () => {
    const result = { status: 'merged', target: { id: 10, name: 'Cosmere' }, merged: [{ id: 11, name: 'The Cosmere' }], affectedBooks: 4, positionConflicts: 0 };
    const repo = { mergeSeries: vi.fn().mockResolvedValue(result) };
    const libraryService = { findAccessibleLibraryIds: vi.fn().mockResolvedValue([4, 8]) };
    const service = new LibraryIntegrityService(repo as never, libraryService as never);
    const dto = { targetSeriesId: 10, sourceSeriesIds: [11], confirmPositionConflicts: false };

    await expect(service.mergeSeries({ id: 7 } as never, dto)).resolves.toEqual(result);
    expect(repo.mergeSeries).toHaveBeenCalledWith([4, 8], 10, [11], false);
  });

  it('returns no similar-series candidates when the user has no accessible libraries', async () => {
    const repo = { findSimilarSeriesPairs: vi.fn() };
    const libraryService = { findAccessibleLibraryIds: vi.fn().mockResolvedValue([]) };
    const service = new LibraryIntegrityService(repo as never, libraryService as never);

    await expect(service.listSimilarSeries({ id: 7 } as never)).resolves.toEqual({ items: [], truncated: false });
    expect(repo.findSimilarSeriesPairs).not.toHaveBeenCalled();
  });

  it('returns an empty page when the user has no accessible libraries', async () => {
    const repo = { findDuplicateFormatGroups: vi.fn() };
    const libraryService = { findAccessibleLibraryIds: vi.fn().mockResolvedValue([]) };
    const service = new LibraryIntegrityService(repo as never, libraryService as never);

    await expect(service.listDuplicateFormats({ id: 7 } as never, 1, 50)).resolves.toEqual({
      items: [],
      total: 0,
      page: 1,
      pageSize: 50,
    });
    expect(repo.findDuplicateFormatGroups).not.toHaveBeenCalled();
  });
});
