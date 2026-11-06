import type { DuplicateFormatPage } from '@bookorbit/types'

import { api } from '@/lib/api'

export async function getDuplicateFormatIssues(params: { page: number; pageSize: number }): Promise<DuplicateFormatPage> {
  const query = new URLSearchParams({ page: String(params.page), pageSize: String(params.pageSize) })
  const response = await api(`/api/v1/maintenance/library-integrity/duplicate-formats?${query.toString()}`)
  if (!response.ok) throw new Error('library_integrity_duplicate_formats_failed')
  return response.json() as Promise<DuplicateFormatPage>
}
