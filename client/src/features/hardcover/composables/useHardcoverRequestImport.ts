import { computed, ref } from 'vue'
import type {
  BookRequestAvailability,
  BookRequestAvailabilityQuery,
  BookRequestMediaKind,
  BookRequestSubmitResult,
  CreateBookRequestPayload,
  HardcoverImportPreviewRow,
} from '@bookorbit/types'
import { api } from '@/lib/api'

const REQUEST_MEDIA_KINDS: readonly BookRequestMediaKind[] = ['ebook', 'audiobook']
const MAX_SELECTED_REQUESTS = 50

interface AvailabilityEntry {
  key: string
  row: HardcoverImportPreviewRow
  mediaKind: BookRequestMediaKind
  query: BookRequestAvailabilityQuery
}

interface RequestImportResult {
  created: number
  joined: number
  skipped: number
}

export function useHardcoverRequestImport() {
  const availability = ref<Record<string, BookRequestAvailability>>({})
  const selectedKeys = ref<Set<string>>(new Set())
  const checking = ref(false)
  const availabilityError = ref<string | null>(null)
  const submitting = ref(false)
  const result = ref<RequestImportResult | null>(null)
  const error = ref<string | null>(null)
  const retryVersion = ref(0)
  const selectedCount = computed(() => selectedKeys.value.size)
  let availabilityGeneration = 0

  function rowIdentity(row: HardcoverImportPreviewRow): string {
    return row.hardcoverListBookId != null ? `list:${row.hardcoverListBookId}` : `user:${row.hardcoverUserBookId}`
  }

  function keyFor(row: HardcoverImportPreviewRow, mediaKind: BookRequestMediaKind): string {
    return `${rowIdentity(row)}:${mediaKind}`
  }

  function buildEntry(row: HardcoverImportPreviewRow, mediaKind: BookRequestMediaKind): AvailabilityEntry {
    return {
      key: keyFor(row, mediaKind),
      row,
      mediaKind,
      query: {
        title: row.hardcoverTitle ?? '',
        author: row.hardcoverAuthors[0],
        isbn13: row.hardcoverIsbn13,
        providerKey: 'hardcover',
        providerId: String(row.hardcoverBookId),
        mediaKind,
      },
    }
  }

  async function lookup(entries: AvailabilityEntry[]): Promise<BookRequestAvailability[]> {
    const results: BookRequestAvailability[] = []
    for (let offset = 0; offset < entries.length; offset += MAX_SELECTED_REQUESTS) {
      const batch = entries.slice(offset, offset + MAX_SELECTED_REQUESTS)
      const response = await api('/api/v1/book-requests/availability', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: batch.map((entry) => entry.query) }),
      })
      if (!response.ok) {
        const body = await response.json().catch(() => ({}))
        throw new Error((body as { message?: string }).message ?? 'availability')
      }
      const values = (await response.json()) as BookRequestAvailability[]
      if (values.length !== batch.length) throw new Error('availability')
      results.push(...values)
    }
    return results
  }

  async function loadAvailability(rows: HardcoverImportPreviewRow[]): Promise<void> {
    const generation = ++availabilityGeneration
    availabilityError.value = null
    if (rows.length === 0) {
      checking.value = false
      return
    }

    const entries = rows.flatMap((row) => REQUEST_MEDIA_KINDS.map((mediaKind) => buildEntry(row, mediaKind)))
    checking.value = true
    try {
      const values = await lookup(entries)
      if (generation !== availabilityGeneration) return
      const next = { ...availability.value }
      entries.forEach((entry, index) => {
        next[entry.key] = values[index]!
      })
      availability.value = next

      const nextSelected = new Set(selectedKeys.value)
      for (const entry of entries) {
        const current = next[entry.key]!
        if (current.ownedBookId != null || current.existingRequestId != null) nextSelected.delete(entry.key)
      }
      selectedKeys.value = nextSelected
    } catch (err) {
      if (generation === availabilityGeneration) {
        availabilityError.value = err instanceof Error && err.message !== 'availability' ? err.message : 'availability'
      }
    } finally {
      if (generation === availabilityGeneration) checking.value = false
    }
  }

  function isRequestable(row: HardcoverImportPreviewRow, mediaKind: BookRequestMediaKind): boolean {
    const current = availability.value[keyFor(row, mediaKind)]
    return current != null && current.ownedBookId == null && current.existingRequestId == null
  }

  function availabilityStatus(row: HardcoverImportPreviewRow, mediaKind: BookRequestMediaKind): 'owned' | 'requested' | null {
    const current = availability.value[keyFor(row, mediaKind)]
    if (current?.ownedBookId != null) return 'owned'
    if (current?.existingRequestId != null) return 'requested'
    return null
  }

  function retryAvailability(): void {
    retryVersion.value++
  }

  function toggleSelection(event: Event): void {
    const target = event.target
    if (!(target instanceof HTMLInputElement)) return
    const [source, id, mediaKind] = target.value.split(':')
    const userBookId = Number(id)
    if (
      !Number.isInteger(userBookId) ||
      source == null ||
      !['list', 'user'].includes(source) ||
      mediaKind == null ||
      !REQUEST_MEDIA_KINDS.includes(mediaKind as BookRequestMediaKind)
    )
      return

    const key = `${source}:${userBookId}:${mediaKind}`
    const next = new Set(selectedKeys.value)
    const current = availability.value[key]
    if (target.checked) {
      if (next.size >= MAX_SELECTED_REQUESTS || current?.ownedBookId != null || current?.existingRequestId != null) return
      next.add(key)
    } else {
      next.delete(key)
    }
    selectedKeys.value = next
    result.value = null
    error.value = null
  }

  function selectMissing(rows: HardcoverImportPreviewRow[]): void {
    const next = new Set(selectedKeys.value)
    for (const row of rows) {
      for (const mediaKind of REQUEST_MEDIA_KINDS) {
        const key = keyFor(row, mediaKind)
        if (isRequestable(row, mediaKind) && next.size < MAX_SELECTED_REQUESTS) next.add(key)
      }
    }
    selectedKeys.value = next
    result.value = null
  }

  function clearSelection(rows: HardcoverImportPreviewRow[]): void {
    const next = new Set(selectedKeys.value)
    for (const row of rows) {
      for (const mediaKind of REQUEST_MEDIA_KINDS) next.delete(keyFor(row, mediaKind))
    }
    selectedKeys.value = next
    result.value = null
  }

  function requestPayload(
    row: HardcoverImportPreviewRow,
    mediaKind: BookRequestMediaKind,
    destination?: { libraryId: number | null; folderId: number | null },
  ): CreateBookRequestPayload {
    return {
      title: row.hardcoverTitle ?? '',
      mediaKind,
      authors: row.hardcoverAuthors,
      isbn10: row.hardcoverIsbn10,
      isbn13: row.hardcoverIsbn13,
      providerKey: 'hardcover',
      providerId: String(row.hardcoverBookId),
      ...(destination?.libraryId != null ? { targetLibraryId: destination.libraryId } : {}),
      ...(destination?.folderId != null ? { targetFolderId: destination.folderId } : {}),
    }
  }

  async function submit(
    rows: HardcoverImportPreviewRow[],
    getDestination?: (mediaKind: BookRequestMediaKind) => { libraryId: number | null; folderId: number | null },
  ): Promise<void> {
    if (submitting.value || selectedKeys.value.size === 0) return
    submitting.value = true
    error.value = null
    result.value = null

    const rowsById = new Map(rows.map((row) => [rowIdentity(row), row]))
    const entries = [...selectedKeys.value].flatMap((key) => {
      const [source, id, mediaKind] = key.split(':')
      const row = rowsById.get(`${source}:${id}`)
      if (!row || !REQUEST_MEDIA_KINDS.includes(mediaKind as BookRequestMediaKind)) return []
      return [buildEntry(row, mediaKind as BookRequestMediaKind)]
    })

    try {
      const currentAvailability = await lookup(entries)
      const toSubmit = entries.filter((entry, index) => {
        const current = currentAvailability[index]!
        availability.value[entry.key] = current
        return current.ownedBookId == null && current.existingRequestId == null
      })
      const skipped = entries.length - toSubmit.length
      let created = 0
      let joined = 0
      const completed = new Set<string>()

      for (const entry of toSubmit) {
        try {
          const response = await api('/api/v1/book-requests', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestPayload(entry.row, entry.mediaKind, getDestination?.(entry.mediaKind))),
          })
          if (!response.ok) {
            const body = await response.json().catch(() => ({}))
            error.value ??= (body as { message?: string }).message ?? 'submit'
            continue
          }
          const submitted = (await response.json()) as BookRequestSubmitResult
          if (submitted.subscribed) joined++
          else created++
          completed.add(entry.key)
          availability.value[entry.key] = {
            ownedBookId: null,
            existingRequestId: submitted.request.id,
            existingRequestStatus: submitted.request.status,
            alreadySubscribed: true,
          }
        } catch (err) {
          error.value ??= err instanceof Error ? err.message : 'submit'
        }
      }

      const next = new Set(selectedKeys.value)
      for (const entry of entries) {
        if (completed.has(entry.key) || !toSubmit.some((candidate) => candidate.key === entry.key)) next.delete(entry.key)
      }
      selectedKeys.value = next
      result.value = { created, joined, skipped }
    } catch (err) {
      error.value = err instanceof Error && err.message !== 'availability' ? err.message : 'availability'
    } finally {
      submitting.value = false
    }
  }

  function reset(): void {
    availabilityGeneration++
    availability.value = {}
    selectedKeys.value = new Set()
    checking.value = false
    availabilityError.value = null
    result.value = null
    error.value = null
  }

  return {
    availability,
    selectedKeys,
    checking,
    availabilityError,
    submitting,
    result,
    error,
    retryVersion,
    selectedCount,
    maxSelected: MAX_SELECTED_REQUESTS,
    keyFor,
    isRequestable,
    availabilityStatus,
    loadAvailability,
    retryAvailability,
    toggleSelection,
    selectMissing,
    clearSelection,
    submit,
    reset,
  }
}
