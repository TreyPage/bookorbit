export type DuplicateFormatFile = {
  id: number;
  absolutePath: string;
  sizeBytes: number | null;
  fileHash: string | null;
};

export type DuplicateFormatGroup = {
  bookId: number;
  title: string | null;
  libraryId: number;
  libraryName: string;
  folderPath: string;
  /** Normalized lowercase file format, such as "epub" or "m4b". */
  format: string;
  fileCount: number;
  files: DuplicateFormatFile[];
};

export type DuplicateFormatPage = {
  items: DuplicateFormatGroup[];
  total: number;
  page: number;
  pageSize: number;
};

import type { CoverMedium } from "./book";

export const MISSING_RESOURCE_CATEGORIES = ["missing_books", "broken_covers", "orphaned_cover_dirs"] as const;
export type MissingResourceCleanupCategory = (typeof MISSING_RESOURCE_CATEGORIES)[number];
export const MISSING_RESOURCE_VIEW_CATEGORIES = [...MISSING_RESOURCE_CATEGORIES, "sidecar_files"] as const;
export type MissingResourceCategory = (typeof MISSING_RESOURCE_VIEW_CATEGORIES)[number];

export const COVER_SWEEP_STATUSES = ["running", "completed", "failed"] as const;
export type CoverSweepStatus = (typeof COVER_SWEEP_STATUSES)[number];

export type CoverSweep = {
  status: CoverSweepStatus;
  processedBooks: number;
  totalBooks: number | null;
  progressPercent: number | null;
  brokenCovers: number;
  orphanedCoverDirs: number;
  orphanedBytes: number;
  /** True when either result list hit the retention cap; the counts still reflect everything found. */
  truncated: boolean;
  errorCode: string | null;
  startedAt: string;
  completedAt: string | null;
};

export type MissingResourcesSummary = {
  missingBooks: number;
  sweep: CoverSweep | null;
};

export type MissingBookEntry = {
  id: number;
  title: string | null;
  authors: string[];
  libraryId: number;
  libraryName: string;
  folderPath: string;
  formats: string[];
  updatedAt: string | null;
};

export type BrokenCoverSlot = {
  medium: CoverMedium;
  source: "extracted" | "custom";
};

export type BrokenCoverEntry = {
  id: number;
  title: string | null;
  authors: string[];
  libraryId: number;
  libraryName: string;
  coverSource: "extracted" | "custom";
  /** The slots whose image is gone. Empty for a cover the upgrade has not moved into a slot yet. */
  slots: BrokenCoverSlot[];
};

export type OrphanedCoverDirEntry = {
  bookId: number;
  fileCount: number;
  sizeBytes: number;
  /** The slot folders it holds. Empty for a folder from before covers had slots. */
  media: CoverMedium[];
};

export type MissingResourcePage<TEntry> = {
  items: TEntry[];
  total: number;
  page: number;
  pageSize: number;
};

export type MissingResourceCleanupRequest = {
  bookIds?: number[];
  all?: boolean;
};

export type MissingResourceCleanupResult = {
  category: MissingResourceCleanupCategory;
  requested: number;
  cleaned: number;
  /** Entries that no longer qualified when the cleanup re-verified them. */
  skipped: number;
  /** Entries still matching after this pass. Cleaning "all" works in bounded passes; repeat until zero. */
  remaining: number;
};

export type SidecarFileKind = "text_file" | "temporary_file" | "conversion_directory";

export type SidecarFileEntry = {
  libraryId: number;
  libraryName: string;
  path: string;
  kind: SidecarFileKind;
  sizeBytes: number;
  fileCount: number;
};

export type SidecarFilePage = {
  items: SidecarFileEntry[];
  total: number;
  page: number;
  pageSize: number;
  /** True when the scan reached its safety cap before every folder was visited. */
  truncated: boolean;
};

export type SeriesNameCandidate = {
  id: number;
  name: string;
  bookCount: number;
  inaccessibleBookCount: number;
};

export type SimilarSeriesPair = {
  left: SeriesNameCandidate;
  right: SeriesNameCandidate;
  similarity: number;
  /** False when either series also contains books in libraries outside the current user's access. */
  mergeAllowed: boolean;
};

export type IgnoredSeries = { id: number; name: string; bookCount: number };

export type SimilarSeriesCandidatesResult = {
  items: SimilarSeriesPair[];
  ignoredSeries?: IgnoredSeries[];
  truncated: boolean;
};

/** Summary from the most recent scheduled, read-only library integrity pass. */
export type LibraryIntegrityScanSummary = {
  libraryCount: number;
  duplicateFormatGroups: number;
  duplicateFormatFiles: number;
  sidecarEntries: number;
  sidecarScanTruncated: boolean;
  orphanedMetadataFiles: number;
  orphanedBookFolders: number;
  orphanedFiles: number;
  emptyBookFolders: number;
  orphanedCoverDirectories: number;
  orphanedCoverBytes: number;
  filesystemScanTruncated: boolean;
  unreadableDirectories: number;
};

export type LibraryIntegrityScanStatus = {
  status: "running" | "completed" | "failed";
  startedAt: string;
  completedAt: string | null;
  summary: LibraryIntegrityScanSummary | null;
  errorMessage: string | null;
};

export type LibraryFilesystemFinding = {
  libraryId: number;
  libraryName: string;
  path: string;
};

export type LibraryFilesystemFindingsResult = {
  orphanedMetadataFiles: { items: LibraryFilesystemFinding[]; total: number };
  orphanedBookFolders: { items: LibraryFilesystemFinding[]; total: number };
  orphanedFiles: { items: Array<LibraryFilesystemFinding & { reason: "folder_without_format" | "text_file" }>; total: number };
  emptyBookFolders: { items: LibraryFilesystemFinding[]; total: number };
  unreadableDirectories: { items: LibraryFilesystemFinding[]; total: number };
  truncated: boolean;
  hasMore: boolean;
  page: number;
  pageSize: number;
  /** Opaque, short-lived token used to keep subsequent pages on the same filesystem scan. */
  snapshotId?: string;
};
