import { Injectable } from '@nestjs/common';
import { readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { DuplicateFormatGroup, DuplicateFormatPage, SidecarFileEntry, SidecarFilePage, SimilarSeriesCandidatesResult } from '@bookorbit/types';

import type { RequestUser } from '../../common/types/request-user';
import { LibraryService } from '../library/library.service';
import { LibraryIntegrityRepository } from './library-integrity.repository';

@Injectable()
export class LibraryIntegrityService {
  constructor(
    private readonly repo: LibraryIntegrityRepository,
    private readonly libraryService: LibraryService,
  ) {}

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
              try { nested = await readdir(path, { withFileTypes: true }); } catch { return; }
              for (const item of nested) {
                if (item.isSymbolicLink()) continue;
                const itemPath = join(path, item.name);
                if (item.isDirectory()) await measure(itemPath, level + 1);
                else if (item.isFile()) {
                  fileCount += 1;
                  try { sizeBytes += (await stat(itemPath)).size; } catch { /* file disappeared during scan */ }
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
}
