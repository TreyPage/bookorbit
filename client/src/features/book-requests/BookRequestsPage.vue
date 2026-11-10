<script setup lang="ts">
import { computed, onMounted, provide, ref, watch } from 'vue'

import { useI18n } from 'vue-i18n'

import { useRoute, useRouter } from 'vue-router'

import { toast } from 'vue-sonner'

import { BookPlus, X, Settings } from '@lucide/vue'
import { BOOK_REQUEST_STATUSES, Permission } from '@bookorbit/types'
import type { BookRequestStatus } from '@bookorbit/types'
import type { BookRequestBulkResult, BookRequestItem, BookRequestSortField } from '@bookorbit/types'

import PageTitleRow from '@/components/page-header/PageTitleRow.vue'

import { Button } from '@/components/ui/button'

import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'

import { usePermissions } from '@/features/auth/composables/usePermissions'

import { useAuth } from '@/features/auth/composables/useAuth'

import { formatCompactNumber, formatNumber } from '@/i18n/formatters'

import { canBulkActRequest, canDismissRequest, cancelStopsATransfer } from './requestActions'

import { flattenRequestRows, rowRequests } from './requestPair'

import RequestDrawer from './components/RequestDrawer.vue'

import NoRequestSourcesNotice from './components/NoRequestSourcesNotice.vue'

import RequestEmptyState from './components/RequestEmptyState.vue'

import RequestListSkeleton from './components/RequestListSkeleton.vue'

import RequestListTable from './components/RequestListTable.vue'

import RequestSearchPanel from './components/RequestSearchPanel.vue'

import RequestAutomationPanel from './components/RequestAutomationPanel.vue'

import { useBookRequestActions, useBookRequests, type ActionOutcome } from './composables/useBookRequests'

import { useBookRequestProgress } from './composables/useBookRequestProgress'

import { useBookRequestSummary } from './composables/useBookRequestSummary'

import { useRequestSourceStatus } from './composables/useRequestSourceStatus'

import { useCoalescedRefresh } from './composables/useCoalescedRefresh'

import { useRequestListDensity } from './composables/useRequestListDensity'

import { useRequestQueue } from './composables/useRequestQueue'

import { useRouteTab } from '@/composables/useRouteTab'

import { REQUEST_DRAWER } from './requestDrawerContext'

import { localizedRequestActionFailure } from './requestActionFailure'

const TABS = ['search', 'mine', 'all', 'automation'] as const

type RequestsTab = (typeof TABS)[number]

/** How close together two change broadcasts have to be for the page to answer them once. */

const CHANGE_REFRESH_WINDOW_MS = 400

const { t } = useI18n()

const route = useRoute()

const router = useRouter()

const { hasPermission } = usePermissions()

const { user } = useAuth()

const canManage = computed(() => hasPermission(Permission.ManageBookRequests))

const canSelfFulfil = computed(() => hasPermission(Permission.BookRequestSelfFulfill))

const availableTabs = computed<RequestsTab[]>(() => (canManage.value ? [...TABS] : ['search', 'mine']))

function normalizeTab(value: unknown): RequestsTab {
  return typeof value === 'string' && (TABS as readonly string[]).includes(value) ? (value as RequestsTab) : 'search'
}

const { activeTab, selectTab } = useRouteTab<RequestsTab>({
  normalize: normalizeTab,

  availableTabs,

  fallback: 'search',
})

const mine = useBookRequests('mine')

const all = useBookRequests('all')

const actions = useBookRequestActions(() => hasPermission(Permission.ManageBookRequests))

const { summary: requestSummary, fetchSummary, refreshSummary } = useBookRequestSummary()

const { noSourcesEnabled, noSourcesConfigured, fetchSourceStatus } = useRequestSourceStatus()

const { density } = useRequestListDensity()

const { progressByRequest, onRequestsChanged, pruneSettledProgress } = useBookRequestProgress()

const activeList = computed(() => (activeTab.value === 'all' ? all : mine))

/** User-configurable desktop table columns. Preferences are stored per browser. */

type TableColumn = { name: string; visible: boolean; width: number }

const COLUMN_PREFERENCES_KEY = 'bookorbit.requests.table-columns.v1'

const DEFAULT_COLUMNS: TableColumn[] = [
  { name: 'title', visible: true, width: 280 },
  { name: 'mediaKind', visible: true, width: 96 },
  { name: 'requestedBy', visible: true, width: 144 },
  { name: 'age', visible: true, width: 128 },
  { name: 'state', visible: true, width: 160 },
  { name: 'outcome', visible: true, width: 288 },
  { name: 'actions', visible: true, width: 176 },
]

const columns = ref<TableColumn[]>(DEFAULT_COLUMNS.map((column) => ({ ...column })))
const requestStatuses = BOOK_REQUEST_STATUSES
const showColumnControls = ref(false)
const draggedColumnName = ref<string | null>(null)
const columnLayout = computed(() => columns.value.map((column) => ({ ...column })))

const activeItems = computed(() => activeList.value.items.value)

const tabCounts = computed<Record<RequestsTab, number | null>>(() => ({
  search: null,

  mine: requestSummary.value?.mineTotal ?? null,

  all: canManage.value ? (requestSummary.value?.allTotal ?? null) : null,
  automation: null,
}))

/**

 * The open request is whatever the child route names, so the drawer is a function of the URL and

 * nothing else. A hard load of /requests/34 opens it; closing it is a navigation, not local state.

 */

const openRequestId = computed(() => {
  const id = Number(route.params.id)

  return Number.isInteger(id) && id > 0 ? id : null
})

const drawerOpen = computed(() => openRequestId.value !== null)

const drawerLevel = computed<1 | 2>(() => (route.name === 'book-request-releases' ? 2 : 1))

const queue = useRequestQueue(activeItems, openRequestId)

const busyIds = computed(() => actions.pendingIds.value)

/**

 * Ids rather than rows: the list refetches under the selection on every progress transition, and

 * holding the row objects would keep a stale copy of whatever the tick just changed.

 */

const selectedIds = ref<number[]>([])

/** Every request on the page with pairs unfolded, since a selection and a batch act on requests, not rows. */

const activeRequests = computed(() => flattenRequestRows(activeList.value.items.value))

const selectedRows = computed(() => activeRequests.value.filter((request) => selectedIds.value.includes(request.id)))

const selectableRows = computed(() => activeRequests.value.filter((request) => canBulkActRequest(request, canManage.value)))

/**

 * A selection can mix states, so each bulk button owns its own subset and says how big it is.

 * Nothing is offered for rows it could not apply to, which is what stops a batch from being half

 * refusals by construction.

 */

const approvableSelection = computed(() => selectedRows.value.filter((request) => canManage.value && request.status === 'pending'))

const rejectableSelection = computed(() => selectedRows.value.filter((request) => canManage.value && request.status === 'pending'))

const dismissableSelection = computed(() => selectedRows.value.filter((request) => canDismissRequest(request) && !request.dismissed))

provide(REQUEST_DRAWER, {
  position: queue.position,

  total: queue.total,

  hasPrevious: queue.hasPrevious,

  hasNext: queue.hasNext,

  goPrevious: goToPreviousRequest,

  goNext: goToNextRequest,

  close: closeDrawer,
})

/** One request, or both halves of a pair cancelled from their row in one press. */

const confirming = ref<{ requests: BookRequestItem[]; action: 'cancel' | 'delete' } | null>(null)

/** Open while the approver is writing the one reason the whole selection is being turned down for. */

const rejectingSelection = ref(false)

const rejectNote = ref('')

const confirmTitle = computed(() =>
  confirming.value?.action === 'delete' ? t('bookRequests.confirm.deleteTitle') : t('bookRequests.confirm.cancelTitle'),
)

const confirmDescription = computed(() => {
  if (!confirming.value) return ''

  if (confirming.value.action === 'delete') return t('bookRequests.confirm.deleteDescription')

  return confirming.value.requests.some(cancelStopsATransfer)
    ? t('bookRequests.confirm.cancelDescriptionWithDownload')
    : t('bookRequests.confirm.cancelDescription')
})

const confirmLabel = computed(() => (confirming.value?.action === 'delete' ? t('bookRequests.actions.delete') : t('bookRequests.actions.cancel')))

/** The dialog acts on one row, so it is busy only while that row's own actions are running. */

const confirmBusy = computed(() => confirming.value?.requests.some((request) => actions.isPending(request.id)) ?? false)

async function loadActive() {
  if (activeTab.value === 'mine') await mine.fetchRequests()
  else if (activeTab.value === 'all') await Promise.all([all.fetchRequests(), all.fetchRequesterOptions()])
}

function reloadActive() {
  void loadActive()
}

/** A refetch can drop or settle a selected row, so the selection is trimmed to what is still there. */

function pruneSelection() {
  const present = new Set(selectableRows.value.map((request) => request.id))

  selectedIds.value = selectedIds.value.filter((id) => present.has(id))
}

onMounted(() => {
  loadColumnPreferences()

  void loadActive()

  void fetchSummary()

  void fetchSourceStatus()
})

function refreshAfterChange() {
  void loadActive()

  void refreshSummary()
}

// A status transition is more than a percentage, so the pipeline's coarse signal refetches.

onRequestsChanged(useCoalescedRefresh(refreshAfterChange, CHANGE_REFRESH_WINDOW_MS))

watch(activeTab, () => {
  selectedIds.value = []

  void loadActive()
})

watch(() => activeList.value.items.value, onRowsChanged)

/** A refetch both trims the selection and retires the live ticks the fetched rows have overtaken. */

function onRowsChanged() {
  pruneSelection()

  pruneSettledProgress(activeRequests.value)
}

function selectSearchTab() {
  selectTab('search')
}

/** A selection only means anything against the rows on screen, so anything that reloads clears it. */

function clearSelection() {
  selectedIds.value = []
}

/** A pair row's checkbox stands for every half of it a bulk action can reach. */

function toggleSelect(row: BookRequestItem) {
  const ids = rowRequests(row)
    .filter((request) => canBulkActRequest(request, canManage.value))

    .map((request) => request.id)

  const allSelected = ids.every((id) => selectedIds.value.includes(id))

  selectedIds.value = allSelected ? selectedIds.value.filter((id) => !ids.includes(id)) : [...new Set([...selectedIds.value, ...ids])]
}

/** Tick-all covers the rows that can actually be approved, not every row on the page. */

function toggleSelectAll() {
  const ids = selectableRows.value.map((request) => request.id)

  const alreadyAll = ids.length > 0 && ids.every((id) => selectedIds.value.includes(id))

  selectedIds.value = alreadyAll ? [] : ids
}

function handleSort(field: BookRequestSortField) {
  clearSelection()

  void activeList.value.applySort(field)
}

/**

 * A row opens the drawer by naming it in the URL, which is the only place the open id lives. The

 * query rides along on every hop: the tab and the filters live there, and a push that names only

 * the route drops them, so a refresh inside the drawer would land back on a different tab.

 */

function openRequest(request: BookRequestItem) {
  void router.push({ name: 'book-request-detail', params: { id: request.id }, query: route.query })
}

function openReleases(request: BookRequestItem) {
  void router.push({ name: 'book-request-releases', params: { id: request.id }, query: route.query })
}

/** The tab and the filters behind the drawer are in the query, so closing keeps them. */

function closeDrawer() {
  void router.push({ name: 'book-requests', query: route.query })
}

/** Back out of the release picker without losing the request it was opened for. */

function returnToRequest() {
  if (openRequestId.value === null) return

  void router.push({ name: 'book-request-detail', params: { id: openRequestId.value }, query: route.query })
}

function loadColumnPreferences() {
  try {
    const stored = window.localStorage.getItem(COLUMN_PREFERENCES_KEY)
    if (!stored) return
    const parsed: unknown = JSON.parse(stored)
    if (!Array.isArray(parsed)) return

    const defaults = new Map(DEFAULT_COLUMNS.map((column) => [column.name, column]))
    const restored: TableColumn[] = []
    for (const candidate of parsed) {
      if (!candidate || typeof candidate !== 'object') continue
      const value = candidate as Partial<TableColumn>
      const fallback = typeof value.name === 'string' ? defaults.get(value.name) : undefined
      if (!fallback || restored.some((column) => column.name === fallback.name)) continue
      restored.push({
        name: fallback.name,
        visible: fallback.name === 'title' ? true : typeof value.visible === 'boolean' ? value.visible : fallback.visible,
        width:
          typeof value.width === 'number' && Number.isFinite(value.width) ? Math.min(700, Math.max(80, Math.round(value.width))) : fallback.width,
      })
    }
    for (const column of DEFAULT_COLUMNS) {
      if (!restored.some((item) => item.name === column.name)) restored.push({ ...column })
    }
    columns.value = restored
  } catch {
    // Ignore unavailable storage or malformed preferences and retain defaults.
  }
}

watch(
  columns,
  (value) => {
    try {
      window.localStorage.setItem(COLUMN_PREFERENCES_KEY, JSON.stringify(value))
    } catch {
      // The table remains usable when browser storage is disabled or full.
    }
  },
  { deep: true },
)

function toggleColumn(name: string) {
  if (name === 'title') return
  const column = columns.value.find((item) => item.name === name)
  if (column) column.visible = !column.visible
}

function handleStatusFilter(event: Event) {
  const value = (event.target as HTMLSelectElement).value
  activeList.value.status.value = value as BookRequestStatus | ''
  clearSelection()
  void activeList.value.applyFilters()
}

function moveColumn(name: string, direction: -1 | 1) {
  const index = columns.value.findIndex((column) => column.name === name)
  const nextIndex = index + direction
  if (index < 0 || nextIndex < 0 || nextIndex >= columns.value.length) return
  const reordered = [...columns.value]
  const [column] = reordered.splice(index, 1)
  if (column) reordered.splice(nextIndex, 0, column)
  columns.value = reordered
}

function setColumnWidth(name: string, width: number | string) {
  const column = columns.value.find((item) => item.name === name)
  const numericWidth = Number(width)
  if (column && Number.isFinite(numericWidth)) column.width = Math.min(700, Math.max(80, Math.round(numericWidth)))
}

function dropColumn(targetName: string) {
  const sourceName = draggedColumnName.value
  draggedColumnName.value = null
  if (!sourceName || sourceName === targetName) return
  const from = columns.value.findIndex((column) => column.name === sourceName)
  const to = columns.value.findIndex((column) => column.name === targetName)
  if (from < 0 || to < 0) return
  const reordered = [...columns.value]
  const [column] = reordered.splice(from, 1)
  if (column) reordered.splice(to, 0, column)
  columns.value = reordered
}

function resetColumns() {
  columns.value = DEFAULT_COLUMNS.map((column) => ({ ...column }))
}

function stepTo(id: number | null) {
  if (id === null) return

  void router.push({ name: 'book-request-detail', params: { id }, query: route.query })
}

function goToPreviousRequest() {
  stepTo(queue.previousId.value)
}

function goToNextRequest() {
  stepTo(queue.nextId.value)
}

/** The row is gone for good, so both tabs let go of it rather than one keeping a dead id. */

function dropFromLists(id: number) {
  mine.dropItem(id)

  all.dropItem(id)
}

/**

 * One decision updates whichever lists are holding that row, so the tabs cannot disagree.

 *

 * The outcome is the call's own rather than the composable's latest, so acting on two rows at once

 * cannot attach one row's refusal to the other's toast.

 */

function applyUpdate(outcome: ActionOutcome, failureKey: string): boolean {
  if (!outcome.item) {
    const localized = localizedRequestActionFailure(outcome)

    const description = localized ? t(localized.key, localized.params) : outcome.reason

    toast.error(t(failureKey), description ? { description } : undefined)

    return false
  }

  mine.replaceItem(outcome.item)

  all.replaceItem(outcome.item)

  return true
}

/** Approving needs a destination, so a request without one goes to the page that can pick one. */

async function approveRequest(request: BookRequestItem) {
  if (request.targetLibraryId === null) {
    openRequest(request)

    return
  }

  const outcome = await actions.approve(request.id, {
    targetLibraryId: request.targetLibraryId,

    targetFolderId: request.targetFolderId ?? undefined,
  })

  if (applyUpdate(outcome, 'bookRequests.errors.approveFailed')) toast.success(t('bookRequests.toasts.approved'))
}

async function rejectRequest(request: BookRequestItem) {
  const outcome = await actions.reject(request.id, {})

  if (applyUpdate(outcome, 'bookRequests.errors.rejectFailed')) toast.success(t('bookRequests.toasts.rejected'))
}

async function cancelRequest(request: BookRequestItem) {
  const outcome = await actions.cancel(request.id)

  if (applyUpdate(outcome, 'bookRequests.errors.cancelFailed')) toast.success(t('bookRequests.toasts.cancelled'))
}

/**

 * A dismissed row leaves the list it was hiding from, unless the list is showing dismissed rows,

 * where it stays and picks up the badge instead.

 */

async function dismissRequest(request: BookRequestItem) {
  const outcome = await actions.dismiss(request.id)

  if (!applyUpdate(outcome, 'bookRequests.errors.dismissFailed')) return

  if (!activeList.value.includeDismissed.value) dropFromLists(request.id)

  void refreshSummary()

  toast.success(t('bookRequests.toasts.dismissed'))
}

async function restoreRequest(request: BookRequestItem) {
  const outcome = await actions.restore(request.id)

  if (!applyUpdate(outcome, 'bookRequests.errors.restoreFailed')) return

  void refreshSummary()

  toast.success(t('bookRequests.toasts.restored'))
}

async function deleteRequest(request: BookRequestItem) {
  const outcome = await actions.remove(request.id)

  if (!outcome.ok) {
    toast.error(t('bookRequests.errors.deleteFailed'), outcome.reason ? { description: outcome.reason } : undefined)

    return
  }

  dropFromLists(request.id)

  toast.success(t('bookRequests.toasts.deleted'))
}

function handleApprove(request: BookRequestItem) {
  void approveRequest(request)
}

function handleReject(request: BookRequestItem) {
  void rejectRequest(request)
}

/** Stopping a live transfer and deleting a row both ask first; the rest are one click. */

function handleCancel(request: BookRequestItem) {
  if (cancelStopsATransfer(request)) confirming.value = { requests: [request], action: 'cancel' }
  else void cancelRequest(request)
}

/**

 * The halves of a pair, acted on from their row. One half goes through the same path a single

 * request does; two go through the batch endpoints, which report each half's own outcome.

 */

function handlePairApprove(requests: BookRequestItem[]) {
  if (requests.length === 1) {
    void approveRequest(requests[0]!)

    return
  }

  void runBulk(
    requests,

    actions.approveMany,

    { failed: 'bookRequests.errors.bulkApproveFailed', done: 'bookRequests.toasts.pairApproved', partial: 'bookRequests.toasts.bulkApprovedPartial' },

    false,
  )
}

function handlePairReject(requests: BookRequestItem[]) {
  if (requests.length === 1) {
    void rejectRequest(requests[0]!)

    return
  }

  void runBulk(
    requests,

    (ids) => actions.rejectMany(ids),

    { failed: 'bookRequests.errors.bulkRejectFailed', done: 'bookRequests.toasts.pairRejected', partial: 'bookRequests.toasts.bulkRejectedPartial' },

    false,
  )
}

function handlePairCancel(requests: BookRequestItem[]) {
  if (requests.some(cancelStopsATransfer)) confirming.value = { requests, action: 'cancel' }
  else void cancelRequests(requests)
}

function handlePairDismiss(requests: BookRequestItem[]) {
  void runBulk(
    requests,

    actions.dismissMany,

    {
      failed: 'bookRequests.errors.bulkDismissFailed',

      done: 'bookRequests.toasts.bulkDismissed',

      partial: 'bookRequests.toasts.bulkDismissedPartial',
    },

    !activeList.value.includeDismissed.value,
  )
}

function handlePairRestore(requests: BookRequestItem[]) {
  for (const request of requests) void restoreRequest(request)
}

/** One at a time, each with its own outcome, so one half refusing does not hide the other succeeding. */

async function cancelRequests(requests: BookRequestItem[]) {
  for (const request of requests) await cancelRequest(request)
}

function handleDismiss(request: BookRequestItem) {
  void dismissRequest(request)
}

function handleRestore(request: BookRequestItem) {
  void restoreRequest(request)
}

function handleRemove(request: BookRequestItem) {
  confirming.value = { requests: [request], action: 'delete' }
}

/** Open until the action settles, so `busy` has something to render and a second Enter does nothing. */

async function handleConfirm() {
  const pending = confirming.value

  if (!pending) return

  if (pending.action === 'delete') {
    for (const request of pending.requests) await deleteRequest(request)
  } else await cancelRequests(pending.requests)

  confirming.value = null
}

function handleConfirmCancel() {
  confirming.value = null
}

/**

 * The batch is partly successful by design, so the toast reports both halves. The refused rows

 * carry the server's own sentence, which for a missing destination library is the fix itself.

 */

async function runBulk(
  rows: BookRequestItem[],

  call: (ids: number[]) => Promise<BookRequestBulkResult | null>,

  keys: { failed: string; done: string; partial: string },

  dropUpdated: boolean,
) {
  if (rows.length === 0) return

  const result = await call(rows.map((request) => request.id))

  if (!result) {
    toast.error(t(keys.failed), actions.lastReason.value ? { description: actions.lastReason.value } : undefined)

    return
  }

  for (const updated of result.updated) {
    // A hidden row leaves the list it was hiding from, unless that list is showing hidden rows.

    if (dropUpdated) dropFromLists(updated.id)
    else {
      mine.replaceItem(updated)

      all.replaceItem(updated)
    }
  }

  clearSelection()

  void refreshSummary()

  if (result.failed.length === 0) {
    toast.success(t(keys.done, { count: result.updated.length }))

    return
  }

  toast.warning(t(keys.partial, { done: result.updated.length, failed: result.failed.length }), {
    description: result.failed

      .map((failure) => {
        const localized = localizedRequestActionFailure(failure)

        return `${failure.title}: ${localized ? t(localized.key, localized.params) : failure.reason}`
      })

      .join('\n'),
  })
}

function handleApproveSelected() {
  void runBulk(
    approvableSelection.value,

    actions.approveMany,

    {
      failed: 'bookRequests.errors.bulkApproveFailed',

      done: 'bookRequests.toasts.bulkApproved',

      partial: 'bookRequests.toasts.bulkApprovedPartial',
    },

    false,
  )
}

function handleRejectSelected() {
  rejectNote.value = ''

  rejectingSelection.value = true
}

function handleRejectSelectionCancel() {
  rejectingSelection.value = false
}

function handleRejectSelectionConfirm() {
  const note = rejectNote.value.trim()

  const rows = rejectableSelection.value

  rejectingSelection.value = false

  void runBulk(
    rows,

    (ids) => actions.rejectMany(ids, note || undefined),

    {
      failed: 'bookRequests.errors.bulkRejectFailed',

      done: 'bookRequests.toasts.bulkRejected',

      partial: 'bookRequests.toasts.bulkRejectedPartial',
    },

    false,
  )
}

function handleDismissSelected() {
  void runBulk(
    dismissableSelection.value,

    actions.dismissMany,

    {
      failed: 'bookRequests.errors.bulkDismissFailed',

      done: 'bookRequests.toasts.bulkDismissed',

      partial: 'bookRequests.toasts.bulkDismissedPartial',
    },

    !activeList.value.includeDismissed.value,
  )
}

function handleSubmitted() {
  void mine.fetchRequests()

  void refreshSummary()
}

function goToPreviousPage() {
  clearSelection()

  void activeList.value.goToPage(activeList.value.page.value - 1)
}

function goToNextPage() {
  clearSelection()

  void activeList.value.goToPage(activeList.value.page.value + 1)
}
</script>

<template>
  <div class="mx-auto flex w-full max-w-420 flex-col pt-2 pb-4">
    <PageTitleRow class="mb-4" :title="t('bookRequests.title')" :icon="BookPlus">
      <template #facts>
        <span class="truncate">{{ t('bookRequests.subtitle') }}</span>
      </template>
    </PageTitleRow>

    <!--

      Above the tabs rather than inside one of them: it is the same fact whether you are filing a

      request or waiting on one, and the queue below it is otherwise a list of rows with no stated

      reason for standing still.

    -->

    <NoRequestSourcesNotice v-if="noSourcesEnabled" :nothing-configured="noSourcesConfigured" class="mb-4" />

    <!-- Underline tabs with a roving tabindex, matching the only other tablist in the app. -->

    <div role="tablist" :aria-label="t('bookRequests.title')" class="mb-4 flex gap-1 border-b border-border">
      <button
        v-for="tab in availableTabs"
        :id="`requests-tab-${tab}`"
        :key="tab"
        type="button"
        role="tab"
        :aria-selected="activeTab === tab"
        :aria-controls="`requests-panel-${tab}`"
        :tabindex="activeTab === tab ? 0 : -1"
        class="-mb-px shrink-0 border-b-2 px-3 py-2.5 text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none motion-reduce:transition-none"
        :class="activeTab === tab ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'"
        @click="selectTab(tab)"
      >
        {{ tab === 'automation' ? 'Automation' : t(`bookRequests.tabs.${tab}`) }}

        <template v-if="tabCounts[tab] !== null">
          <span
            class="ms-1 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary/15 px-1.5 text-xs font-semibold text-primary tabular-nums"
            aria-hidden="true"
          >
            {{ formatCompactNumber(tabCounts[tab] ?? 0) }}
          </span>

          <span class="sr-only">{{ formatNumber(tabCounts[tab] ?? 0) }}</span>
        </template>
      </button>
    </div>

    <!--

      The lists want every pixel; this tab is a form and a result list, and stretching a search

      field to the full width only pushes its own submit button away from what you just typed. It

      is capped rather than centred, so switching tabs does not shift the content sideways.

    -->

    <section v-if="activeTab === 'search'" id="requests-panel-search" role="tabpanel" aria-labelledby="requests-tab-search" class="w-full max-w-5xl">
      <RequestSearchPanel @submitted="handleSubmitted" />
    </section>

    <section v-else-if="activeTab === 'automation'" id="requests-panel-automation" role="tabpanel" aria-labelledby="requests-tab-automation">
      <RequestAutomationPanel />
    </section>

    <section
      v-if="activeTab === 'mine' || activeTab === 'all'"
      :id="`requests-panel-${activeTab}`"
      role="tabpanel"
      :aria-labelledby="`requests-tab-${activeTab}`"
      class="space-y-4"
    >
      <div class="flex flex-wrap items-center gap-2 border-b border-border pb-3">
        <button
          type="button"
          class="inline-flex items-center gap-2 rounded-md border border-border bg-background px-3 py-1.5 text-sm hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          :aria-expanded="showColumnControls"
          @click="showColumnControls = !showColumnControls"
        >
          <Settings :size="16" aria-hidden="true" />
          {{ showColumnControls ? 'Done customizing' : 'Customize columns' }}
        </button>
        <span class="text-xs text-muted-foreground">Changes save automatically in this browser.</span>
      </div>

      <div v-if="showColumnControls" class="space-y-3 rounded-lg border border-border bg-muted/20 p-3">
        <div class="flex items-center justify-between gap-3">
          <p class="text-sm font-medium">Table layout</p>
          <button type="button" class="text-xs text-muted-foreground underline hover:text-foreground" @click="resetColumns">Reset to default</button>
        </div>
        <div
          v-for="(column, index) in columns"
          :key="column.name"
          draggable="true"
          class="grid cursor-grab grid-cols-[minmax(9rem,1fr)_auto_minmax(9rem,1.25fr)] items-center gap-3 rounded px-1 py-1 active:cursor-grabbing"
          @dragstart="draggedColumnName = column.name"
          @dragover.prevent
          @drop="dropColumn(column.name)"
          @dragend="draggedColumnName = null"
        >
          <label class="flex min-w-0 items-center gap-2 text-sm">
            <input type="checkbox" :checked="column.visible" :disabled="column.name === 'title'" @change="toggleColumn(column.name)" />
            <span class="truncate">{{ t(`bookRequests.table.${column.name}`) }}</span>
          </label>
          <div class="flex items-center gap-1">
            <button
              type="button"
              class="rounded px-2 py-1 text-xs hover:bg-muted disabled:opacity-30"
              :disabled="index === 0"
              :aria-label="`Move ${column.name} left`"
              @click="moveColumn(column.name, -1)"
            >
              ↑
            </button>
            <button
              type="button"
              class="rounded px-2 py-1 text-xs hover:bg-muted disabled:opacity-30"
              :disabled="index === columns.length - 1"
              :aria-label="`Move ${column.name} right`"
              @click="moveColumn(column.name, 1)"
            >
              ↓
            </button>
          </div>
          <label class="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
            <span class="w-12 shrink-0">{{ column.width }} px</span>
            <input
              class="min-w-0 flex-1 accent-primary"
              type="range"
              min="80"
              max="700"
              step="8"
              :value="column.width"
              :disabled="!column.visible"
              :aria-label="`${column.name} column width`"
              @input="setColumnWidth(column.name, ($event.target as HTMLInputElement).value)"
            />
          </label>
        </div>
      </div>

      <!--

        The skeleton is for a list with nothing on screen yet. A filter change, a page turn and a

        progress tick all refetch, and swapping twenty rows out for six grey bars and back is a

        flash rather than feedback: the rows stay put and go quiet instead.

      -->

      <div class="flex flex-wrap items-center gap-3">
        <label class="flex items-center gap-2 text-sm text-muted-foreground">
          {{ t('bookRequests.filters.status') }}
          <select
            class="h-9 min-w-40 rounded-md border border-input bg-background px-3 text-sm text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            :value="activeList.status.value"
            @change="handleStatusFilter"
          >
            <option value="">{{ t('bookRequests.filters.anyStatus') }}</option>
            <option v-for="status in requestStatuses" :key="status" :value="status">{{ t(`bookRequests.status.${status}`) }}</option>
          </select>
        </label>
      </div>

      <RequestListSkeleton v-if="activeList.loading.value && activeList.items.value.length === 0" />

      <!-- A failure with no way out of it leaves reloading the page as the only move. -->

      <div v-else-if="activeList.error.value" role="alert" class="flex flex-wrap items-center gap-3">
        <p class="text-sm text-destructive">{{ t('bookRequests.errors.loadFailed') }}</p>

        <Button variant="outline" size="sm" :disabled="activeList.loading.value" @click="reloadActive">{{ t('common.retry') }}</Button>
      </div>

      <RequestEmptyState
        v-else-if="activeList.items.value.length === 0"
        :icon="BookPlus"
        :title="activeTab === 'all' ? t('bookRequests.list.emptyAll') : t('bookRequests.list.emptyMine')"
        :message="t('bookRequests.list.emptyHint')"
      >
        <Button v-if="activeTab !== 'all'" size="sm" @click="selectSearchTab">{{ t('bookRequests.tabs.search') }}</Button>
      </RequestEmptyState>

      <div v-else class="space-y-2" :aria-busy="activeList.loading.value">
        <!--

          Announced, because approving four rows at once and watching four buttons disappear is the

          kind of change a screen reader user otherwise has to go looking for.

        -->

        <div
          v-if="selectedIds.length > 0"
          role="status"
          class="flex flex-wrap items-center gap-2 rounded-lg border border-primary/30 bg-primary/10 px-3 py-2"
        >
          <span class="text-sm font-medium text-foreground">
            {{ t('bookRequests.bulk.selected', { count: selectedIds.length }) }}
          </span>

          <Button v-if="approvableSelection.length > 0" size="sm" :disabled="actions.bulkPending.value" @click="handleApproveSelected">
            {{ t('bookRequests.bulk.approveSelected', { count: approvableSelection.length }) }}
          </Button>

          <Button
            v-if="rejectableSelection.length > 0"
            variant="destructive-outline"
            size="sm"
            :disabled="actions.bulkPending.value"
            @click="handleRejectSelected"
          >
            {{ t('bookRequests.bulk.rejectSelected', { count: rejectableSelection.length }) }}
          </Button>

          <Button
            v-if="dismissableSelection.length > 0"
            variant="outline"
            size="sm"
            :disabled="actions.bulkPending.value"
            @click="handleDismissSelected"
          >
            {{ t('bookRequests.bulk.dismissSelected', { count: dismissableSelection.length }) }}
          </Button>

          <Button variant="ghost" size="sm" class="ms-auto" @click="clearSelection">
            <X :size="14" aria-hidden="true" />

            {{ t('bookRequests.bulk.clear') }}
          </Button>
        </div>

        <RequestListTable
          class="transition-opacity duration-150 motion-reduce:transition-none"
          :class="activeList.loading.value && 'opacity-60'"
          :requests="activeList.items.value"
          :can-manage="canManage"
          :can-self-fulfil="canSelfFulfil"
          :current-user-id="user?.id ?? null"
          :busy-ids="busyIds"
          :progress-by-request="progressByRequest"
          :density="density"
          :sort-by="activeList.sortBy.value"
          :sort-dir="activeList.sortDir.value"
          :selected-ids="selectedIds"
          :column-layout="columnLayout"
          @open="openRequest"
          @approve="handleApprove"
          @reject="handleReject"
          @cancel="handleCancel"
          @dismiss="handleDismiss"
          @restore="handleRestore"
          @remove="handleRemove"
          @grab="openReleases"
          @pair-approve="handlePairApprove"
          @pair-reject="handlePairReject"
          @pair-cancel="handlePairCancel"
          @pair-dismiss="handlePairDismiss"
          @pair-restore="handlePairRestore"
          @sort="handleSort"
          @toggle-select="toggleSelect"
          @toggle-select-all="toggleSelectAll"
        />
      </div>

      <nav v-if="activeList.pageCount.value > 1" class="flex items-center justify-between" :aria-label="t('bookRequests.list.pagination')">
        <Button variant="outline" size="sm" :disabled="activeList.page.value <= 1" @click="goToPreviousPage">
          {{ t('common.previous') }}
        </Button>

        <span class="text-sm text-muted-foreground">
          {{ t('bookRequests.list.pageOf', { page: activeList.page.value, total: activeList.pageCount.value }) }}
        </span>

        <Button variant="outline" size="sm" :disabled="activeList.page.value >= activeList.pageCount.value" @click="goToNextPage">
          {{ t('common.next') }}
        </Button>
      </nav>
    </section>

    <ConfirmDialog
      :open="confirming !== null"
      :title="confirmTitle"
      :description="confirmDescription"
      :confirm-label="confirmLabel"
      :busy="confirmBusy"
      @confirm="handleConfirm"
      @cancel="handleConfirmCancel"
    />

    <!--

      A reason, because a batch is refused for one reason or none and this is the one bulk action

      the people who asked are told about. Optional: "no" with nothing after it is still an answer.

    -->

    <ConfirmDialog
      :open="rejectingSelection"
      :title="t('bookRequests.bulk.rejectTitle', { count: rejectableSelection.length })"
      :description="t('bookRequests.confirm.rejectDescription')"
      :confirm-label="t('bookRequests.bulk.rejectConfirm')"
      :busy="actions.bulkPending.value"
      @confirm="handleRejectSelectionConfirm"
      @cancel="handleRejectSelectionCancel"
    >
      <label for="bulk-reject-note" class="mt-4 block text-sm font-medium text-foreground">
        {{ t('bookRequests.bulk.rejectNoteLabel') }}
      </label>

      <textarea
        id="bulk-reject-note"
        v-model="rejectNote"
        rows="3"
        maxlength="2000"
        class="mt-1.5 w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
        :placeholder="t('bookRequests.bulk.rejectNotePlaceholder')"
      ></textarea>
    </ConfirmDialog>

    <RequestDrawer :open="drawerOpen" :level="drawerLevel" @close="closeDrawer" @back="returnToRequest">
      <router-view />
    </RequestDrawer>
  </div>
</template>
