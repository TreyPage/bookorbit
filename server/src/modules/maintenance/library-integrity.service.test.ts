import { describe, expect, it, vi } from 'vitest';

import { LibraryIntegrityService } from './library-integrity.service';

describe('LibraryIntegrityService', () => {
  it('runs a read-only summary across all libraries and all duplicate-format pages', async () => {
    const repo = {
      findBookFolderPaths: vi.fn().mockResolvedValue([]),
      findExistingBookIds: vi.fn().mockResolvedValue([]),
      findDuplicateFormatGroups: vi.fn()
        .mockResolvedValueOnce({ items: [{ fileCount: 3 }], total: 101 })
        .mockResolvedValueOnce({ items: [{ fileCount: 2 }], total: 101 }),
    };
    const libraryService = {
      findAccessibleLibraryIds: vi.fn().mockResolvedValue([1, 2]),
      findAll: vi.fn().mockResolvedValue([
        { id: 1, name: 'Fiction', folders: [{ path: '/fiction' }] },
        { id: 2, name: 'Audio', folders: [{ path: '/audio' }] },
      ]),
    };
    const service = new LibraryIntegrityService(repo as never, libraryService as never, { get: () => '/nonexistent-appdata' } as never);
    const sidecarSpy = vi.spyOn(service, 'listSidecarFiles').mockResolvedValue({
      items: [], total: 7, page: 1, pageSize: 1, truncated: true,
    });

    await expect(service.scanAllLibraries()).resolves.toEqual({
      libraryCount: 2,
      duplicateFormatGroups: 101,
      duplicateFormatFiles: 5,
      sidecarEntries: 7,
      sidecarScanTruncated: true,
      orphanedMetadataFiles: 0,
      emptyBookFolders: 0,
      orphanedCoverDirectories: 0,
      orphanedCoverBytes: 0,
      filesystemScanTruncated: false,
      unreadableDirectories: 0,
    });
    expect(libraryService.findAccessibleLibraryIds).toHaveBeenCalledWith(expect.objectContaining({ isSuperuser: true }));
    expect(sidecarSpy).toHaveBeenCalledWith(expect.objectContaining({ isSuperuser: true }), 1, 1);
    expect(repo.findDuplicateFormatGroups).toHaveBeenNthCalledWith(1, [1, 2], 0, 100);
    expect(repo.findDuplicateFormatGroups).toHaveBeenNthCalledWith(2, [1, 2], 100, 100);
  });

  it('returns filesystem findings only from accessible libraries and caps the displayed results', async () => {
    const originalReaddir = await import('node:fs/promises');
    const repo = { findBookFolderPaths: vi.fn().mockResolvedValue(['/virtual/library/known-book']) };
    const libraryService = {
      findAccessibleLibraryIds: vi.fn().mockResolvedValue([1]),
      findAll: vi.fn().mockResolvedValue([
        { id: 1, name: 'Fiction', folders: [{ path: '/virtual/library' }] },
        { id: 2, name: 'Private', folders: [{ path: '/private' }] },
      ]),
    };
    const readdirSpy = vi.spyOn(originalReaddir, 'readdir').mockImplementation(async (path) => {
      const value = String(path);
      if (value === '/virtual/library') return [
        { name: 'known-book', isSymbolicLink: () => false, isDirectory: () => true, isFile: () => false },
        { name: 'orphan', isSymbolicLink: () => false, isDirectory: () => true, isFile: () => false },
      ] as never;
      if (value === '/virtual/library/known-book') return [] as never;
      if (value === '/virtual/library/orphan') return [
        { name: 'metadata.json', isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true },
      ] as never;
      return [] as never;
    });
    const service = new LibraryIntegrityService(repo as never, libraryService as never, { get: () => undefined } as never);
    try {
      await expect(service.listFilesystemFindings({ id: 7 } as never)).resolves.toEqual({
        orphanedMetadataFiles: { items: [{ libraryId: 1, libraryName: 'Fiction', path: '/virtual/library/orphan/metadata.json' }], total: 1 },
        emptyBookFolders: { items: [{ libraryId: 1, libraryName: 'Fiction', path: '/virtual/library/known-book' }], total: 1 },
        unreadableDirectories: { items: [], total: 0 },
        truncated: false,
        resultsTruncated: false,
      });
    } finally {
      readdirSpy.mockRestore();
    }
  });

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
    const service = new LibraryIntegrityService(repo as never, libraryService as never, { get: () => '/nonexistent-appdata' } as never);

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
    const result = {
      status: 'merged',
      target: { id: 10, name: 'Cosmere' },
      merged: [{ id: 11, name: 'The Cosmere' }],
      affectedBooks: 4,
      positionConflicts: 0,
    };
    const repo = { mergeSeries: vi.fn().mockResolvedValue(result) };
    const libraryService = { findAccessibleLibraryIds: vi.fn().mockResolvedValue([4, 8]) };
    const service = new LibraryIntegrityService(repo as never, libraryService as never, { get: () => '/nonexistent-appdata' } as never);
    const dto = { targetSeriesId: 10, sourceSeriesIds: [11], confirmPositionConflicts: false };

    await expect(service.mergeSeries({ id: 7 } as never, dto)).resolves.toEqual(result);
    expect(repo.mergeSeries).toHaveBeenCalledWith([4, 8], 10, [11], false);
  });

  it('returns no similar-series candidates when the user has no accessible libraries', async () => {
    const repo = { findSimilarSeriesPairs: vi.fn() };
    const libraryService = { findAccessibleLibraryIds: vi.fn().mockResolvedValue([]) };
    const service = new LibraryIntegrityService(repo as never, libraryService as never, { get: () => '/nonexistent-appdata' } as never);

    await expect(service.listSimilarSeries({ id: 7 } as never)).resolves.toEqual({ items: [], truncated: false });
    expect(repo.findSimilarSeriesPairs).not.toHaveBeenCalled();
  });

  it('returns an empty page when the user has no accessible libraries', async () => {
    const repo = { findDuplicateFormatGroups: vi.fn() };
    const libraryService = { findAccessibleLibraryIds: vi.fn().mockResolvedValue([]) };
    const service = new LibraryIntegrityService(repo as never, libraryService as never, { get: () => '/nonexistent-appdata' } as never);

    await expect(service.listDuplicateFormats({ id: 7 } as never, 1, 50)).resolves.toEqual({
      items: [],
      total: 0,
      page: 1,
      pageSize: 50,
    });
    expect(repo.findDuplicateFormatGroups).not.toHaveBeenCalled();
  });
});
