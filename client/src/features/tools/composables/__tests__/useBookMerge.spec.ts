import { defineComponent, h } from 'vue'
import { mount } from '@vue/test-utils'
import type { BookMergeCandidatePair, BookMergeCandidatePage } from '@bookorbit/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { getBookMergeCandidates, mergeBooks } from '../../api/book-merge'
import { useBookMerge } from '../useBookMerge'

vi.mock('../../api/book-merge', () => ({
  getBookMergeCandidates: vi.fn<(...args: unknown[]) => unknown>(),
  mergeBooks: vi.fn<(...args: unknown[]) => unknown>(),
}))
vi.mock('vue-sonner', () => ({
  toast: {
    success: vi.fn<(...args: unknown[]) => void>(),
    error: vi.fn<(...args: unknown[]) => void>(),
  },
}))

const candidate: BookMergeCandidatePair = {
  bookIdA: 12,
  bookIdB: 18,
  titleSimilarity: 0.92,
  books: [
    { id: 12, title: 'The Book', authors: ['A Writer'], formats: ['epub'], folderPath: 'ebooks/book', libraryName: 'Library' },
    { id: 18, title: 'The Book', authors: ['A Writer'], formats: ['m4b'], folderPath: 'audio/book', libraryName: 'Library' },
  ],
}

function mountComposable() {
  let mergeTool!: ReturnType<typeof useBookMerge>
  const wrapper = mount(
    defineComponent({
      setup() {
        mergeTool = useBookMerge()
        return () => h('div')
      },
    }),
  )
  return { mergeTool, wrapper }
}

describe('useBookMerge', () => {
  beforeEach(() => {
    vi.mocked(getBookMergeCandidates).mockReset()
    vi.mocked(mergeBooks).mockReset()
  })

  it('loads candidate pages with a cursor and appends the next page', async () => {
    const nextCursor = { bookIdA: 12, bookIdB: 18 }
    vi.mocked(getBookMergeCandidates)
      .mockResolvedValueOnce({ candidates: [candidate], nextCursor })
      .mockResolvedValueOnce({ candidates: [{ ...candidate, bookIdA: 19, bookIdB: 22 }], nextCursor: null } satisfies BookMergeCandidatePage)
    const { mergeTool } = mountComposable()

    await mergeTool.loadCandidates(3, 85)
    await mergeTool.loadMore()

    expect(getBookMergeCandidates).toHaveBeenNthCalledWith(1, { libraryId: 3, similarityPercent: 85 })
    expect(getBookMergeCandidates).toHaveBeenNthCalledWith(2, { libraryId: 3, similarityPercent: 85, cursor: nextCursor })
    expect(mergeTool.candidates.value).toHaveLength(2)
    expect(mergeTool.nextCursor.value).toBeNull()
  })

  it('merges the unselected book into the chosen target and removes that pair', async () => {
    vi.mocked(getBookMergeCandidates).mockResolvedValue({ candidates: [candidate], nextCursor: null })
    vi.mocked(mergeBooks).mockResolvedValue({ merged: 1, targetBookId: 12 })
    const { mergeTool } = mountComposable()
    await mergeTool.loadCandidates(undefined, 85)

    await expect(mergeTool.merge(candidate, 12)).resolves.toBe(true)

    expect(mergeBooks).toHaveBeenCalledWith([18], 12)
    expect(mergeTool.candidates.value).toEqual([])
  })
})
