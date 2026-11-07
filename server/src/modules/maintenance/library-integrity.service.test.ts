import { afterEach, describe, expect, it, vi } from 'vitest';

import { LibraryIntegrityService } from './library-integrity.service';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readdir: vi.fn(actual.readdir),
    stat: vi.fn(actual.stat),
    realpath: vi.fn(actual.realpath),
    lstat: vi.fn(actual.lstat),
    rmdir: vi.fn(actual.rmdir),
    unlink: vi.fn(actual.unlink),
  };
});

afterEach(async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  const mocked = await import('node:fs/promises');
  vi.mocked(mocked.readdir).mockReset().mockImplementation(actual.readdir);
  vi.mocked(mocked.stat).mockReset().mockImplementation(actual.stat);
  vi.mocked(mocked.realpath).mockReset().mockImplementation(actual.realpath);
  vi.mocked(mocked.lstat).mockReset().mockImplementation(actual.lstat);
  vi.mocked(mocked.rmdir).mockReset().mockImplementation(actual.rmdir);
  vi.mocked(mocked.unlink).mockReset().mockImplementation(actual.unlink);
});

describe('LibraryIntegrityService', () => {
  it('runs a read-only summary across all libraries and all duplicate-format pages', async () => {
    const repo = {
      findBookFolderPaths: vi.fn().mockResolvedValue([]),
      findExistingBookIds: vi.fn().mockResolvedValue([]),
      findDuplicateFormatGroups: vi
        .fn()
        .mockResolvedValueOnce({ items: [{ fileCount: 3 }], total: 101 })
        .mockResolvedValueOnce({ items: [{ fileCount: 2 }], total: 101 }),
    };
    const libraryService = {
      findAccessibleLibraryIds: vi.fn().mockResolvedValue([1, 2]),
      findAll: vi.fn().mockResolvedValue([
        { id: 1, name: 'Fiction', folders: [] },
        { id: 2, name: 'Audio', folders: [] },
      ]),
    };
    const service = new LibraryIntegrityService(repo as never, libraryService as never, { get: () => '/nonexistent-appdata' } as never);
    vi.spyOn(service as never, 'scanFilesystemAnomalies').mockResolvedValue({
      orphanedMetadataFiles: 0,
      orphanedBookFolders: 0,
      orphanedFiles: 0,
      emptyBookFolders: 0,
      orphanedCoverDirectories: 0,
      orphanedCoverBytes: 0,
      truncated: false,
      unreadableDirectories: 0,
    } as never);
    const sidecarSpy = vi.spyOn(service, 'listSidecarFiles').mockResolvedValue({
      items: [],
      total: 7,
      page: 1,
      pageSize: 1,
      truncated: true,
    });

    await expect(service.scanAllLibraries()).resolves.toEqual({
      libraryCount: 2,
      duplicateFormatGroups: 101,
      duplicateFormatFiles: 5,
      sidecarEntries: 7,
      sidecarScanTruncated: true,
      orphanedMetadataFiles: 0,
      orphanedBookFolders: 0,
      orphanedFiles: 0,
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

  it('does not duplicate text-file findings in the legacy sidecar list', async () => {
    const fs = await import('node:fs/promises');
    const readdirSpy = vi.mocked(fs.readdir).mockImplementation((path) =>
      Promise.resolve().then(() => {
        if (String(path) !== '/virtual/library') return [];
        return [
          { name: 'notes.txt', isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true },
          { name: 'partial.tmp', isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true },
        ] as never;
      }),
    );
    const statSpy = vi.mocked(fs.stat).mockResolvedValue({ size: 12 } as never);
    const libraryService = {
      findAll: vi.fn().mockResolvedValue([{ id: 1, name: 'Fiction', folders: [{ path: '/virtual/library' }] }]),
    };
    const service = new LibraryIntegrityService({} as never, libraryService as never, { get: () => '/nonexistent-appdata' } as never);

    try {
      await expect(service.listSidecarFiles({ id: 1 } as never, 1, 20)).resolves.toMatchObject({
        total: 1,
        items: [{ path: '/virtual/library/partial.tmp', kind: 'temporary_file' }],
      });
      expect(statSpy).toHaveBeenCalledTimes(1);
      expect(statSpy).toHaveBeenCalledWith('/virtual/library/partial.tmp');
    } finally {
      readdirSpy.mockReset();
      statSpy.mockReset();
    }
  });

  it('returns filesystem findings only from accessible libraries', async () => {
    const originalReaddir = await import('node:fs/promises');
    const repo = { findBookFolderPaths: vi.fn().mockResolvedValue(['/virtual/library/known-book']) };
    const libraryService = {
      findAccessibleLibraryIds: vi.fn().mockResolvedValue([1]),
      findAll: vi.fn().mockResolvedValue([
        { id: 1, name: 'Fiction', folders: [{ path: '/virtual/library' }] },
        { id: 2, name: 'Private', folders: [{ path: '/private' }] },
      ]),
    };
    const readdirSpy = vi.mocked(originalReaddir.readdir).mockImplementation((path) =>
      Promise.resolve().then(() => {
        const value = String(path);
        if (value === '/virtual/library')
          return [
            { name: 'known-book', isSymbolicLink: () => false, isDirectory: () => true, isFile: () => false },
            { name: 'orphan', isSymbolicLink: () => false, isDirectory: () => true, isFile: () => false },
            { name: 'empty-untracked', isSymbolicLink: () => false, isDirectory: () => true, isFile: () => false },
            { name: 'valid-book', isSymbolicLink: () => false, isDirectory: () => true, isFile: () => false },
            { name: 'locked', isSymbolicLink: () => false, isDirectory: () => true, isFile: () => false },
          ] as never;
        if (value === '/virtual/library/known-book') return [] as never;
        if (value === '/virtual/library/valid-book')
          return [
            { name: 'novel.epub', isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true },
            { name: 'notes.txt', isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true },
          ] as never;
        if (value === '/virtual/library/locked') throw new Error('EACCES');
        if (value === '/virtual/library/orphan')
          return [
            { name: 'metadata.json', isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true },
            { name: 'cover.jpg', isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true },
          ] as never;
        return [] as never;
      }),
    );
    const service = new LibraryIntegrityService(repo as never, libraryService as never, { get: () => undefined } as never);
    try {
      await expect(service.listFilesystemFindings({ id: 7 } as never)).resolves.toEqual({
        orphanedMetadataFiles: { items: [{ libraryId: 1, libraryName: 'Fiction', path: '/virtual/library/orphan/metadata.json' }], total: 1 },
        orphanedBookFolders: { items: [{ libraryId: 1, libraryName: 'Fiction', path: '/virtual/library/orphan' }], total: 1 },
        orphanedFiles: {
          items: [
            { libraryId: 1, libraryName: 'Fiction', path: '/virtual/library/orphan/cover.jpg', reason: 'folder_without_format' },
            { libraryId: 1, libraryName: 'Fiction', path: '/virtual/library/orphan/metadata.json', reason: 'folder_without_format' },
            { libraryId: 1, libraryName: 'Fiction', path: '/virtual/library/valid-book/notes.txt', reason: 'text_file' },
          ],
          total: 3,
        },
        emptyBookFolders: {
          items: [
            { libraryId: 1, libraryName: 'Fiction', path: '/virtual/library/empty-untracked' },
            { libraryId: 1, libraryName: 'Fiction', path: '/virtual/library/known-book' },
          ],
          total: 2,
        },
        unreadableDirectories: { items: [{ libraryId: 1, libraryName: 'Fiction', path: '/virtual/library/locked' }], total: 1 },
        truncated: false,
        hasMore: false,
        page: 1,
        pageSize: 50,
        snapshotId: expect.any(String),
      });
    } finally {
      readdirSpy.mockReset();
    }
  });

  it('reuses a user-scoped filesystem findings snapshot for subsequent pages', async () => {
    const fs = await import('node:fs/promises');
    const repo = { findBookFolderPaths: vi.fn().mockResolvedValue([]) };
    const libraryService = {
      findAccessibleLibraryIds: vi.fn().mockResolvedValue([1]),
      findAll: vi.fn().mockResolvedValue([{ id: 1, name: 'Fiction', folders: [{ path: '/virtual/library' }] }]),
    };
    const readdirSpy = vi.mocked(fs.readdir).mockImplementation((path) =>
      Promise.resolve().then(() => {
        if (String(path) === '/virtual/library')
          return Array.from({ length: 3 }, (_, index) => ({
            name: `orphan-${index}`,
            isSymbolicLink: () => false,
            isDirectory: () => true,
            isFile: () => false,
          })) as never;
        if (String(path).startsWith('/virtual/library/orphan-'))
          return [{ name: 'metadata.json', isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true }] as never;
        return [] as never;
      }),
    );
    const service = new LibraryIntegrityService(repo as never, libraryService as never, { get: () => undefined } as never);
    try {
      const first = await service.listFilesystemFindings({ id: 7 } as never, 1, 2);
      expect(first.orphanedBookFolders.items).toHaveLength(2);
      expect(first.hasMore).toBe(true);
      expect(first.snapshotId).toEqual(expect.any(String));
      const second = await service.listFilesystemFindings({ id: 7 } as never, 2, 2, first.snapshotId);
      expect(second.orphanedBookFolders.items).toHaveLength(1);
      expect(second.orphanedBookFolders.items[0].path).toBe('/virtual/library/orphan-2');
      expect(libraryService.findAll).toHaveBeenCalledTimes(1);
      const otherUser = await service.listFilesystemFindings({ id: 8 } as never, 2, 2, first.snapshotId);
      expect(otherUser.page).toBe(1);
      expect(libraryService.findAll).toHaveBeenCalledTimes(2);
    } finally {
      readdirSpy.mockReset();
    }
  });

  it('rechecks library access before returning cached filesystem findings', async () => {
    const fs = await import('node:fs/promises');
    const repo = { findBookFolderPaths: vi.fn().mockResolvedValue([]) };
    const libraryService = {
      findAccessibleLibraryIds: vi.fn().mockResolvedValueOnce([1]).mockResolvedValueOnce([]),
      findAll: vi.fn().mockResolvedValue([{ id: 1, name: 'Fiction', folders: [{ path: '/virtual/library' }] }]),
    };
    const readdirSpy = vi.mocked(fs.readdir).mockImplementation((path) =>
      Promise.resolve().then(() => {
        if (String(path) === '/virtual/library')
          return [{ name: 'orphan', isSymbolicLink: () => false, isDirectory: () => true, isFile: () => false }] as never;
        if (String(path) === '/virtual/library/orphan')
          return [{ name: 'metadata.json', isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true }] as never;
        return [] as never;
      }),
    );
    const service = new LibraryIntegrityService(repo as never, libraryService as never, { get: () => undefined } as never);
    try {
      const first = await service.listFilesystemFindings({ id: 7 } as never, 1, 10);
      expect(first.orphanedBookFolders.total).toBe(1);
      const second = await service.listFilesystemFindings({ id: 7 } as never, 1, 10, first.snapshotId);
      expect(second.orphanedBookFolders).toEqual({ items: [], total: 0 });
      expect(second.orphanedFiles).toEqual({ items: [], total: 0 });
      expect(libraryService.findAll).toHaveBeenCalledTimes(1);
      expect(libraryService.findAccessibleLibraryIds).toHaveBeenCalledTimes(2);
    } finally {
      readdirSpy.mockReset();
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

  describe('cleanupDuplicateFormatFile', () => {
    it('removes only the selected file under an accessible library root', async () => {
      const fs = await import('node:fs/promises');
      const removeDuplicateFormatFile = vi.fn(async (
        _libraryIds: number[],
        _fileId: number,
        removeFile: (file: { absolutePath: string; libraryId: number }) => Promise<void>,
      ) => {
        await removeFile({ absolutePath: '/virtual/library/book-copy.epub', libraryId: 1 });
        return 'removed' as const;
      });
      const libraryService = {
        findAccessibleLibraryIds: vi.fn().mockResolvedValue([1]),
        findAll: vi.fn().mockResolvedValue([{ id: 1, name: 'Fiction', folders: [{ path: '/virtual/library' }] }]),
      };
      const service = new LibraryIntegrityService(
        { removeDuplicateFormatFile } as never,
        libraryService as never,
        { get: () => undefined } as never,
      );
      const realpathSpy = vi.mocked(fs.realpath).mockImplementation((path) => Promise.resolve(String(path)));
      const lstatSpy = vi.mocked(fs.lstat).mockResolvedValue({ isFile: () => true, isSymbolicLink: () => false } as never);
      const unlinkSpy = vi.mocked(fs.unlink).mockResolvedValue(undefined);

      try {
        await expect(service.cleanupDuplicateFormatFile({ id: 7 } as never, 102)).resolves.toEqual({ removed: true });
        expect(removeDuplicateFormatFile).toHaveBeenCalledWith([1], 102, expect.any(Function));
        expect(unlinkSpy).toHaveBeenCalledTimes(1);
        expect(unlinkSpy).toHaveBeenCalledWith('/virtual/library/book-copy.epub');
      } finally {
        realpathSpy.mockReset();
        lstatSpy.mockReset();
        unlinkSpy.mockReset();
      }
    });

    it('does not touch disk when the selected file is outside accessible library roots', async () => {
      const fs = await import('node:fs/promises');
      const removeDuplicateFormatFile = vi.fn(async (
        _libraryIds: number[],
        _fileId: number,
        removeFile: (file: { absolutePath: string; libraryId: number }) => Promise<void>,
      ) => {
        await removeFile({ absolutePath: '/outside/book.epub', libraryId: 1 });
        return 'removed' as const;
      });
      const libraryService = {
        findAccessibleLibraryIds: vi.fn().mockResolvedValue([1]),
        findAll: vi.fn().mockResolvedValue([{ id: 1, name: 'Fiction', folders: [{ path: '/virtual/library' }] }]),
      };
      const service = new LibraryIntegrityService({ removeDuplicateFormatFile } as never, libraryService as never, { get: () => undefined } as never);
      const realpathSpy = vi.mocked(fs.realpath);
      const unlinkSpy = vi.mocked(fs.unlink);

      try {
        await expect(service.cleanupDuplicateFormatFile({ id: 7 } as never, 102)).rejects.toMatchObject({ status: 404 });
        expect(realpathSpy).not.toHaveBeenCalled();
        expect(unlinkSpy).not.toHaveBeenCalled();
      } finally {
        realpathSpy.mockReset();
        unlinkSpy.mockReset();
      }
    });
  });

  describe('cleanupEmptyBookFolder', () => {
    function createService(accessibleLibraryIds = [1]) {
      const libraryService = {
        findAccessibleLibraryIds: vi.fn().mockResolvedValue(accessibleLibraryIds),
        findAll: vi.fn().mockResolvedValue([{ id: 1, name: 'Fiction', folders: [{ path: '/virtual/library' }] }]),
      };
      return new LibraryIntegrityService({} as never, libraryService as never, { get: () => undefined } as never);
    }

    it('removes one untracked empty directory beneath an accessible library root', async () => {
      const fs = await import('node:fs/promises');
      const service = createService();
      const realpathSpy = vi.mocked(fs.realpath).mockImplementation((path) => Promise.resolve(String(path)));
      const lstatSpy = vi.mocked(fs.lstat).mockResolvedValue({ isDirectory: () => true, isSymbolicLink: () => false } as never);
      const readdirSpy = vi.mocked(fs.readdir).mockResolvedValue([] as never);
      const rmdirSpy = vi.mocked(fs.rmdir).mockResolvedValue(undefined);

      try {
        await expect(service.cleanupEmptyBookFolder({ id: 7 } as never, 1, '/virtual/library/untracked-empty')).resolves.toEqual({ removed: true });
        expect(lstatSpy).toHaveBeenCalledWith('/virtual/library/untracked-empty');
        expect(readdirSpy).toHaveBeenCalledWith('/virtual/library/untracked-empty');
        expect(rmdirSpy).toHaveBeenCalledWith('/virtual/library/untracked-empty');
      } finally {
        realpathSpy.mockReset();
        lstatSpy.mockReset();
        readdirSpy.mockReset();
        rmdirSpy.mockReset();
      }
    });

    it('rejects the configured root and paths outside it before filesystem access', async () => {
      const fs = await import('node:fs/promises');
      const service = createService();
      const realpathSpy = vi.mocked(fs.realpath);

      try {
        await expect(service.cleanupEmptyBookFolder({ id: 7 } as never, 1, '/virtual/library')).rejects.toMatchObject({ status: 404 });
        await expect(service.cleanupEmptyBookFolder({ id: 7 } as never, 1, '/virtual/library-backup/empty')).rejects.toMatchObject({ status: 404 });
        expect(realpathSpy).not.toHaveBeenCalled();
      } finally {
        realpathSpy.mockReset();
      }
    });

    it('rejects inaccessible libraries without touching the filesystem', async () => {
      const fs = await import('node:fs/promises');
      const service = createService([]);
      const realpathSpy = vi.mocked(fs.realpath);

      try {
        await expect(service.cleanupEmptyBookFolder({ id: 7 } as never, 1, '/virtual/library/empty')).rejects.toMatchObject({ status: 404 });
        expect(realpathSpy).not.toHaveBeenCalled();
      } finally {
        realpathSpy.mockReset();
      }
    });

    it('rejects a directory that became non-empty and never calls rmdir', async () => {
      const fs = await import('node:fs/promises');
      const service = createService();
      const realpathSpy = vi.mocked(fs.realpath).mockImplementation((path) => Promise.resolve(String(path)));
      const lstatSpy = vi.mocked(fs.lstat).mockResolvedValue({ isDirectory: () => true, isSymbolicLink: () => false } as never);
      const readdirSpy = vi.mocked(fs.readdir).mockResolvedValue(['new-file.epub'] as never);
      const rmdirSpy = vi.mocked(fs.rmdir);

      try {
        await expect(service.cleanupEmptyBookFolder({ id: 7 } as never, 1, '/virtual/library/changed')).rejects.toMatchObject({ status: 409 });
        expect(rmdirSpy).not.toHaveBeenCalled();
      } finally {
        realpathSpy.mockReset();
        lstatSpy.mockReset();
        readdirSpy.mockReset();
        rmdirSpy.mockReset();
      }
    });

    it('rejects symlink targets and real paths that escape the library root', async () => {
      const fs = await import('node:fs/promises');
      const service = createService();
      const realpathSpy = vi
        .spyOn(fs, 'realpath')
        .mockImplementation((path) => Promise.resolve(String(path) === '/virtual/library/linked' ? '/outside/secret' : String(path)));
      const lstatSpy = vi.mocked(fs.lstat).mockResolvedValue({ isDirectory: () => true, isSymbolicLink: () => true } as never);
      const readdirSpy = vi.mocked(fs.readdir);
      const rmdirSpy = vi.mocked(fs.rmdir);

      try {
        await expect(service.cleanupEmptyBookFolder({ id: 7 } as never, 1, '/virtual/library/linked')).rejects.toMatchObject({ status: 404 });
        expect(lstatSpy).not.toHaveBeenCalled();

        realpathSpy.mockImplementation((path) => Promise.resolve(String(path)));
        await expect(service.cleanupEmptyBookFolder({ id: 7 } as never, 1, '/virtual/library/symlink')).rejects.toMatchObject({ status: 409 });
        expect(readdirSpy).not.toHaveBeenCalled();
        expect(rmdirSpy).not.toHaveBeenCalled();
      } finally {
        realpathSpy.mockReset();
        lstatSpy.mockReset();
        readdirSpy.mockReset();
        rmdirSpy.mockReset();
      }
    });
  });

  describe('cleanupOrphanedFile', () => {
    function createService() {
      const libraryService = {
        findAccessibleLibraryIds: vi.fn().mockResolvedValue([1]),
        findAll: vi.fn().mockResolvedValue([{ id: 1, name: 'Fiction', folders: [{ path: '/virtual/library' }] }]),
      };
      return new LibraryIntegrityService({} as never, libraryService as never, { get: () => undefined } as never);
    }

    it('removes a reviewed sidecar file from a folder without book formats', async () => {
      const fs = await import('node:fs/promises');
      const service = createService();
      const realpathSpy = vi.mocked(fs.realpath).mockImplementation((path) => Promise.resolve(String(path)));
      const lstatSpy = vi.mocked(fs.lstat).mockResolvedValue({ isFile: () => true, isSymbolicLink: () => false } as never);
      const readdirSpy = vi.mocked(fs.readdir).mockResolvedValue([
        { name: 'metadata.json', isFile: () => true },
        { name: 'cover.jpg', isFile: () => true },
      ] as never);
      const unlinkSpy = vi.mocked(fs.unlink).mockResolvedValue(undefined);

      try {
        await expect(service.cleanupOrphanedFile({ id: 7 } as never, 1, '/virtual/library/orphan/metadata.json')).resolves.toEqual({ removed: true });
        expect(unlinkSpy).toHaveBeenCalledWith('/virtual/library/orphan/metadata.json');
      } finally {
        realpathSpy.mockReset();
        lstatSpy.mockReset();
        readdirSpy.mockReset();
        unlinkSpy.mockReset();
      }
    });

    it('never removes book-format files or non-text sidecars from a valid book folder', async () => {
      const fs = await import('node:fs/promises');
      const service = createService();
      const realpathSpy = vi.mocked(fs.realpath).mockImplementation((path) => Promise.resolve(String(path)));
      const lstatSpy = vi.mocked(fs.lstat).mockResolvedValue({ isFile: () => true, isSymbolicLink: () => false } as never);
      const readdirSpy = vi.mocked(fs.readdir).mockResolvedValue([
        { name: 'book.epub', isFile: () => true },
        { name: 'metadata.json', isFile: () => true },
      ] as never);
      const unlinkSpy = vi.mocked(fs.unlink);

      try {
        await expect(service.cleanupOrphanedFile({ id: 7 } as never, 1, '/virtual/library/book.epub')).rejects.toMatchObject({ status: 409 });
        await expect(service.cleanupOrphanedFile({ id: 7 } as never, 1, '/virtual/library/metadata.json')).rejects.toMatchObject({ status: 409 });
        expect(unlinkSpy).not.toHaveBeenCalled();
      } finally {
        realpathSpy.mockReset();
        lstatSpy.mockReset();
        readdirSpy.mockReset();
        unlinkSpy.mockReset();
      }
    });
  });
});
