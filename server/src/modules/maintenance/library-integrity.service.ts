import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { lstat, readdir, realpath, rmdir, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { DuplicateFormatGroup, DuplicateFormatPage, LibraryFilesystemFinding, LibraryFilesystemFindingsResult, SidecarFileEntry, SidecarFilePage, SimilarSeriesCandidatesResult } from '@bookorbit/types';

import type { RequestUser } from '../../common/types/request-user';
import type { LibraryIntegrityScanSummary } from '@bookorbit/types';
import { readCoverDirBookIds, measureCoverDir } from './lib/cover-disk';
import { LibraryService } from '../library/library.service';
import { LibraryIntegrityRepository } from './library-integrity.repository';

@Injectable()
export class LibraryIntegrityService {
  constructor(
    private readonly repo: LibraryIntegrityRepository,
    private readonly libraryService: LibraryService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Read-only scheduled integrity pass. Detailed findings remain available through the
   * paginated integrity endpoints; this pass records a bounded summary for operators.
   */
  async scanAllLibraries(): Promise<LibraryIntegrityScanSummary> {
    const systemUser = { id: 0, isSuperuser: true, contentFilters: {} } as RequestUser;
    const libraryIds = await this.libraryService.findAccessibleLibraryIds(systemUser);
    const sidecars = await this.listSidecarFiles(systemUser, 1, 1);
    const filesystem = await this.scanFilesystemAnomalies(systemUser, libraryIds);

    const pageSize = 100;
    let duplicateFormatGroups = 0;
    let duplicateFormatFiles = 0;
    let page = 1;
    let totalPages = 1;

    while (page <= totalPages) {
      const result = await this.listDuplicateFormats(systemUser, page, pageSize);
      duplicateFormatGroups = result.total;
      duplicateFormatFiles += result.items.reduce((total, group) => total + group.fileCount, 0);
      totalPages = Math.max(1, Math.ceil(result.total / pageSize));
      page += 1;
    }

    return {
      libraryCount: libraryIds.length,
      duplicateFormatGroups,
      duplicateFormatFiles,
      sidecarEntries: sidecars.total,
      sidecarScanTruncated: sidecars.truncated,
      orphanedMetadataFiles: filesystem.orphanedMetadataFiles,
      emptyBookFolders: filesystem.emptyBookFolders,
      orphanedCoverDirectories: filesystem.orphanedCoverDirectories,
      orphanedCoverBytes: filesystem.orphanedCoverBytes,
      filesystemScanTruncated: filesystem.truncated,
      unreadableDirectories: filesystem.unreadableDirectories,
    };
  }


  /**
   * Read-only filesystem checks. Metadata is considered orphaned when its containing
   * directory is not a known book folder; every empty subdirectory beneath a
   * configured library root is reported, regardless of database ownership.
   */
  private async scanFilesystemAnomalies(systemUser: RequestUser, libraryIds: number[]) {
    const libraries = await this.libraryService.findAll(systemUser);
    const knownFolderPaths = new Set(
      (await this.repo.findBookFolderPaths(libraryIds)).map((path) => resolve(path)),
    );
    const visitedRoots = new Set<string>();
    let orphanedMetadataFiles = 0;
    let emptyBookFolders = 0;
    let scannedEntries = 0;
    let truncated = false;
    let unreadableDirectories = 0;

    const inspect = async (directory: string, depth: number): Promise<void> => {
      if (depth > 40 || truncated) {
        truncated = true;
        return;
      }
      let children;
      try {
        children = await readdir(directory, { withFileTypes: true });
      } catch {
        unreadableDirectories += 1;
        return;
      }
      if (depth > 0 && children.length === 0) emptyBookFolders += 1;

      for (const child of children) {
        if (child.isSymbolicLink()) continue;
        scannedEntries += 1;
        if (scannedEntries > 100_000) {
          truncated = true;
          return;
        }
        if (child.isDirectory()) {
          await inspect(resolve(directory, child.name), depth + 1);
          if (truncated) return;
        } else if (child.isFile() && child.name.toLowerCase() === 'metadata.json') {
          if (!knownFolderPaths.has(resolve(directory))) orphanedMetadataFiles += 1;
        }
      }
    };

    for (const library of libraries) {
      if (!libraryIds.includes(library.id)) continue;
      for (const folder of library.folders) {
        const root = resolve(folder.path);
        if (visitedRoots.has(root)) continue;
        visitedRoots.add(root);
        await inspect(root, 0);
        if (truncated) break;
      }
      if (truncated) break;
    }

    const appDataPath = this.config.get<string>('storage.appDataPath');
    let orphanedCoverDirectories = 0;
    let orphanedCoverBytes = 0;
    if (appDataPath) {
      const coversRoot = join(appDataPath, 'covers');
      const diskIds = [...(await readCoverDirBookIds(coversRoot))];
      for (let index = 0; index < diskIds.length; index += 500) {
        const batch = diskIds.slice(index, index + 500);
        const existing = new Set(await this.repo.findExistingBookIds(batch));
        for (const id of batch.filter((bookId) => !existing.has(bookId))) {
          const measured = await measureCoverDir(coversRoot, id);
          orphanedCoverDirectories += 1;
          orphanedCoverBytes += measured.sizeBytes;
        }
      }
    }

    return { orphanedMetadataFiles, emptyBookFolders, orphanedCoverDirectories, orphanedCoverBytes, truncated, unreadableDirectories };
  }


  /**
   * Returns bounded, user-scoped details for the two filesystem findings that can
   * be safely classified against known book-folder paths. This endpoint never mutates files.
   */
  async listFilesystemFindings(user: RequestUser): Promise<LibraryFilesystemFindingsResult> {
    const libraryIds = await this.libraryService.findAccessibleLibraryIds(user);
    if (libraryIds.length === 0) {
      return {
        orphanedMetadataFiles: { items: [], total: 0 },
        emptyBookFolders: { items: [], total: 0 },
        truncated: false,
        resultsTruncated: false,
        unreadableDirectories: { items: [], total: 0 },
      };
    }

    const libraries = await this.libraryService.findAll(user);
    const knownFolderPaths = new Set((await this.repo.findBookFolderPaths(libraryIds)).map((path) => resolve(path)));
    const orphanedMetadataFiles: LibraryFilesystemFinding[] = [];
    const emptyBookFolders: LibraryFilesystemFinding[] = [];
    const unreadableDirectories: LibraryFilesystemFinding[] = [];
    const maxResults = 500;
    let orphanedMetadataTotal = 0;
    let emptyFolderTotal = 0;
    let unreadableDirectoryTotal = 0;
    let scannedEntries = 0;
    let truncated = false;
    const visitedRoots = new Set<string>();

    const inspect = async (directory: string, libraryId: number, libraryName: string, depth: number): Promise<void> => {
      if (depth > 40 || truncated) {
        truncated = true;
        return;
      }
      let children;
      try {
        children = await readdir(directory, { withFileTypes: true });
      } catch {
        unreadableDirectoryTotal += 1;
        if (unreadableDirectories.length < maxResults) unreadableDirectories.push({ libraryId, libraryName, path: resolve(directory) });
        return;
      }

      if (depth > 0 && children.length === 0) {
        emptyFolderTotal += 1;
        if (emptyBookFolders.length < maxResults) emptyBookFolders.push({ libraryId, libraryName, path: resolve(directory) });
      }

      for (const child of children) {
        if (child.isSymbolicLink()) continue;
        scannedEntries += 1;
        if (scannedEntries > 100_000) {
          truncated = true;
          return;
        }
        const childPath = resolve(directory, child.name);
        if (child.isDirectory()) {
          await inspect(childPath, libraryId, libraryName, depth + 1);
          if (truncated) return;
        } else if (child.isFile() && child.name.toLowerCase() === 'metadata.json' && !knownFolderPaths.has(resolve(directory))) {
          orphanedMetadataTotal += 1;
          if (orphanedMetadataFiles.length < maxResults) orphanedMetadataFiles.push({ libraryId, libraryName, path: childPath });
        }
      }
    };

    for (const library of libraries) {
      if (!libraryIds.includes(library.id)) continue;
      for (const folder of library.folders) {
        const root = resolve(folder.path);
        if (visitedRoots.has(root)) continue;
        visitedRoots.add(root);
        await inspect(root, library.id, library.name, 0);
        if (truncated) break;
      }
      if (truncated) break;
    }

    const sort = (a: LibraryFilesystemFinding, b: LibraryFilesystemFinding) =>
      a.libraryName.localeCompare(b.libraryName) || a.path.localeCompare(b.path);
    orphanedMetadataFiles.sort(sort);
    emptyBookFolders.sort(sort);
    unreadableDirectories.sort(sort);
    return {
      orphanedMetadataFiles: { items: orphanedMetadataFiles, total: orphanedMetadataTotal },
      emptyBookFolders: { items: emptyBookFolders, total: emptyFolderTotal },
      unreadableDirectories: { items: unreadableDirectories, total: unreadableDirectoryTotal },
      truncated,
      resultsTruncated: orphanedMetadataTotal > maxResults || emptyFolderTotal > maxResults || unreadableDirectoryTotal > maxResults,
    };
  }

  /** Remove one currently empty directory beneath an accessible library root after re-validating disk state. */
  async cleanupEmptyBookFolder(user: RequestUser, libraryId: number, folderPath: string): Promise<{ removed: boolean }> {
    const libraryIds = await this.libraryService.findAccessibleLibraryIds(user);
    if (!libraryIds.includes(libraryId)) throw new NotFoundException('Book folder not found or not accessible');

    const libraries = await this.libraryService.findAll(user);
    const library = libraries.find((item) => item.id === libraryId);
    if (!library) throw new NotFoundException('Book folder not found or not accessible');

    const target = resolve(folderPath);
    const roots = library.folders.map((folder) => resolve(folder.path));
    const containingRoot = roots.find((root) => {
      const rel = relative(root, target);
      return rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel));
    });
    if (!containingRoot || containingRoot === target) throw new NotFoundException('Directory is outside the accessible library roots or is a configured library root');

    try {
      const [realRoot, realTarget] = await Promise.all([realpath(containingRoot), realpath(target)]);
      const realRelative = relative(realRoot, realTarget);
      if (realRelative === '' || realRelative === '..' || realRelative.startsWith('..' + sep) || isAbsolute(realRelative)) {
        throw new NotFoundException('Directory is outside the accessible library roots');
      }
      const info = await lstat(target);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new ConflictException('Directory is no longer a regular directory');
      const children = await readdir(target);
      if (children.length !== 0) throw new ConflictException('Directory is no longer empty');
      await rmdir(target);
      return { removed: true };
    } catch (error) {
      if (error instanceof NotFoundException || error instanceof ConflictException) throw error;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTEMPTY' || (error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new ConflictException('Directory changed before cleanup; refresh findings and try again');
      }
      throw error;
    }
  }

  async listSidecarFiles(user: RequestUser, page: number, pageSize: number): Promise<SidecarFilePage> {
    const libraries = await this.libraryService.findAll(user);
    const entries: SidecarFileEntry[] = [];
    const visitedRoots = new Set<string>();
    const maxEntries = 100_000;
    let scannedEntries = 0;
    let truncated = false;

    const inspect = async (directory: string, libraryId: number, libraryName: string, depth: number): Promise<void> => {
      if (depth > 40 || truncated) return;
      let children;
      try {
        children = await readdir(directory, { withFileTypes: true });
      } catch {
        return;
      }

      for (const child of children) {
        if (truncated) return;
        scannedEntries += 1;
        if (scannedEntries > maxEntries) {
          truncated = true;
          return;
        }

        const absolutePath = resolve(directory, child.name);
        // Do not follow symbolic links: a library may contain links outside its configured roots.
        if (child.isSymbolicLink()) continue;

        if (child.isDirectory()) {
          if (child.name.toLowerCase() === '.chaptarr-conversions') {
            let sizeBytes = 0;
            let fileCount = 0;
            const measure = async (path: string, level: number): Promise<void> => {
              if (level > 20) return;
              let nested;
              try {
                nested = await readdir(path, { withFileTypes: true });
              } catch {
                return;
              }
              for (const item of nested) {
                if (item.isSymbolicLink()) continue;
                const itemPath = join(path, item.name);
                if (item.isDirectory()) await measure(itemPath, level + 1);
                else if (item.isFile()) {
                  fileCount += 1;
                  try {
                    sizeBytes += (await stat(itemPath)).size;
                  } catch {
                    /* file disappeared during scan */
                  }
                }
              }
            };
            await measure(absolutePath, 0);
            entries.push({ libraryId, libraryName, path: absolutePath, kind: 'conversion_directory', sizeBytes, fileCount });
            continue;
          }
          await inspect(absolutePath, libraryId, libraryName, depth + 1);
          continue;
        }

        if (!child.isFile()) continue;
        const lowerName = child.name.toLowerCase();
        let kind: SidecarFileEntry['kind'] | null = null;
        if (lowerName.endsWith('.txt')) kind = 'text_file';
        else if (/\.(tmp|temp|part|crdownload|download)$/.test(lowerName)) kind = 'temporary_file';
        if (!kind) continue;

        try {
          const info = await stat(absolutePath);
          entries.push({ libraryId, libraryName, path: absolutePath, kind, sizeBytes: info.size, fileCount: 1 });
        } catch {
          // A file can disappear while the read-only scan is running.
        }
      }
    };

    for (const library of libraries) {
      for (const folder of library.folders) {
        const root = resolve(folder.path);
        if (visitedRoots.has(root)) continue;
        visitedRoots.add(root);
        await inspect(root, library.id, library.name, 0);
        if (truncated) break;
      }
      if (truncated) break;
    }

    entries.sort((a, b) => a.libraryName.localeCompare(b.libraryName) || a.path.localeCompare(b.path));
    const offset = (page - 1) * pageSize;
    return { items: entries.slice(offset, offset + pageSize), total: entries.length, page, pageSize, truncated };
  }

  async listDuplicateFormats(user: RequestUser, page: number, pageSize: number): Promise<DuplicateFormatPage> {
    const libraryIds = await this.libraryService.findAccessibleLibraryIds(user);
    if (libraryIds.length === 0) {
      return { items: [], total: 0, page, pageSize };
    }

    const result = await this.repo.findDuplicateFormatGroups(libraryIds, (page - 1) * pageSize, pageSize);

    return {
      items: result.items.map((item) => ({
        bookId: item.bookId,
        title: item.title,
        libraryId: item.libraryId,
        libraryName: item.libraryName,
        folderPath: item.folderPath,
        format: item.format,
        fileCount: item.fileCount,
        files: item.files,
      })) as DuplicateFormatGroup[],
      total: result.total,
      page,
      pageSize,
    };
  }
  async listSimilarSeries(user: RequestUser): Promise<SimilarSeriesCandidatesResult> {
    const libraryIds = await this.libraryService.findAccessibleLibraryIds(user);
    if (libraryIds.length === 0) return { items: [], truncated: false };
    return this.repo.findSimilarSeriesPairs(libraryIds);
  }
  async mergeSeries(user: RequestUser, dto: { targetSeriesId: number; sourceSeriesIds: number[]; confirmPositionConflicts: boolean }) {
    if (dto.sourceSeriesIds.includes(dto.targetSeriesId)) {
      throw new BadRequestException('Target series cannot also be a source series');
    }
    const libraryIds = await this.libraryService.findAccessibleLibraryIds(user);
    const result = await this.repo.mergeSeries(libraryIds, dto.targetSeriesId, dto.sourceSeriesIds, dto.confirmPositionConflicts);
    switch (result.status) {
      case 'merged':
        return result;
      case 'position_conflicts':
        throw new ConflictException({ code: 'series_position_conflicts', conflicts: result.conflicts });
      case 'inaccessible_books':
        throw new ConflictException({ code: 'series_has_inaccessible_books', inaccessibleBookCount: result.inaccessibleBookCount });
      case 'invalid_request':
        throw new BadRequestException('At least one source series is required and the target cannot be a source');
      default:
        throw new NotFoundException('Series not found or not accessible');
    }
  }
}
