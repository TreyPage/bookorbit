import { api } from '@/lib/api'

export async function refetchBookDockMetadata(fileId: number): Promise<boolean> {
  const response = await api(`/api/v1/book-dock/files/${fileId}/refetch-metadata`, {
    method: 'POST',
  })
  return response.ok
}

export interface BookDockContentVerificationResult {
  status: 'match' | 'mismatch' | 'inconclusive'
  source: 'ebook' | 'audiobook'
  expectedTitle: string
  expectedAuthors: string[]
  detectedTitle: string | null
  detectedAuthor: string | null
  confidence: number
  explanation: string
  evidence: Array<{ label: string; text: string }>
  model: string
  verifiedAt: string
  persisted: false
}

export async function verifyBookDockContent(fileId: number): Promise<BookDockContentVerificationResult> {
  const response = await api(`/api/v1/book-dock/files/${fileId}/verify-content`, { method: 'POST' })
  if (!response.ok) {
    let message = 'Book Dock content verification failed'
    try {
      const body = (await response.json()) as { message?: string | string[] }
      if (typeof body.message === 'string') message = body.message
      else if (Array.isArray(body.message)) message = body.message.join(', ')
    } catch {
      // Keep the stable fallback when the server does not return a JSON error body.
    }
    throw new Error(message)
  }
  return response.json() as Promise<BookDockContentVerificationResult>
}
