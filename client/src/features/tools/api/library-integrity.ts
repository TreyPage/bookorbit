import type { DuplicateFormatPage } from '@bookorbit/types'

import { api } from '@/lib/api'

export async function getDuplicateFormatIssues(params: { page: number; pageSize: number }): Promise<DuplicateFormatPage> {
  const query = new URLSearchParams({ page: String(params.page), pageSize: String(params.pageSize) })
  const response = await api(`/api/v1/maintenance/library-integrity/duplicate-formats?${query.toString()}`)
  if (!response.ok) throw new Error('library_integrity_duplicate_formats_failed')
  return response.json() as Promise<DuplicateFormatPage>
}


export type SidecarFileEntry = {
  libraryId: number;
  libraryName: string;
  path: string;
  kind: 'text_file' | 'temporary_file' | 'conversion_directory';
  sizeBytes: number;
  fileCount: number;
};

export type SidecarFilePage = {
  items: SidecarFileEntry[];
  total: number;
  page: number;
  pageSize: number;
  truncated: boolean;
};

export async function getSidecarFileIssues(params: { page: number; pageSize: number }): Promise<SidecarFilePage> {
  const query = new URLSearchParams({ page: String(params.page), pageSize: String(params.pageSize) });
  const response = await api(`/api/v1/maintenance/library-integrity/sidecar-files?${query.toString()}`);
  if (!response.ok) throw new Error('library_integrity_sidecar_files_failed');
  return response.json() as Promise<SidecarFilePage>;
}
