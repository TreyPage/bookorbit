import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { lstat, readdir, realpath, rmdir, stat, unlink } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isBookFormat } from '@bookorbit/types';
import type { DuplicateFormatGroup, DuplicateFormatPage, LibraryFilesystemFinding, LibraryFilesystemFindingsResult, SidecarFileEntry, SidecarFilePage, SimilarSeriesCandidatesResult } from '@bookorbit/types';

import type { RequestUser } from '../../common/types/request-user';
import type { LibraryIntegrityScanSummary } from '@bookorbit/types';
import { readCoverDirBookIds, measureCoverDir } from './lib/cover-disk';
import { LibraryService } from '../library/library.service';
import { LibraryIntegrityRepository } from './library-integrity.repository';

@Injectable()
export class LibraryIntegrityService {
  private readonly filesystemFindingsSnapshots = new Map<string, { userId: number; expiresAt: number; result: LibraryFilesystemFindingsResult }>();
  private readonly filesystemFindingsSnapshotTtlMs = 10 * 60 * 1000;
  private readonly filesystemFindingsSnapshotLimit = 5;
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
      orphanedBookFolders: filesystem.orphanedBookFolders,
      orphanedFiles: filesystem.orphanedFiles,
      emptyBookFolders: filesystem.emptyBookFolders,
      orphanedCoverDirectories: filesystem.orphanedCoverDirectories,
      orphanedCoverBytes: filesystem.orphanedCoverBytes,
      filesystemScanTruncated: filesystem.truncated,
      unreadableDirectories: filesystem.unreadableDirectories,
    };
  }


  /**
   * Read-only filesystem checks. Non-empty subdirectories with files but no recognized
   * book formats are orphaned regardless of database ownership. Text files are also
   * reported inside otherwise valid book folders; empty subdirectories are separate findings.
   */
  private async scanFilesystemAnomalies(systemUser: RequestUser, libraryIds: number[]) {
    const libraries = await this.libraryService.findAll(systemUser);
    const knownFolderPaths = new Set(
      (await this.repo.findBookFolderPaths(libraryIds)).map((path) => resolve(path)),
    );
    const visitedRoots = new Set<string>();
    let orphanedMetadataFiles = 0;
    let orphanedBookFolders = 0;
    let orphanedFiles = 0;
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
      const directFiles = children.filter((child) => child.isFile());
      const hasBookFormat = directFiles.some((child) => isBookFormat(extname(child.name).slice(1)));
      if (depth > 0 && directFiles.length > 0 && !hasBookFormat) {
        orphanedBookFolders += 1;
        orphanedFiles += directFiles.length;
      }

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
        } else if (child.isFile()) {
          const lowerName = child.name.toLowerCase();
          if (lowerName === 'metadata.json' && !knownFolderPaths.has(resolve(directory))) orphanedMetadataFiles += 1;
          if (lowerName.endsWith('.txt') && hasBookFormat) orphanedFiles += 1;
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

    return { orphanedMetadataFiles, orphanedBookFolders, orphanedFiles, emptyBookFolders, orphanedCoverDirectories, orphanedCoverBytes, truncated, unreadableDirectories };
  }


  /**
   * Returns bounded, user-scoped filesystem findings. This endpoint never mutates files.
   */
  async listFilesystemFindings(user: RequestUser, page = 1, pageSize = 50, snapshotId?: string): Promise<LibraryFilesystemFindingsResult> {
    this.pruneFilesystemFindingsSnapshots();
    if (snapshotId) {
      const cached = this.filesystemFindingsSnapshots.get(snapshotId);
      if (cached && cached.userId === user.id && cached.expiresAt > Date.now()) return this.paginateFilesystemFindings(cached.result, page, pageSize, snapshotId);
      page = 1;
    }
    const offset = (page - 1) * pageSize;
    const libraryIds = await this.libraryService.findAccessibleLibraryIds(user);
    if (libraryIds.length === 0) {
      const empty = { orphanedMetadataFiles: { items: [], total: 0 }, orphanedBookFolders: { items: [], total: 0 }, orphanedFiles: { items: [], total: 0 }, emptyBookFolders: { items: [], total: 0 }, unreadableDirectories: { items: [], total: 0 }, truncated: false, hasMore: false, page: 1, pageSize: 0 } satisfies LibraryFilesystemFindingsResult;
      return this.storeFilesystemFindingsSnapshot(user.id, empty, pageSize);
    }

    const libraries = await this.libraryService.findAll(user);
    const knownFolderPaths = new Set((await this.repo.findBookFolderPaths(libraryIds)).map((path) => resolve(path)));
    const orphanedMetadataFiles: LibraryFilesystemFinding[] = [];
    const orphanedBookFolders: LibraryFilesystemFinding[] = [];
    const orphanedFiles: Array<LibraryFilesystemFinding & { reason: 'folder_without_format' | 'text_file' }> = [];
    const emptyBookFolders: LibraryFilesystemFinding[] = [];
    const unreadableDirectories: LibraryFilesystemFinding[] = [];
    let orphanedMetadataTotal = 0;
    let orphanedBookFolderTotal = 0;
    let orphanedFileTotal = 0;
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
        unreadableDirectories.push({ libraryId, libraryName, path: resolve(directory) });
        return;
      }

      if (depth > 0 && children.length === 0) {
        emptyFolderTotal += 1;
        emptyBookFolders.push({ libraryId, libraryName, path: resolve(directory) });
      }
      const directFiles = children.filter((child) => child.isFile());
      const hasBookFormat = directFiles.some((child) => isBookFormat(extname(child.name).slice(1)));
      const filesWithoutFormat = depth > 0 && directFiles.length > 0 && !hasBookFormat;
      if (filesWithoutFormat) {
        orphanedBookFolderTotal += 1;
        orphanedBookFolders.push({ libraryId, libraryName, path: resolve(directory) });
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
        } else if (child.isFile()) {
          const lowerName = child.name.toLowerCase();
          if (lowerName === 'metadata.json' && !knownFolderPaths.has(resolve(directory))) {
            orphanedMetadataTotal += 1;
            orphanedMetadataFiles.push({ libraryId, libraryName, path: childPath });
          }
          const reason = filesWithoutFormat ? 'folder_without_format' : lowerName.endsWith('.txt') ? 'text_file' : null;
          if (reason) {
            orphanedFileTotal += 1;
            orphanedFiles.push({ libraryId, libraryName, path: childPath, reason });
          }
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
    orphanedBookFolders.sort(sort);
    orphanedFiles.sort(sort);
    emptyBookFolders.sort(sort);
    unreadableDirectories.sort(sort);
    const snapshot = { orphanedMetadataFiles: { items: orphanedMetadataFiles, total: orphanedMetadataTotal }, orphanedBookFolders: { items: orphanedBookFolders, total: orphanedBookFolderTotal }, orphanedFiles: { items: orphanedFiles, total: orphanedFileTotal }, emptyBookFolders: { items: emptyBookFolders, total: emptyFolderTotal }, unreadableDirectories: { items: unreadableDirectories, total: unreadableDirectoryTotal }, truncated, hasMore: false, page: 1, pageSize: 0 } satisfies LibraryFilesystemFindingsResult;
    return this.storeFilesystemFindingsSnapshot(user.id, snapshot, pageSize);
  }

  private pruneFilesystemFindingsSnapshots(): void {
    const now = Date.now();
    for (const [id, snapshot] of this.filesystemFindingsSnapshots) if (snapshot.expiresAt <= now) this.filesystemFindingsSnapshots.delete(id);
  }

  private storeFilesystemFindingsSnapshot(userId: number, result: LibraryFilesystemFindingsResult, pageSize: number): LibraryFilesystemFindingsResult {
    this.pruneFilesystemFindingsSnapshots();
    while (this.filesystemFindingsSnapshots.size >= this.filesystemFindingsSnapshotLimit) {
      const oldest = this.filesystemFindingsSnapshots.keys().next().value;
      if (!oldest) break;
      this.filesystemFindingsSnapshots.delete(oldest);
    }
    const snapshotId = randomUUID();
    this.filesystemFindingsSnapshots.set(snapshotId, { userId, expiresAt: Date.now() + this.filesystemFindingsSnapshotTtlMs, result });
    return this.paginateFilesystemFindings(result, 1, pageSize, snapshotId);
  }

  private paginateFilesystemFindings(snapshot: LibraryFilesystemFindingsResult, page: number, pageSize: number, snapshotId: string): LibraryFilesystemFindingsResult {
    const offset = (page - 1) * pageSize;
    const slice = <T>(items: T[]) => items.slice(offset, offset + pageSize);
    const totals = [snapshot.orphanedMetadataFiles.total, snapshot.orphanedBookFolders.total, snapshot.orphanedFiles.total, snapshot.emptyBookFolders.total, snapshot.unreadableDirectories.total];
    return {
      orphanedMetadataFiles: { ...snapshot.orphanedMetadataFiles, items: slice(snapshot.orphanedMetadataFiles.items) },
      orphanedBookFolders: { ...snapshot.orphanedBookFolders, items: slice(snapshot.orphanedBookFolders.items) },
      orphanedFiles: { ...snapshot.orphanedFiles, items: slice(snapshot.orphanedFiles.items) },
      emptyBookFolders: { ...snapshot.emptyBookFolders, items: slice(snapshot.emptyBookFolders.items) },
      unreadableDirectories: { ...snapshot.unreadableDirectories, items: slice(snapshot.unreadableDirectories.items) },
      truncated: snapshot.truncated, hasMore: totals.some((total) => total > offset + pageSize), page, pageSize, snapshotId,
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

  /** Delete one explicitly reviewed orphaned file after rechecking its classification and safe path. */
  async cleanupOrphanedFile(user: RequestUser, libraryId: number, filePath: string): Promise<{ removed: boolean }> {
    const libraryIds = await this.libraryService.findAccessibleLibraryIds(user);
    if (!libraryIds.includes(libraryId)) throw new NotFoundException('File not found or not accessible');
    const libraries = await this.libraryService.findAll(user);
    const library = libraries.find((item) => item.id === libraryId);
    if (!library) throw new NotFoundException('File not found or not accessible');
    const target = resolve(filePath);
    const roots = library.folders.map((folder) => resolve(folder.path));
    const containingRoot = roots.find((root) => {
      const rel = relative(root, target);
      return !rel.startsWith('..' + sep) && rel !== '..' && rel !== '' && !isAbsolute(rel);
    });
    if (!containingRoot) throw new NotFoundException('File is outside the accessible library roots');
    try {
      const [realRoot, realTarget] = await Promise.all([realpath(containingRoot), realpath(target)]);
      const realRelative = relative(realRoot, realTarget);
      if (realRelative === '..' || realRelative.startsWith('..' + sep) || realRelative === '' || isAbsolute(realRelative)) throw new NotFoundException('File is outside the accessible library roots');
      const info = await lstat(target);
      if (!info.isFile() || info.isSymbolicLink()) throw new ConflictException('File is no longer a regular file');
      if (isBookFormat(extname(target).slice(1))) throw new ConflictException('Book-format files cannot be removed as orphaned files');
      const siblings = await readdir(resolve(target, '..'), { withFileTypes: true });
      const hasBookFormat = siblings.some((entry) => entry.isFile() && isBookFormat(extname(entry.name).slice(1)));
      if (!target.toLowerCase().endsWith('.txt') && hasBookFormat) throw new ConflictException('File is no longer classified as orphaned');
      await unlink(target);
      return { removed: true };
    } catch (error) {
      if (error instanceof NotFoundException || error instanceof ConflictException) throw error;
      if (['ENOENT', 'EISDIR', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw new ConflictException('File changed before cleanup; refresh findings and try again');
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
        // Text files are reported by the Library Integrity orphaned-files scan.
        // Keep this legacy sidecar list focused on temporary files and conversion directories.
        if (/\.(tmp|temp|part|crdownload|download)$/.test(lowerName)) kind = 'temporary_file';
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
