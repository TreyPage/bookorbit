import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import type { BookMergeCandidateCursor, BookMergeCandidatePair } from '@bookorbit/types'

import { getBookMergeCandidates, mergeBooks } from '../api/book-merge'

export function useBookMerge() {
  const { t } = useI18n()

  const candidates = ref<BookMergeCandidatePair[]>([])
  const nextCursor = ref<BookMergeCandidateCursor | null>(null)
  const loading = ref(false)
  const merging = ref(false)
  const loaded = ref(false)
  const error = ref<string | null>(null)

  let libraryId: number | undefined
  let similarityPercent = 85
  let requestGeneration = 0

  async function loadCandidates(nextLibraryId: number | undefined, nextSimilarityPercent: number): Promise<void> {
    if (merging.value) return

    const generation = ++requestGeneration

    libraryId = nextLibraryId
    similarityPercent = nextSimilarityPercent

    candidates.value = []
    nextCursor.value = null
    loaded.value = false
    error.value = null
    loading.value = true

    try {
      const response = await getBookMergeCandidates({
        libraryId,
        similarityPercent,
      })

      // Ignore responses belonging to an older search.
      if (generation !== requestGeneration) return

      candidates.value = response.candidates
      nextCursor.value = response.nextCursor
      loaded.value = true
    } catch {
      if (generation !== requestGeneration) return
      error.value = t('tools.bookMerge.errors.candidates')
    } finally {
      if (generation === requestGeneration) {
        loading.value = false
      }
    }
  }

  async function loadMore(): Promise<void> {
    const cursor = nextCursor.value

    if (!cursor || loading.value || merging.value) return

    const generation = requestGeneration

    loading.value = true
    error.value = null

    try {
      const response = await getBookMergeCandidates({
        libraryId,
        similarityPercent,
        cursor,
      })

      // A new search or merge may have invalidated this page.
      if (generation !== requestGeneration) return

      const existingPairs = new Set(candidates.value.map((candidate) => `${candidate.bookIdA}:${candidate.bookIdB}`))

      const newCandidates = response.candidates.filter((candidate) => {
        const key = `${candidate.bookIdA}:${candidate.bookIdB}`

        if (existingPairs.has(key)) return false

        existingPairs.add(key)
        return true
      })

      candidates.value = [...candidates.value, ...newCandidates]
      nextCursor.value = response.nextCursor
    } catch {
      if (generation !== requestGeneration) return
      error.value = t('tools.bookMerge.errors.candidates')
    } finally {
      if (generation === requestGeneration) {
        loading.value = false
      }
    }
  }

  async function merge(pair: BookMergeCandidatePair, targetBookId: number): Promise<boolean> {
    if (loading.value || merging.value) return false

    // The target must actually belong to this candidate pair.
    const targetExists = pair.books.some((book) => book.id === targetBookId)

    if (!targetExists || pair.books.length !== 2) {
      error.value = t('tools.bookMerge.errors.merge')
      toast.error(t('tools.bookMerge.errors.merge'))
      return false
    }

    const sourceBookIds = pair.books.filter((book) => book.id !== targetBookId).map((book) => book.id)

    if (sourceBookIds.length !== 1) {
      error.value = t('tools.bookMerge.errors.merge')
      toast.error(t('tools.bookMerge.errors.merge'))
      return false
    }

    const sourceBookId = sourceBookIds[0]

    merging.value = true
    error.value = null

    try {
      await mergeBooks(sourceBookIds, targetBookId)

      // Invalidate any outstanding requests.
      requestGeneration++

      // Remove every candidate involving either affected book.
      // Their metadata and format composition may have changed.
      const affectedBookIds = new Set([sourceBookId, targetBookId])

      candidates.value = candidates.value.filter((candidate) => !candidate.books.some((book) => affectedBookIds.has(book.id)))

      toast.success(t('tools.bookMerge.success'))
      return true
    } catch {
      error.value = t('tools.bookMerge.errors.merge')
      toast.error(t('tools.bookMerge.errors.merge'))
      return false
    } finally {
      merging.value = false
    }
  }

  return {
    candidates,
    nextCursor,
    loading,
    merging,
    loaded,
    error,
    loadCandidates,
    loadMore,
    merge,
  }
}
