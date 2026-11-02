<script setup lang="ts">
import { Button } from '@/components/ui/button'
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { CheckCircle2, ChevronLeft, ChevronRight, Download, Search, X, XCircle } from '@lucide/vue'
import type {
  BookRequestMediaKind,
  HardcoverImportMatchMethod,
  HardcoverImportPreview,
  HardcoverImportPreviewOutcome,
  HardcoverImportPreviewRow,
} from '@bookorbit/types'
import { useModal } from '@/composables/useModal'
import { useLibraries } from '@/features/library/composables/useLibraries'
import { useRequestDestinationDefault } from '@/features/book-requests/composables/useRequestDestinationDefault'
import { useHardcoverRequestImport } from '../composables/useHardcoverRequestImport'

const { t } = useI18n()

const props = withDefaults(
  defineProps<{
    preview: HardcoverImportPreview
    applying: boolean
    importProgress: boolean
    canRequestBooks?: boolean
    requiresRequestDestination?: boolean
  }>(),
  { canRequestBooks: false, requiresRequestDestination: false },
)

const emit = defineEmits<{
  close: []
  apply: [hardcoverUserBookIds: number[]]
  'update:importProgress': [value: boolean]
}>()

type OutcomeTab = HardcoverImportPreviewOutcome | 'all'
type MatchFilter = HardcoverImportMatchMethod | 'all'

const PAGE_SIZE = 50
const MAX_SELECTED_REQUESTS = 50
const REQUEST_MEDIA_KINDS: readonly BookRequestMediaKind[] = ['ebook', 'audiobook']

type RequestDestination = { libraryId: number | null; folderId: number | null }

const dialogRef = ref<HTMLElement | null>(null)
const closeButtonRef = ref<HTMLElement | null>(null)
const activeTab = ref<OutcomeTab>('will_update')
const matchFilter = ref<MatchFilter>('all')
const search = ref('')
const page = ref(1)
const selectedIds = ref<Set<number>>(new Set())
const requestImport = useHardcoverRequestImport()
const { libraries, fetchLibraries, error: libraryError } = useLibraries()
const { load: loadDestinationDefaults, defaultFor: instanceDefaultFor, resolveDestination } = useRequestDestinationDefault()
const requestDestinations = ref<Record<BookRequestMediaKind, RequestDestination>>({
  ebook: { libraryId: null, folderId: null },
  audiobook: { libraryId: null, folderId: null },
})
const destinationSetupLoading = ref(props.canRequestBooks)
const destinationSetupAttempted = ref(false)
const destinationDefaultsLoaded = ref(false)
const {
  selectedKeys: selectedRequestKeys,
  checking: requestAvailabilityLoading,
  availabilityError: requestAvailabilityError,
  submitting: requestSubmitting,
  result: requestResult,
  error: requestError,
  retryVersion: availabilityRetry,
  selectedCount: selectedRequestCount,
  keyFor: requestKey,
  isRequestable,
  availabilityStatus,
  loadAvailability: loadRequestAvailability,
  retryAvailability,
  toggleSelection: handleRequestToggle,
  selectMissing,
  clearSelection,
  submit: submitRequests,
  reset: resetRequestImport,
} = requestImport
const requestResultLabel = computed(() => (requestResult.value ? t('hardcover.review.requestResult', requestResult.value) : null))
const requestAvailabilityErrorLabel = computed(() =>
  requestAvailabilityError.value && requestAvailabilityError.value !== 'availability'
    ? requestAvailabilityError.value
    : t('hardcover.review.requestAvailabilityFailed'),
)
const requestErrorLabel = computed(() =>
  requestError.value && requestError.value !== 'submit' && requestError.value !== 'availability'
    ? requestError.value
    : t(requestError.value === 'availability' ? 'hardcover.review.requestAvailabilityFailed' : 'hardcover.review.requestSubmitFailed'),
)
const importProgressModel = computed({
  get: () => props.importProgress,
  set: (value: boolean) => emit('update:importProgress', value),
})

useModal({
  container: dialogRef,
  initialFocus: closeButtonRef,
  onClose: handleClose,
  disabled: () => props.applying || requestSubmitting.value,
})

const tabs = computed<Array<{ id: OutcomeTab; label: string; count: number }>>(() => [
  { id: 'all', label: t('hardcover.review.tabs.all'), count: props.preview.rows.length },
  { id: 'will_update', label: t('hardcover.review.tabs.ready'), count: props.preview.summary.willUpdate },
  { id: 'needs_review', label: t('hardcover.review.tabs.review'), count: props.preview.summary.needsReview },
  { id: 'conflict', label: t('hardcover.review.tabs.conflicts'), count: props.preview.summary.conflicts },
  { id: 'unmatched', label: t('hardcover.review.tabs.unmatched'), count: props.preview.summary.unmatched },
  { id: 'skipped', label: t('hardcover.review.tabs.skipped'), count: props.preview.summary.skipped },
])

const matchOptions = computed<Array<{ value: MatchFilter; label: string }>>(() => [
  { value: 'all', label: t('hardcover.review.matchOptions.all') },
  { value: 'hardcover_id', label: t('hardcover.review.matchMethod.hardcoverId') },
  { value: 'isbn', label: t('hardcover.review.matchMethod.isbn') },
  { value: 'title_author', label: t('hardcover.review.matchMethod.titleAuthor') },
])

const filteredRows = computed(() => {
  const term = normalizeSearch(search.value)
  return props.preview.rows.filter((row) => {
    if (activeTab.value !== 'all' && row.outcome !== activeTab.value) return false
    if (matchFilter.value !== 'all' && row.matchMethod !== matchFilter.value) return false
    if (!term) return true
    return normalizeSearch(
      [row.localTitle, row.hardcoverTitle, row.localAuthors.join(' '), row.hardcoverAuthors.join(' '), row.reason].join(' '),
    ).includes(term)
  })
})

const totalPages = computed(() => Math.max(1, Math.ceil(filteredRows.value.length / PAGE_SIZE)))
const pagedRows = computed(() => {
  const start = (page.value - 1) * PAGE_SIZE
  return filteredRows.value.slice(start, start + PAGE_SIZE)
})
const displayStart = computed(() => (filteredRows.value.length === 0 ? 0 : (page.value - 1) * PAGE_SIZE + 1))
const displayEnd = computed(() => Math.min(filteredRows.value.length, page.value * PAGE_SIZE))
const canGoPrevious = computed(() => page.value > 1)
const canGoNext = computed(() => page.value < totalPages.value)
const selectedCount = computed(() => selectedIds.value.size)
const selectedReadyCount = computed(
  () => props.preview.rows.filter((row) => row.outcome === 'will_update' && selectedIds.value.has(row.hardcoverUserBookId)).length,
)
const selectedReviewCount = computed(
  () => props.preview.rows.filter((row) => row.outcome === 'needs_review' && selectedIds.value.has(row.hardcoverUserBookId)).length,
)
const selectedProgressCount = computed(
  () => props.preview.rows.filter((row) => row.progressOutcome === 'will_update' && selectedIds.value.has(row.hardcoverUserBookId)).length,
)
const selectedProgressLabel = computed(() => t('hardcover.review.selectedProgress', { count: selectedProgressCount.value }))
const visibleImportableRows = computed(() => pagedRows.value.filter(isImportableRow))
const requestRows = computed(() => pagedRows.value.filter((row) => row.hardcoverTitle?.trim()))
const allVisibleSelected = computed(
  () => visibleImportableRows.value.length > 0 && visibleImportableRows.value.every((row) => selectedIds.value.has(row.hardcoverUserBookId)),
)
const visibleRequestableCount = computed(() =>
  requestRows.value.reduce((count, row) => count + REQUEST_MEDIA_KINDS.filter((mediaKind) => isRequestable(row, mediaKind)).length, 0),
)
const requestDestinationMissing = computed(
  () =>
    props.requiresRequestDestination &&
    [...selectedRequestKeys.value].some((key) => {
      const mediaKind = key.slice(key.lastIndexOf(':') + 1) as BookRequestMediaKind
      return requestDestinations.value[mediaKind].libraryId === null && instanceDefaultFor(mediaKind).libraryId === null
    }),
)
const destinationSetupError = computed(() => {
  if (!destinationSetupAttempted.value) return null
  if (libraryError.value !== null) return t('hardcover.review.requestDestinationSetupFailed')
  if (!destinationSetupLoading.value && !destinationDefaultsLoaded.value) return t('hardcover.review.requestDestinationSetupFailed')
  return null
})

watch(
  () => props.preview,
  () => {
    selectedIds.value = new Set(props.preview.rows.filter((row) => row.outcome === 'will_update').map((row) => row.hardcoverUserBookId))
    resetRequestImport()
    activeTab.value =
      props.preview.hardcoverListIds.length > 0
        ? 'all'
        : props.preview.summary.willUpdate > 0
          ? 'will_update'
          : props.preview.summary.needsReview > 0
            ? 'needs_review'
            : 'all'
    page.value = 1
  },
  { immediate: true },
)

onMounted(() => {
  if (props.canRequestBooks) void loadRequestDestinations()
})

watch(
  [() => props.preview, () => props.canRequestBooks, () => requestRows.value.map(requestRowKey).join(','), () => availabilityRetry.value],
  () => {
    if (props.canRequestBooks) void loadRequestAvailability(requestRows.value)
  },
  { immediate: true },
)

watch([activeTab, matchFilter, search], () => {
  page.value = 1
})

function handleClose(): void {
  if (!props.applying && !requestSubmitting.value) emit('close')
}

function setActiveTab(tab: OutcomeTab): void {
  activeTab.value = tab
}

function goPrevious(): void {
  if (canGoPrevious.value) page.value--
}

function goNext(): void {
  if (canGoNext.value) page.value++
}

function toggleRow(row: HardcoverImportPreviewRow): void {
  if (!isImportableRow(row)) return
  const next = new Set(selectedIds.value)
  if (next.has(row.hardcoverUserBookId)) next.delete(row.hardcoverUserBookId)
  else next.add(row.hardcoverUserBookId)
  selectedIds.value = next
}

function handleSelectSafe(): void {
  selectedIds.value = new Set(props.preview.rows.filter((row) => row.outcome === 'will_update').map((row) => row.hardcoverUserBookId))
}

function handleSelectVisible(): void {
  const next = new Set(selectedIds.value)
  for (const row of visibleImportableRows.value) next.add(row.hardcoverUserBookId)
  selectedIds.value = next
}

function handleClearVisible(): void {
  const next = new Set(selectedIds.value)
  for (const row of visibleImportableRows.value) next.delete(row.hardcoverUserBookId)
  selectedIds.value = next
}

function handleClearSelection(): void {
  selectedIds.value = new Set()
}

function handleApply(): void {
  emit('apply', [...selectedIds.value])
}

function availabilityLabel(row: HardcoverImportPreviewRow, mediaKind: BookRequestMediaKind): string | null {
  const status = availabilityStatus(row, mediaKind)
  const medium = t(`hardcover.review.media.${mediaKind}`)
  if (status === 'owned') return t('hardcover.review.requestOwned', { medium })
  if (status === 'requested') return t('hardcover.review.requestExists', { medium })
  return null
}

function handleRetryAvailability(): void {
  retryAvailability()
}

function handleSelectMissingPage(): void {
  selectMissing(requestRows.value)
}

function handleClearRequestsPage(): void {
  clearSelection(requestRows.value)
}

function handleSubmitRequests(): void {
  void submitRequests(props.preview.rows, requestDestinationFor)
}

async function loadRequestDestinations(): Promise<void> {
  destinationSetupLoading.value = true
  const [, defaultsLoaded] = await Promise.all([fetchLibraries(), loadDestinationDefaults()])
  destinationSetupAttempted.value = true
  destinationDefaultsLoaded.value = defaultsLoaded
  if (defaultsLoaded && libraryError.value === null) {
    const destination = resolveDestination(libraries.value, undefined, props.requiresRequestDestination)
    requestDestinations.value = { ebook: destination, audiobook: destination }
  }
  destinationSetupLoading.value = false
}

function handleRetryRequestDestination(): void {
  void loadRequestDestinations()
}

function requestDestinationFor(mediaKind: BookRequestMediaKind): RequestDestination {
  return requestDestinations.value[mediaKind]
}

function requestDestinationLabel(mediaKind: BookRequestMediaKind): string {
  const fallback = instanceDefaultFor(mediaKind)
  if (fallback.libraryName !== null) return t('bookRequests.search.libraryDefault', { library: fallback.libraryName })
  return props.requiresRequestDestination ? t('bookRequests.search.libraryChoose') : t('bookRequests.search.libraryAny')
}

function handleEbookDestinationChange(event: Event): void {
  updateRequestDestination('ebook', event)
}

function handleAudiobookDestinationChange(event: Event): void {
  updateRequestDestination('audiobook', event)
}

function updateRequestDestination(mediaKind: BookRequestMediaKind, event: Event): void {
  const target = event.target
  if (!(target instanceof HTMLSelectElement)) return
  const libraryId = target.value === '' ? null : Number(target.value)
  const selectedLibrary = libraries.value.find((library) => library.id === libraryId)
  requestDestinations.value = {
    ...requestDestinations.value,
    [mediaKind]: { libraryId, folderId: selectedLibrary?.folders[0]?.id ?? null },
  }
}

function requestRowKey(row: HardcoverImportPreviewRow): string {
  return row.hardcoverListBookId != null ? `list:${row.hardcoverListBookId}` : `user:${row.hardcoverUserBookId}`
}

function previewRowKey(row: HardcoverImportPreviewRow): string {
  return requestRowKey(row)
}

function isImportableRow(row: HardcoverImportPreviewRow): boolean {
  return row.outcome === 'will_update' || row.outcome === 'needs_review'
}

function rowTitle(row: HardcoverImportPreviewRow): string {
  return row.localTitle ?? row.hardcoverTitle ?? t('hardcover.review.untitled')
}

function rowSubtitle(row: HardcoverImportPreviewRow): string {
  const local = row.localAuthors.join(', ')
  const hardcover = row.hardcoverAuthors.join(', ')
  if (local && hardcover && local !== hardcover) return `${local} / ${hardcover}`
  return local || hardcover || row.reason
}

function matchMethodLabel(row: HardcoverImportPreviewRow): string {
  switch (row.matchMethod) {
    case 'hardcover_id':
      return t('hardcover.review.matchMethod.hardcoverId')
    case 'isbn':
      return t('hardcover.review.matchMethod.isbn')
    case 'title_author':
      return t('hardcover.review.matchMethod.titleAuthor')
    default:
      return '-'
  }
}

function statusLabel(row: HardcoverImportPreviewRow): string {
  return row.importedStatus?.replaceAll('_', ' ') ?? '-'
}

function localStatusLabel(row: HardcoverImportPreviewRow): string {
  return row.localReadStatus?.replaceAll('_', ' ') ?? t('hardcover.review.blank')
}

function confidenceLabel(row: HardcoverImportPreviewRow): string {
  return row.confidence == null ? '-' : `${row.confidence}%`
}

function progressLabel(value: number | null): string {
  if (value == null) return '-'
  return `${Number.isInteger(value) ? value : value.toFixed(1).replace(/\.0$/, '')}%`
}

function progressOutcomeLabel(row: HardcoverImportPreviewRow): string {
  switch (row.progressOutcome) {
    case 'will_update':
      return t('hardcover.review.outcome.ready')
    case 'conflict':
      return t('hardcover.review.outcome.conflict')
    case 'skipped':
      return t('hardcover.review.outcome.skipped')
  }
}

function progressOutcomeClass(row: HardcoverImportPreviewRow): string {
  switch (row.progressOutcome) {
    case 'will_update':
      return 'text-primary'
    case 'conflict':
      return 'text-destructive'
    case 'skipped':
      return 'text-muted-foreground'
  }
}

function outcomeLabel(row: HardcoverImportPreviewRow): string {
  switch (row.outcome) {
    case 'will_update':
      return t('hardcover.review.outcome.ready')
    case 'needs_review':
      return t('hardcover.review.outcome.review')
    case 'conflict':
      return t('hardcover.review.outcome.conflict')
    case 'unmatched':
      return t('hardcover.review.outcome.unmatched')
    case 'skipped':
      return t('hardcover.review.outcome.skipped')
  }
}

function outcomeClass(row: HardcoverImportPreviewRow): string {
  switch (row.outcome) {
    case 'will_update':
      return 'text-primary'
    case 'needs_review':
      return 'text-foreground'
    case 'conflict':
      return 'text-destructive'
    case 'unmatched':
    case 'skipped':
      return 'text-muted-foreground'
  }
}

function normalizeSearch(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}
</script>

<template>
  <Teleport to="body">
    <div class="fixed inset-0 z-[70] flex items-end justify-center bg-scrim px-2 py-3 md:items-center md:px-6" @click.self="handleClose">
      <section
        ref="dialogRef"
        class="flex max-h-[92vh] w-full max-w-6xl flex-col rounded-lg border border-border bg-background shadow-xl outline-none"
        role="dialog"
        aria-modal="true"
        aria-labelledby="hardcover-import-review-title"
        tabindex="-1"
      >
        <header class="flex shrink-0 items-start justify-between gap-4 border-b border-border px-4 py-3 md:px-5">
          <div class="min-w-0">
            <h2 id="hardcover-import-review-title" class="text-sm font-semibold">{{ t('hardcover.review.title') }}</h2>
            <p class="mt-0.5 text-xs text-muted-foreground">
              {{ t('hardcover.review.subtitle', { total: preview.summary.totalHardcoverBooks, matched: preview.summary.matchedBooks }) }}
            </p>
          </div>
          <Button as-child variant="ghost" size="icon-sm">
            <button ref="closeButtonRef" type="button" :disabled="applying" :aria-label="t('hardcover.review.closeAriaLabel')" @click="handleClose">
              <X class="size-4" />
            </button>
          </Button>
        </header>

        <div class="grid shrink-0 grid-cols-2 gap-2 border-b border-border px-4 py-3 sm:grid-cols-5 md:px-5">
          <div class="min-w-0 rounded-md border border-border bg-card px-3 py-2">
            <p class="text-[10px] uppercase tracking-wider text-muted-foreground">{{ t('hardcover.review.summary.ready') }}</p>
            <p class="text-lg font-semibold tabular-nums">{{ preview.summary.willUpdate }}</p>
          </div>
          <div class="min-w-0 rounded-md border border-border bg-card px-3 py-2">
            <p class="text-[10px] uppercase tracking-wider text-muted-foreground">{{ t('hardcover.review.summary.review') }}</p>
            <p class="text-lg font-semibold tabular-nums">{{ preview.summary.needsReview }}</p>
          </div>
          <div class="min-w-0 rounded-md border border-border bg-card px-3 py-2">
            <p class="text-[10px] uppercase tracking-wider text-muted-foreground">{{ t('hardcover.review.summary.conflicts') }}</p>
            <p class="text-lg font-semibold tabular-nums">{{ preview.summary.conflicts }}</p>
          </div>
          <div class="min-w-0 rounded-md border border-border bg-card px-3 py-2">
            <p class="text-[10px] uppercase tracking-wider text-muted-foreground">{{ t('hardcover.review.summary.unmatched') }}</p>
            <p class="text-lg font-semibold tabular-nums">{{ preview.summary.unmatched }}</p>
          </div>
          <div class="min-w-0 rounded-md border border-border bg-card px-3 py-2">
            <p class="text-[10px] uppercase tracking-wider text-muted-foreground">{{ t('hardcover.review.summary.skipped') }}</p>
            <p class="text-lg font-semibold tabular-nums">{{ preview.summary.skipped }}</p>
          </div>
        </div>

        <div class="shrink-0 space-y-3 border-b border-border px-4 py-3 md:px-5">
          <div class="flex flex-col gap-2 md:flex-row md:items-center">
            <label class="relative min-w-0 flex-1">
              <Search class="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <input
                v-model="search"
                type="search"
                class="h-9 w-full rounded-md border border-border bg-background pl-9 pr-3 text-sm outline-none transition-shadow focus:ring-2 focus:ring-primary/40"
                :placeholder="t('hardcover.review.searchPlaceholder')"
              />
            </label>
            <select
              v-model="matchFilter"
              class="h-9 rounded-md border border-border bg-background px-3 text-sm outline-none transition-shadow focus:ring-2 focus:ring-primary/40"
            >
              <option v-for="option in matchOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
            </select>
            <label class="flex h-9 shrink-0 items-center gap-2 rounded-md border border-border px-3 text-xs text-muted-foreground">
              <input
                v-model="importProgressModel"
                type="checkbox"
                class="size-4 rounded-xs border-border text-primary focus:ring-primary/40"
                :disabled="applying"
              />
              <span>{{ t('hardcover.review.importProgress') }}</span>
            </label>
          </div>

          <div class="flex gap-1 overflow-x-auto pb-0.5">
            <button
              v-for="tab in tabs"
              :key="tab.id"
              type="button"
              class="flex shrink-0 items-center gap-1.5 rounded-md px-3 py-1.5 text-xs transition-colors"
              :class="activeTab === tab.id ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:bg-muted/80'"
              @click="setActiveTab(tab.id)"
            >
              {{ tab.label }}
              <span class="tabular-nums">{{ tab.count }}</span>
            </button>
          </div>

          <div class="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
            <p class="text-xs text-muted-foreground">
              {{ t('hardcover.review.selectionSummary', { count: selectedCount, ready: selectedReadyCount, reviewed: selectedReviewCount }) }}
              <span v-if="importProgressModel">{{ selectedProgressLabel }}.</span>
            </p>
            <div class="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" type="button" @click="handleSelectSafe">
                {{ t('hardcover.review.selectReady') }}
              </Button>
              <Button
                variant="outline"
                size="sm"
                type="button"
                :disabled="visibleImportableRows.length === 0 || allVisibleSelected"
                @click="handleSelectVisible"
              >
                {{ t('hardcover.review.selectPage') }}
              </Button>
              <Button variant="outline" size="sm" type="button" :disabled="visibleImportableRows.length === 0" @click="handleClearVisible">
                {{ t('hardcover.review.clearPage') }}
              </Button>
              <Button variant="outline" size="sm" type="button" :disabled="selectedCount === 0" @click="handleClearSelection">
                {{ t('hardcover.review.clearSelection') }}
              </Button>
            </div>
          </div>

          <div v-if="canRequestBooks" class="space-y-2 rounded-md border border-border bg-muted/30 p-3">
            <div class="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
              <div>
                <p class="text-xs font-medium">{{ t('hardcover.review.requestsTitle') }}</p>
                <p class="text-xs text-muted-foreground">{{ t('hardcover.review.requestsDescription') }}</p>
              </div>
              <div v-if="destinationSetupLoading" class="text-xs text-muted-foreground">
                {{ t('hardcover.review.loadingRequestDestinations') }}
              </div>
              <div v-else-if="destinationSetupError" class="flex flex-wrap items-center gap-2 text-xs text-destructive">
                <span>{{ destinationSetupError }}</span>
                <Button variant="outline" size="sm" type="button" @click="handleRetryRequestDestination">
                  {{ t('hardcover.review.retryAvailability') }}
                </Button>
              </div>
              <div v-else-if="libraries.length > 0" class="flex flex-wrap gap-2">
                <label class="flex min-w-0 items-center gap-2 text-xs">
                  <span>{{ t('hardcover.review.requestDestination', { medium: t('hardcover.review.media.ebook') }) }}</span>
                  <select
                    :value="requestDestinations.ebook.libraryId ?? ''"
                    class="h-8 min-w-0 max-w-48 rounded-md border border-input bg-card px-2 text-xs text-foreground"
                    @change="handleEbookDestinationChange"
                  >
                    <option value="">{{ requestDestinationLabel('ebook') }}</option>
                    <option v-for="library in libraries" :key="library.id" :value="library.id">{{ library.name }}</option>
                  </select>
                </label>
                <label class="flex min-w-0 items-center gap-2 text-xs">
                  <span>{{ t('hardcover.review.requestDestination', { medium: t('hardcover.review.media.audiobook') }) }}</span>
                  <select
                    :value="requestDestinations.audiobook.libraryId ?? ''"
                    class="h-8 min-w-0 max-w-48 rounded-md border border-input bg-card px-2 text-xs text-foreground"
                    @change="handleAudiobookDestinationChange"
                  >
                    <option value="">{{ requestDestinationLabel('audiobook') }}</option>
                    <option v-for="library in libraries" :key="library.id" :value="library.id">{{ library.name }}</option>
                  </select>
                </label>
              </div>
              <div class="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  type="button"
                  :disabled="
                    requestAvailabilityLoading ||
                    requestAvailabilityError !== null ||
                    visibleRequestableCount === 0 ||
                    selectedRequestCount >= MAX_SELECTED_REQUESTS
                  "
                  @click="handleSelectMissingPage"
                >
                  {{ t('hardcover.review.selectMissing') }}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  type="button"
                  :disabled="requestRows.length === 0 || requestSubmitting"
                  @click="handleClearRequestsPage"
                >
                  {{ t('hardcover.review.clearRequestsPage') }}
                </Button>
                <Button
                  size="sm"
                  type="button"
                  :disabled="
                    selectedRequestCount === 0 ||
                    requestAvailabilityLoading ||
                    requestAvailabilityError !== null ||
                    requestSubmitting ||
                    applying ||
                    destinationSetupLoading ||
                    destinationSetupError !== null ||
                    requestDestinationMissing
                  "
                  @click="handleSubmitRequests"
                >
                  {{
                    requestSubmitting ? t('hardcover.review.submittingRequests') : t('hardcover.review.addRequests', { count: selectedRequestCount })
                  }}
                </Button>
              </div>
            </div>
            <p v-if="requestAvailabilityLoading" class="text-xs text-muted-foreground">{{ t('hardcover.review.checkingAvailability') }}</p>
            <p v-if="requestDestinationMissing" class="text-xs text-destructive">
              {{ t('bookRequests.search.libraryRequired') }}
            </p>
            <div v-if="requestAvailabilityError" class="flex flex-wrap items-center justify-between gap-2 text-xs text-destructive">
              <span>{{ requestAvailabilityErrorLabel }}</span>
              <Button variant="outline" size="sm" type="button" @click="handleRetryAvailability">{{
                t('hardcover.review.retryAvailability')
              }}</Button>
            </div>
            <p v-if="requestResult" class="text-xs text-primary">{{ requestResultLabel }}</p>
            <p v-if="requestError" class="text-xs text-destructive">{{ requestErrorLabel }}</p>
            <p v-if="selectedRequestCount >= MAX_SELECTED_REQUESTS" class="text-xs text-muted-foreground">
              {{ t('hardcover.review.requestLimit', { count: MAX_SELECTED_REQUESTS }) }}
            </p>
          </div>
        </div>

        <div class="min-h-0 flex-1 overflow-y-auto">
          <div v-if="pagedRows.length === 0" class="px-4 py-10 text-center text-sm text-muted-foreground">{{ t('hardcover.review.noRows') }}</div>

          <div v-else class="divide-y divide-border">
            <article
              v-for="row in pagedRows"
              :key="previewRowKey(row)"
              class="grid gap-3 px-4 py-3 md:grid-cols-[2rem_minmax(0,1.4fr)_minmax(0,0.9fr)_minmax(0,0.9fr)_minmax(0,0.9fr)_auto] md:px-5"
            >
              <div class="flex items-start">
                <input
                  type="checkbox"
                  class="mt-1 size-4 rounded-xs border-border text-primary focus:ring-primary/40 disabled:opacity-30"
                  :checked="selectedIds.has(row.hardcoverUserBookId)"
                  :disabled="!isImportableRow(row) || applying"
                  :aria-label="t('hardcover.review.selectRowAriaLabel', { title: rowTitle(row) })"
                  @change="toggleRow(row)"
                />
              </div>

              <div class="min-w-0">
                <p class="truncate text-sm font-medium">{{ rowTitle(row) }}</p>
                <p class="truncate text-xs text-muted-foreground">{{ rowSubtitle(row) }}</p>
                <p class="mt-1 text-xs text-muted-foreground md:hidden">{{ row.reason }}</p>
                <div v-if="canRequestBooks && row.hardcoverTitle?.trim()" class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                  <label v-for="mediaKind in REQUEST_MEDIA_KINDS" :key="mediaKind" class="flex items-center gap-1 text-[11px] text-muted-foreground">
                    <input
                      type="checkbox"
                      class="size-3.5 rounded-xs border-border text-primary focus:ring-primary/40 disabled:opacity-40"
                      :value="requestKey(row, mediaKind)"
                      :checked="selectedRequestKeys.has(requestKey(row, mediaKind))"
                      :disabled="
                        requestAvailabilityLoading ||
                        requestAvailabilityError !== null ||
                        requestSubmitting ||
                        !isRequestable(row, mediaKind) ||
                        (selectedRequestCount >= MAX_SELECTED_REQUESTS && !selectedRequestKeys.has(requestKey(row, mediaKind)))
                      "
                      @change="handleRequestToggle"
                    />
                    <span v-if="isRequestable(row, mediaKind)">{{
                      t('hardcover.review.requestFormat', { medium: t(`hardcover.review.media.${mediaKind}`) })
                    }}</span>
                    <span v-else-if="availabilityLabel(row, mediaKind)">{{ availabilityLabel(row, mediaKind) }}</span>
                    <span v-else>{{ t('hardcover.review.checkingAvailability') }}</span>
                  </label>
                </div>
              </div>

              <div class="min-w-0 text-xs">
                <p class="font-medium text-muted-foreground">Hardcover</p>
                <p class="truncate">{{ row.hardcoverStatusLabel }}</p>
                <p class="truncate text-muted-foreground">{{ statusLabel(row) }}</p>
              </div>

              <div class="min-w-0 text-xs">
                <p class="font-medium text-muted-foreground">BookOrbit</p>
                <p class="truncate">{{ localStatusLabel(row) }}</p>
                <p class="truncate text-muted-foreground">{{ matchMethodLabel(row) }} / {{ confidenceLabel(row) }}</p>
              </div>

              <div class="min-w-0 text-xs">
                <p class="font-medium text-muted-foreground">{{ t('hardcover.review.column.progress') }}</p>
                <p class="truncate">{{ progressLabel(row.importedProgressPercent) }} Hardcover</p>
                <p class="truncate text-muted-foreground">{{ progressLabel(row.localProgressPercent) }} BookOrbit</p>
                <p class="truncate" :class="progressOutcomeClass(row)">{{ progressOutcomeLabel(row) }}</p>
              </div>

              <div class="flex items-start justify-between gap-3 md:block md:text-right">
                <p class="text-xs font-medium" :class="outcomeClass(row)">{{ outcomeLabel(row) }}</p>
                <p class="hidden max-w-48 text-xs text-muted-foreground md:block">{{ row.reason }}</p>
              </div>
            </article>
          </div>
        </div>

        <footer class="flex shrink-0 flex-col gap-3 border-t border-border px-4 py-3 md:flex-row md:items-center md:justify-between md:px-5">
          <div class="flex items-center gap-2">
            <Button
              variant="outline"
              size="icon-sm"
              type="button"
              :disabled="!canGoPrevious"
              :aria-label="t('hardcover.review.previousPage')"
              @click="goPrevious"
            >
              <ChevronLeft class="size-4" />
            </Button>
            <p class="text-xs text-muted-foreground">
              {{ t('hardcover.review.pageRange', { start: displayStart, end: displayEnd, total: filteredRows.length }) }}
            </p>
            <Button
              variant="outline"
              size="icon-sm"
              type="button"
              :disabled="!canGoNext"
              :aria-label="t('hardcover.review.nextPage')"
              @click="goNext"
            >
              <ChevronRight class="size-4" />
            </Button>
          </div>

          <div class="flex items-center justify-end gap-2">
            <Button variant="outline" size="sm" type="button" :disabled="applying" @click="handleClose">
              <XCircle class="size-3.5" />
              {{ t('common.close') }}
            </Button>
            <Button size="sm" type="button" :disabled="selectedCount === 0 || applying" @click="handleApply">
              <CheckCircle2 v-if="applying" class="size-3.5 animate-pulse" />
              <Download v-else class="size-3.5" />
              {{ t('hardcover.review.importSelected') }}
            </Button>
          </div>
        </footer>
      </section>
    </div>
  </Teleport>
</template>
