import type { BookMergeCandidateCursor, BookMergeCandidatePage } from '@bookorbit/types'

import { api } from '@/lib/api'

export interface BookMergeCandidatesRequest {
  libraryId?: number
  similarityPercent: number
  cursor?: BookMergeCandidateCursor
}

async function expectJson<T>(response: Response, fallbackMessage: string): Promise<T> {
  if (!response.ok) throw new Error(fallbackMessage)
  return response.json() as Promise<T>
}

export async function getBookMergeCandidates(payload: BookMergeCandidatesRequest): Promise<BookMergeCandidatePage> {
  const { cursor, ...filters } = payload
  const response = await api('/api/v1/books/merge-candidates', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...filters,
      ...(cursor ? { cursorBookIdA: cursor.bookIdA, cursorBookIdB: cursor.bookIdB } : {}),
    }),
  })
  return expectJson(response, 'book_merge_candidates_failed')
}

export async function mergeBooks(sourceBookIds: number[], targetBookId: number): Promise<{ merged: number; targetBookId: number }> {
  const response = await api('/api/v1/books/merge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sourceBookIds, targetBookId }),
  })
  return expectJson(response, 'book_merge_failed')
}
