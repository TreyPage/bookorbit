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

  async function loadCandidates(nextLibraryId: number | undefined, nextSimilarityPercent: number): Promise<void> {
    libraryId = nextLibraryId
    similarityPercent = nextSimilarityPercent
    candidates.value = []
    nextCursor.value = null
    loaded.value = false
    error.value = null
    loading.value = true
    try {
      const response = await getBookMergeCandidates({ libraryId, similarityPercent })
      candidates.value = response.candidates
      nextCursor.value = response.nextCursor
      loaded.value = true
    } catch {
      error.value = t('tools.bookMerge.errors.candidates')
    } finally {
      loading.value = false
    }
  }

  async function loadMore(): Promise<void> {
    if (!nextCursor.value || loading.value || merging.value) return
    loading.value = true
    error.value = null
    try {
      const response = await getBookMergeCandidates({ libraryId, similarityPercent, cursor: nextCursor.value })
      candidates.value = [...candidates.value, ...response.candidates]
      nextCursor.value = response.nextCursor
    } catch {
      error.value = t('tools.bookMerge.errors.candidates')
    } finally {
      loading.value = false
    }
  }

  async function merge(pair: BookMergeCandidatePair, targetBookId: number): Promise<boolean> {
    const sourceBookId = pair.books.find((book) => book.id !== targetBookId)?.id
    if (sourceBookId === undefined) {
      error.value = t('tools.bookMerge.errors.merge')
      return false
    }
    merging.value = true
    error.value = null
    try {
      await mergeBooks([sourceBookId], targetBookId)
      candidates.value = candidates.value.filter((candidate) => candidate.bookIdA !== pair.bookIdA || candidate.bookIdB !== pair.bookIdB)
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

  return { candidates, nextCursor, loading, merging, loaded, error, loadCandidates, loadMore, merge }
}
