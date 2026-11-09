import { api } from '@/lib/api'

export type ContentVerificationStatus = 'match' | 'mismatch' | 'inconclusive' | 'error'

export interface ContentVerificationEntry {
  fileId: number
  bookId: number
  title: string | null
  format: string | null
  fileHash: string | null
  status: ContentVerificationStatus | null
  source: 'ebook' | 'audiobook' | null
  detectedTitle: string | null
  detectedAuthor: string | null
  confidence: number | null
  explanation: string | null
  verifiedAt: string | null
  stale: boolean
}

export interface ContentVerificationPage {
  items: ContentVerificationEntry[]
  total: number
  page: number
  pageSize: number
  totalPages: number
}

export async function getContentVerificationPage(params: { page: number; pageSize: number }): Promise<ContentVerificationPage> {
  const query = new URLSearchParams({ page: String(params.page), pageSize: String(params.pageSize) })
  const response = await api(`/api/v1/maintenance/content-verification?${query.toString()}`)
  if (!response.ok) throw new Error('content_verification_list_failed')
  return response.json() as Promise<ContentVerificationPage>
}

export async function verifyBookFileContent(fileId: number): Promise<void> {
  const response = await api(`/api/v1/maintenance/content-verification/${fileId}/verify`, { method: 'POST' })
  if (!response.ok) throw new Error('content_verification_failed')
}
