import { beforeEach, describe, expect, it, vi } from 'vitest'

import { api } from '@/lib/api'
import { getBookMergeCandidates, mergeBooks } from './book-merge'

vi.mock('@/lib/api', () => ({ api: vi.fn<(...args: unknown[]) => unknown>() }))

describe('book merge API', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset()
  })

  it('sends bounded candidate requests with optional library scope and cursor', async () => {
    vi.mocked(api).mockResolvedValue(new Response(JSON.stringify({ candidates: [], nextCursor: null }), { status: 200 }))

    await getBookMergeCandidates({ libraryId: 3, similarityPercent: 85, cursor: { bookIdA: 12, bookIdB: 18 } })

    expect(api).toHaveBeenCalledWith(
      '/api/v1/books/merge-candidates',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ libraryId: 3, similarityPercent: 85, cursorBookIdA: 12, cursorBookIdB: 18 }),
      }),
    )
  })

  it('sends the selected keeper and source book to the merge route', async () => {
    vi.mocked(api).mockResolvedValue(new Response(JSON.stringify({ merged: 1, targetBookId: 12 }), { status: 200 }))

    await expect(mergeBooks([18], 12)).resolves.toEqual({ merged: 1, targetBookId: 12 })

    expect(api).toHaveBeenCalledWith(
      '/api/v1/books/merge',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ sourceBookIds: [18], targetBookId: 12 }) }),
    )
  })

  it('rejects unsuccessful requests', async () => {
    vi.mocked(api).mockResolvedValue(new Response(null, { status: 500 }))

    await expect(getBookMergeCandidates({ similarityPercent: 85 })).rejects.toThrow('book_merge_candidates_failed')
    await expect(mergeBooks([18], 12)).rejects.toThrow('book_merge_failed')
  })
})
