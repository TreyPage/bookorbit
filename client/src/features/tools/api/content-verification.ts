import { api } from '@/lib/api'

export type ContentVerificationStatus = 'match' | 'mismatch' | 'inconclusive' | 'error'
export type ContentVerificationReviewStatus = 'confirmed_mismatch' | 'false_positive' | 'needs_recheck'
export type ContentVerificationFilter = 'all' | 'needs_review' | 'reviewed' | 'mismatch'

export interface ContentVerificationEvidence {
  label: string
  text: string
}

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
  evidence: ContentVerificationEvidence[] | null
  reviewStatus: ContentVerificationReviewStatus | null
  reviewNote: string | null
  reviewedAt: string | null
  reviewedBy: number | null
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

export async function getContentVerificationPage(params: {
  page: number
  pageSize: number
  filter: ContentVerificationFilter
}): Promise<ContentVerificationPage> {
  const query = new URLSearchParams({ page: String(params.page), pageSize: String(params.pageSize), filter: params.filter })
  const response = await api(`/api/v1/maintenance/content-verification?${query.toString()}`)
  if (!response.ok) throw new Error('content_verification_list_failed')
  return response.json() as Promise<ContentVerificationPage>
}

export async function verifyBookFileContent(fileId: number): Promise<void> {
  const response = await api(`/api/v1/maintenance/content-verification/${fileId}/verify`, { method: 'POST' })
  if (!response.ok) throw new Error('content_verification_failed')
}

export async function reviewBookFileContent(
  fileId: number,
  reviewStatus: ContentVerificationReviewStatus,
  reviewNote?: string,
): Promise<ContentVerificationEntry> {
  const response = await api(`/api/v1/maintenance/content-verification/${fileId}/review`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reviewStatus, reviewNote }),
  })
  if (!response.ok) {
    let message = 'content_verification_review_failed'
    try {
      const body = (await response.json()) as { message?: string | string[] }
      if (typeof body.message === 'string') message = body.message
      else if (Array.isArray(body.message)) message = body.message.join(', ')
    } catch {
      // Keep the stable fallback when the server does not return a JSON error body.
    }
    throw new Error(message)
  }
  return response.json() as Promise<ContentVerificationEntry>
}

export interface ContentVerificationJobStatus {
  status: 'idle' | 'running' | 'waiting_for_provider'
  processed: number
  matches: number
  mismatches: number
  inconclusive: number
  errors: number
  lastRunAt: string | null
  lastError: string | null
}

export async function getContentVerificationJobStatus(): Promise<ContentVerificationJobStatus> {
  const response = await api('/api/v1/maintenance/content-verification/background/status')
  if (!response.ok) throw new Error('content_verification_status_failed')
  return response.json() as Promise<ContentVerificationJobStatus>
}

export async function startContentVerificationBatch(): Promise<ContentVerificationJobStatus> {
  const response = await api('/api/v1/maintenance/content-verification/background/run', { method: 'POST' })
  if (!response.ok) throw new Error('content_verification_start_failed')
  return response.json() as Promise<ContentVerificationJobStatus>
}
