import type {
  DuplicateFormatPage,
  LibraryFilesystemFindingsResult,
  LibraryIntegrityScanStatus,
  SidecarFilePage,
  SimilarSeriesCandidatesResult,
} from '@bookorbit/types'

import { api } from '@/lib/api'

export async function getDuplicateFormatIssues(params: { page: number; pageSize: number }): Promise<DuplicateFormatPage> {
  const query = new URLSearchParams({ page: String(params.page), pageSize: String(params.pageSize) })
  const response = await api(`/api/v1/maintenance/library-integrity/duplicate-formats?${query.toString()}`)
  if (!response.ok) throw new Error('library_integrity_duplicate_formats_failed')
  return response.json() as Promise<DuplicateFormatPage>
}

export async function getSidecarFileIssues(params: { page: number; pageSize: number }): Promise<SidecarFilePage> {
  const query = new URLSearchParams({ page: String(params.page), pageSize: String(params.pageSize) })
  const response = await api(`/api/v1/maintenance/library-integrity/sidecar-files?${query.toString()}`)
  if (!response.ok) throw new Error('library_integrity_sidecar_files_failed')
  return response.json() as Promise<SidecarFilePage>
}

export type SeriesMergeError = Error & { status: number; body: Record<string, unknown> }

export async function getSimilarSeriesCandidates(): Promise<SimilarSeriesCandidatesResult> {
  const response = await api('/api/v1/maintenance/library-integrity/series-name-candidates')
  if (!response.ok) throw new Error('library_integrity_series_candidates_failed')
  return response.json() as Promise<SimilarSeriesCandidatesResult>
}

export async function mergeSimilarSeries(params: {
  targetSeriesId: number
  sourceSeriesIds: number[]
  confirmPositionConflicts: boolean
}): Promise<void> {
  const response = await api('/api/v1/maintenance/library-integrity/series-name-merge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  })
  if (!response.ok) {
    const error = new Error('library_integrity_series_merge_failed') as SeriesMergeError
    error.status = response.status
    error.body = (await response.json().catch(() => ({}))) as Record<string, unknown>
    throw error
  }
}

export async function getLibraryIntegrityScanStatus(): Promise<LibraryIntegrityScanStatus | null> {
  const response = await api('/api/v1/maintenance/library-integrity/scan-status')
  if (!response.ok) throw new Error('library_integrity_scan_status_failed')
  return response.json() as Promise<LibraryIntegrityScanStatus | null>
}

export async function startLibraryIntegrityScan(): Promise<LibraryIntegrityScanStatus | null> {
  const response = await api('/api/v1/maintenance/library-integrity/scan-now', { method: 'POST' })
  if (!response.ok) throw new Error('library_integrity_scan_start_failed')
  return response.json() as Promise<LibraryIntegrityScanStatus | null>
}

export async function getLibraryFilesystemFindings(params: {
  page: number
  pageSize: number
  snapshotId?: string
}): Promise<LibraryFilesystemFindingsResult> {
  const query = new URLSearchParams({ page: String(params.page), pageSize: String(params.pageSize) })
  if (params.snapshotId) query.set('snapshotId', params.snapshotId)
  const response = await api(`/api/v1/maintenance/library-integrity/filesystem-findings?${query.toString()}`)
  if (!response.ok) throw new Error('library_integrity_filesystem_findings_failed')
  return response.json() as Promise<LibraryFilesystemFindingsResult>
}

export async function cleanupEmptyBookFolder(params: { libraryId: number; path: string }): Promise<void> {
  const response = await api('/api/v1/maintenance/library-integrity/filesystem-findings/cleanup-empty-folder', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  })
  if (!response.ok) throw new Error('library_integrity_empty_folder_cleanup_failed')
}

export async function cleanupOrphanedFile(params: { libraryId: number; path: string }): Promise<void> {
  const response = await api('/api/v1/maintenance/library-integrity/filesystem-findings/cleanup-orphaned-file', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  })
  if (!response.ok) throw new Error('library_integrity_orphaned_file_cleanup_failed')
}
