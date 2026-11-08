<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { ArrowRight, Copy, Files, GitMerge, Merge, RefreshCw, ShieldCheck } from '@lucide/vue'

import type { BookDuplicateScan, LibraryFilesystemFindingsResult, LibraryIntegrityScanStatus } from '@bookorbit/types'
import { createBookDuplicateScan, getActiveBookDuplicateScan, getBookDuplicateScan } from '@/features/tools/api/book-duplicates'
import { getBookMergeCandidates } from '@/features/tools/api/book-merge'
import { getSimilarSeriesCandidates } from '@/features/tools/api/library-integrity'

import {
  cleanupEmptyBookFolder,
  cleanupOrphanedFile,
  getLibraryFilesystemFindings,
  getLibraryIntegrityScanStatus,
  startLibraryIntegrityScan,
} from '@/features/tools/api/library-integrity'
import MissingResourcesView from '@/features/tools/missing-resources/views/MissingResourcesView.vue'

import { Button } from '@/components/ui/button'

const router = useRouter()
const { t } = useI18n()
const scanStatus = ref<LibraryIntegrityScanStatus | null>(null)
const scanLoading = ref(false)
const scanError = ref(false)
const relatedChecks = ref({
  duplicateBooks: { status: 'idle' as 'idle' | 'running' | 'complete' | 'failed', count: null as number | null, progress: null as number | null },
  mergeCandidates: { status: 'idle' as 'idle' | 'running' | 'complete' | 'failed', count: null as number | null },
  seriesCleanup: { status: 'idle' as 'idle' | 'running' | 'complete' | 'failed', count: null as number | null, truncated: false },
})
const duplicateScanId = ref<number | null>(null)
const findings = ref<LibraryFilesystemFindingsResult | null>(null)
const findingsLoading = ref(false)
const findingsPage = ref(1)
const findingsPageSize = 50
const findingsError = ref(false)
const cleaningFolder = ref<string | null>(null)
const cleaningFile = ref<string | null>(null)
const cleanupError = ref(false)
let scanPollInterval: ReturnType<typeof setInterval> | null = null
let scanPollInFlight = false

function stopScanPolling(): void {
  if (scanPollInterval) clearInterval(scanPollInterval)
  scanPollInterval = null
}

function startScanPolling(): void {
  stopScanPolling()
  scanPollInterval = setInterval(() => {
    void pollScanStatus()
  }, 2000)
}

async function pollScanStatus(): Promise<void> {
  if (scanPollInFlight) return
  scanPollInFlight = true
  try {
    scanStatus.value = await getLibraryIntegrityScanStatus()
    scanError.value = false
    if (scanStatus.value?.status !== 'running') {
      stopScanPolling()
      await loadFilesystemFindings()
    }
  } catch {
    scanError.value = true
  } finally {
    scanPollInFlight = false
  }
}
const scanMetrics = computed(() => {
  const summary = scanStatus.value?.summary
  if (!summary) return []
  return [
    { key: 'libraries', value: summary.libraryCount },
    { key: 'duplicateGroups', value: summary.duplicateFormatGroups },
    { key: 'duplicateFiles', value: summary.duplicateFormatFiles },
    { key: 'sidecars', value: summary.sidecarEntries },
    { key: 'orphanedBookFolders', value: summary.orphanedBookFolders ?? 0 },
    { key: 'orphanedFiles', value: summary.orphanedFiles ?? 0 },
    { key: 'emptyFolders', value: summary.emptyBookFolders },
    { key: 'unreadableDirectories', value: summary.unreadableDirectories ?? 0 },
    { key: 'orphanedCovers', value: summary.orphanedCoverDirectories },
    { key: 'coverBytes', value: summary.orphanedCoverBytes },
  ]
})

async function loadFilesystemFindings(append = false): Promise<void> {
  const requestedPage = append ? findingsPage.value + 1 : 1
  findingsLoading.value = true
  findingsError.value = false
  try {
    const result = await getLibraryFilesystemFindings({
      page: requestedPage,
      pageSize: findingsPageSize,
      snapshotId: append ? findings.value?.snapshotId : undefined,
    })
    if (append && findings.value && result.page === requestedPage) {
      findings.value = {
        ...result,
        orphanedMetadataFiles: {
          ...result.orphanedMetadataFiles,
          items: [...findings.value.orphanedMetadataFiles.items, ...result.orphanedMetadataFiles.items],
        },
        orphanedBookFolders: {
          ...result.orphanedBookFolders,
          items: [...findings.value.orphanedBookFolders.items, ...result.orphanedBookFolders.items],
        },
        orphanedFiles: { ...result.orphanedFiles, items: [...findings.value.orphanedFiles.items, ...result.orphanedFiles.items] },
        emptyBookFolders: { ...result.emptyBookFolders, items: [...findings.value.emptyBookFolders.items, ...result.emptyBookFolders.items] },
        unreadableDirectories: {
          ...result.unreadableDirectories,
          items: [...findings.value.unreadableDirectories.items, ...result.unreadableDirectories.items],
        },
      }
    } else {
      findings.value = result
    }
    findingsPage.value = requestedPage
  } catch {
    findingsError.value = true
  } finally {
    findingsLoading.value = false
  }
}

async function removeEmptyFolder(item: { libraryId: number; path: string }): Promise<void> {
  if (!window.confirm(t('tools.libraryIntegrity.findings.confirmEmptyFolder', { path: item.path }))) return
  cleaningFolder.value = item.path
  cleanupError.value = false
  try {
    await cleanupEmptyBookFolder({ libraryId: item.libraryId, path: item.path })
    await loadFilesystemFindings()
  } catch {
    cleanupError.value = true
  } finally {
    cleaningFolder.value = null
  }
}

async function removeOrphanedFile(item: { libraryId: number; path: string }): Promise<void> {
  if (!window.confirm(t('tools.libraryIntegrity.findings.confirmOrphanedFile', { path: item.path }))) return
  cleaningFile.value = item.path
  cleanupError.value = false
  try {
    await cleanupOrphanedFile({ libraryId: item.libraryId, path: item.path })
    await loadFilesystemFindings()
  } catch {
    cleanupError.value = true
  } finally {
    cleaningFile.value = null
  }
}

async function refreshScanStatus(): Promise<void> {
  scanLoading.value = true
  scanError.value = false
  try {
    scanStatus.value = await getLibraryIntegrityScanStatus()
  } catch {
    scanError.value = true
  } finally {
    scanLoading.value = false
  }
}

async function countMergeCandidates(): Promise<number> {
  let cursor: { bookIdA: number; bookIdB: number } | undefined
  let total = 0
  do {
    const page = await getBookMergeCandidates({ similarityPercent: 85, ...(cursor ? { cursor } : {}) })
    total += page.candidates.length
    cursor = page.nextCursor ?? undefined
  } while (cursor)
  return total
}

async function pollDuplicateScan(): Promise<void> {
  if (duplicateScanId.value === null) return
  try {
    const scan: BookDuplicateScan = await getBookDuplicateScan(duplicateScanId.value)
    if (scan.status === 'completed') {
      relatedChecks.value.duplicateBooks = { status: 'complete', count: scan.totalGroups ?? 0, progress: 100 }
      if (duplicatePollInterval) clearInterval(duplicatePollInterval)
      duplicatePollInterval = null
    } else if (scan.status === 'failed') {
      relatedChecks.value.duplicateBooks = { status: 'failed', count: null, progress: null }
      if (duplicatePollInterval) clearInterval(duplicatePollInterval)
      duplicatePollInterval = null
    } else {
      relatedChecks.value.duplicateBooks.progress = scan.progressPercent
    }
  } catch {
    relatedChecks.value.duplicateBooks = { status: 'failed', count: null, progress: null }
    if (duplicatePollInterval) clearInterval(duplicatePollInterval)
    duplicatePollInterval = null
  }
}

let duplicatePollInterval: ReturnType<typeof setInterval> | null = null

async function runRelatedChecks(): Promise<void> {
  relatedChecks.value = {
    duplicateBooks: { status: 'running', count: null, progress: 0 },
    mergeCandidates: { status: 'running', count: null },
    seriesCleanup: { status: 'running', count: null, truncated: false },
  }
  try {
    const active = await getActiveBookDuplicateScan()
    const scan = active ?? await createBookDuplicateScan({ similarityPercent: 85 })
    duplicateScanId.value = scan.id
    if (scan.status === 'completed') {
      relatedChecks.value.duplicateBooks = { status: 'complete', count: scan.totalGroups ?? 0, progress: 100 }
    } else if (scan.status === 'failed') {
      relatedChecks.value.duplicateBooks = { status: 'failed', count: null, progress: null }
    } else {
      relatedChecks.value.duplicateBooks.progress = scan.progressPercent
      if (duplicatePollInterval) clearInterval(duplicatePollInterval)
      duplicatePollInterval = setInterval(() => void pollDuplicateScan(), 2000)
      void pollDuplicateScan()
    }
  } catch {
    relatedChecks.value.duplicateBooks = { status: 'failed', count: null, progress: null }
  }

  const [mergeCount, series] = await Promise.allSettled([countMergeCandidates(), getSimilarSeriesCandidates(30)])
  relatedChecks.value.mergeCandidates = mergeCount.status === 'fulfilled'
    ? { status: 'complete', count: mergeCount.value }
    : { status: 'failed', count: null }
  relatedChecks.value.seriesCleanup = series.status === 'fulfilled'
    ? { status: 'complete', count: series.value.items.length, truncated: series.value.truncated }
    : { status: 'failed', count: null, truncated: false }
}

async function runScan(): Promise<void> {
  scanLoading.value = true
  scanError.value = false
  try {
    scanStatus.value = await startLibraryIntegrityScan()
    void runRelatedChecks()
    if (scanStatus.value?.status === 'running') startScanPolling()
    else if (scanStatus.value) await loadFilesystemFindings()
  } catch {
    scanError.value = true
  } finally {
    scanLoading.value = false
  }
}

function formatScanDate(value: string | null): string {
  return value ? new Date(value).toLocaleString() : t('tools.libraryIntegrity.scanStatus.notCompleted')
}

onMounted(() => {
  void refreshScanStatus().then(() => {
    if (scanStatus.value?.status === 'running') startScanPolling()
  })
})

onUnmounted(() => {
  stopScanPolling()
  if (duplicatePollInterval) clearInterval(duplicatePollInterval)
})

function openDuplicateFormats(): void {
  void router.push({ name: 'tools-library-integrity-duplicate-formats' })
}

function openSeriesCleanup(): void {
  void router.push({ name: 'tools-library-integrity-series-cleanup' })
}

function openDuplicateBooks(): void {
  void router.push({ name: 'tools-duplicate-books' })
}

function openBookMerge(): void {
  void router.push({ name: 'tools-book-merge' })
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col gap-6 overflow-y-auto pr-1">
    <header class="space-y-2">
      <div class="flex items-center gap-2 text-primary">
        <ShieldCheck class="size-5" aria-hidden="true" />
        <span class="text-xs font-semibold uppercase tracking-wider">{{ t('tools.libraryIntegrity.eyebrow') }}</span>
      </div>
      <h1 class="text-2xl font-semibold tracking-tight text-foreground">{{ t('titles.libraryIntegrity') }}</h1>
      <p class="max-w-3xl text-sm text-muted-foreground">{{ t('tools.libraryIntegrity.description') }}</p>
    </header>

    <section class="rounded-xl border border-border bg-card p-5" aria-live="polite">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div class="space-y-1">
          <h2 class="text-base font-semibold text-foreground">{{ t('tools.libraryIntegrity.scanStatus.title') }}</h2>
          <p class="text-sm text-muted-foreground">{{ t('tools.libraryIntegrity.scanStatus.description') }}</p>
        </div>
        <div class="flex gap-2">
          <Button size="sm" variant="outline" :disabled="scanLoading" @click="refreshScanStatus">
            <RefreshCw class="size-4" aria-hidden="true" /> {{ t('tools.libraryIntegrity.scanStatus.refresh') }}
          </Button>
          <Button size="sm" :disabled="scanLoading || scanStatus?.status === 'running'" @click="runScan">
            {{ scanStatus?.status === 'running' ? t('tools.libraryIntegrity.scanStatus.running') : t('tools.libraryIntegrity.scanStatus.runNow') }}
          </Button>
        </div>
      </div>
      <p v-if="scanError" class="mt-3 text-sm text-destructive">{{ t('tools.libraryIntegrity.scanStatus.loadFailed') }}</p>
      <p v-else-if="!scanStatus" class="mt-3 text-sm text-muted-foreground">{{ t('tools.libraryIntegrity.scanStatus.noScan') }}</p>
      <div v-else class="mt-4 space-y-3">
        <div class="flex flex-wrap gap-x-5 gap-y-1 text-sm">
          <span
            ><strong>{{ t('tools.libraryIntegrity.scanStatus.status') }}:</strong>
            {{ t('tools.libraryIntegrity.scanStatus.states.' + scanStatus.status) }}</span
          >
          <span
            ><strong>{{ t('tools.libraryIntegrity.scanStatus.started') }}:</strong> {{ formatScanDate(scanStatus.startedAt) }}</span
          >
          <span v-if="scanStatus.completedAt"
            ><strong>{{ t('tools.libraryIntegrity.scanStatus.completed') }}:</strong> {{ formatScanDate(scanStatus.completedAt) }}</span
          >
        </div>
        <p v-if="scanStatus.errorMessage" class="text-sm text-destructive">{{ scanStatus.errorMessage }}</p>
        <dl v-if="scanStatus.summary" class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div v-for="item in scanMetrics" :key="item.key" class="rounded-lg bg-muted/50 px-3 py-2">
            <dt class="text-xs text-muted-foreground">{{ t('tools.libraryIntegrity.scanStatus.metrics.' + item.key) }}</dt>
            <dd class="text-lg font-semibold tabular-nums text-foreground">
              {{ item.key === 'coverBytes' ? (item.value / 1024 / 1024).toFixed(2) + ' MB' : item.value }}
            </dd>
          </div>
        </dl>
        <div class="space-y-2">
          <h3 class="text-sm font-semibold text-foreground">{{ t('tools.libraryIntegrity.scanStatus.relatedChecks') }}</h3>
          <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-live="polite">
          <div class="rounded-lg bg-muted/50 px-3 py-2">
            <dt class="text-xs text-muted-foreground">{{ t('tools.header.duplicateBooks') }}</dt>
            <dd class="text-lg font-semibold tabular-nums text-foreground">
              {{ relatedChecks.duplicateBooks.status === 'complete' ? relatedChecks.duplicateBooks.count : relatedChecks.duplicateBooks.status === 'running' ? `${relatedChecks.duplicateBooks.progress ?? 0}%` : relatedChecks.duplicateBooks.status === 'failed' ? '—' : 'Not scanned' }}
            </dd>
            <Button v-if="relatedChecks.duplicateBooks.status === 'complete' && (relatedChecks.duplicateBooks.count ?? 0) > 0" size="sm" variant="link" class="h-auto p-0" @click="openDuplicateBooks">{{ t('tools.libraryIntegrity.openCheck') }}</Button>
          </div>
          <div class="rounded-lg bg-muted/50 px-3 py-2">
            <dt class="text-xs text-muted-foreground">{{ t('tools.header.bookMerge') }}</dt>
            <dd class="text-lg font-semibold tabular-nums text-foreground">{{ relatedChecks.mergeCandidates.status === 'complete' ? relatedChecks.mergeCandidates.count : relatedChecks.mergeCandidates.status === 'failed' ? '—' : relatedChecks.mergeCandidates.status === 'running' ? 'Scanning…' : 'Not scanned' }}</dd>
            <Button v-if="relatedChecks.mergeCandidates.status === 'complete' && (relatedChecks.mergeCandidates.count ?? 0) > 0" size="sm" variant="link" class="h-auto p-0" @click="openBookMerge">{{ t('tools.libraryIntegrity.openCheck') }}</Button>
          </div>
          <div class="rounded-lg bg-muted/50 px-3 py-2">
            <dt class="text-xs text-muted-foreground">{{ t('tools.libraryIntegrity.seriesCleanup.title') }}</dt>
            <dd class="text-lg font-semibold tabular-nums text-foreground">{{ relatedChecks.seriesCleanup.status === 'complete' ? `${relatedChecks.seriesCleanup.count ?? 0}${relatedChecks.seriesCleanup.truncated ? '+' : ''}` : relatedChecks.seriesCleanup.status === 'failed' ? '—' : relatedChecks.seriesCleanup.status === 'running' ? 'Scanning…' : 'Not scanned' }}</dd>
            <Button v-if="relatedChecks.seriesCleanup.status === 'complete' && (relatedChecks.seriesCleanup.count ?? 0) > 0" size="sm" variant="link" class="h-auto p-0" @click="openSeriesCleanup">{{ t('tools.libraryIntegrity.openCheck') }}</Button>
          </div>
          </div>
        </div>
        <p v-if="scanStatus.summary?.sidecarScanTruncated || scanStatus.summary?.filesystemScanTruncated" class="text-sm text-warning">
          {{ t('tools.libraryIntegrity.scanStatus.truncated') }}
        </p>
      </div>
    </section>

    <section class="rounded-xl border border-border bg-card p-5">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="space-y-1">
          <h3 class="text-sm font-semibold text-foreground">{{ t('tools.libraryIntegrity.findings.title') }}</h3>
          <p class="text-xs text-muted-foreground">{{ t('tools.libraryIntegrity.findings.description') }}</p>
        </div>
        <Button size="sm" variant="outline" :disabled="findingsLoading" @click="loadFilesystemFindings">
          <RefreshCw class="size-4" :class="{ 'animate-spin': findingsLoading }" aria-hidden="true" />
          {{ t('tools.libraryIntegrity.findings.load') }}
        </Button>
      </div>
      <p v-if="findingsError" role="alert" class="mt-3 text-sm text-destructive">{{ t('tools.libraryIntegrity.findings.loadFailed') }}</p>
      <p v-if="cleanupError" role="alert" class="mt-2 text-sm text-destructive">{{ t('tools.libraryIntegrity.findings.cleanupFailed') }}</p>
      <div v-if="findings" class="mt-3 grid gap-4 lg:grid-cols-2">
        <section class="min-w-0 space-y-2">
          <h4 class="text-sm font-medium">
            {{ t('tools.libraryIntegrity.findings.orphanedBookFolders', { count: findings.orphanedBookFolders.total }) }}
          </h4>
          <p v-if="findings.orphanedBookFolders.total > findings.orphanedBookFolders.items.length" class="text-xs text-muted-foreground">
            {{
              t('tools.libraryIntegrity.findings.showingCount', {
                shown: findings.orphanedBookFolders.items.length,
                total: findings.orphanedBookFolders.total,
              })
            }}
          </p>
          <p v-if="findings.orphanedBookFolders.items.length === 0" class="text-xs text-muted-foreground">
            {{ t('tools.libraryIntegrity.findings.none') }}
          </p>
          <ul v-else class="max-h-64 space-y-2 overflow-y-auto rounded-md bg-muted/30 p-3">
            <li v-for="item in findings.orphanedBookFolders.items" :key="item.path" class="space-y-0.5 text-xs">
              <span class="block text-muted-foreground">{{ item.libraryName }}</span>
              <code class="block break-all text-foreground">{{ item.path }}</code>
            </li>
          </ul>
        </section>
        <section class="min-w-0 space-y-2">
          <h4 class="text-sm font-medium">{{ t('tools.libraryIntegrity.findings.orphanedFiles', { count: findings.orphanedFiles.total }) }}</h4>
          <p v-if="findings.orphanedFiles.total > findings.orphanedFiles.items.length" class="text-xs text-muted-foreground">
            {{
              t('tools.libraryIntegrity.findings.showingCount', { shown: findings.orphanedFiles.items.length, total: findings.orphanedFiles.total })
            }}
          </p>
          <p v-if="findings.orphanedFiles.items.length === 0" class="text-xs text-muted-foreground">
            {{ t('tools.libraryIntegrity.findings.none') }}
          </p>
          <ul v-else class="max-h-64 space-y-2 overflow-y-auto rounded-md bg-muted/30 p-3">
            <li v-for="item in findings.orphanedFiles.items" :key="item.path" class="flex items-start justify-between gap-2 text-xs">
              <div class="min-w-0 space-y-0.5">
                <span class="block text-muted-foreground"
                  >{{ item.libraryName }} · {{ t('tools.libraryIntegrity.findings.fileReasons.' + item.reason) }}</span
                >
                <code class="block break-all text-foreground">{{ item.path }}</code>
              </div>
              <Button size="sm" variant="outline" :disabled="cleaningFile !== null || cleaningFolder !== null" @click="removeOrphanedFile(item)">
                {{
                  cleaningFile === item.path ? t('tools.libraryIntegrity.findings.cleaning') : t('tools.libraryIntegrity.findings.removeOrphanedFile')
                }}
              </Button>
            </li>
          </ul>
        </section>
        <section class="min-w-0 space-y-2">
          <h4 class="text-sm font-medium">{{ t('tools.libraryIntegrity.findings.emptyFolders', { count: findings.emptyBookFolders.total }) }}</h4>
          <p v-if="findings.emptyBookFolders.total > findings.emptyBookFolders.items.length" class="text-xs text-muted-foreground">
            {{
              t('tools.libraryIntegrity.findings.showingCount', {
                shown: findings.emptyBookFolders.items.length,
                total: findings.emptyBookFolders.total,
              })
            }}
          </p>
          <p v-if="findings.emptyBookFolders.items.length === 0" class="text-xs text-muted-foreground">
            {{ t('tools.libraryIntegrity.findings.none') }}
          </p>
          <ul v-else class="max-h-64 space-y-2 overflow-y-auto rounded-md bg-muted/30 p-3">
            <li v-for="item in findings.emptyBookFolders.items" :key="item.path" class="flex items-start justify-between gap-2 text-xs">
              <div class="min-w-0 space-y-0.5">
                <span class="block text-muted-foreground">{{ item.libraryName }}</span>
                <code class="block break-all text-foreground">{{ item.path }}</code>
              </div>
              <Button size="sm" variant="outline" :disabled="cleaningFolder !== null" @click="removeEmptyFolder(item)">
                {{
                  cleaningFolder === item.path
                    ? t('tools.libraryIntegrity.findings.cleaning')
                    : t('tools.libraryIntegrity.findings.removeEmptyFolder')
                }}
              </Button>
            </li>
          </ul>
        </section>
        <section class="min-w-0 space-y-2">
          <h4 class="text-sm font-medium">
            {{ t('tools.libraryIntegrity.findings.unreadableDirectories', { count: findings.unreadableDirectories.total }) }}
          </h4>
          <p v-if="findings.unreadableDirectories.total > findings.unreadableDirectories.items.length" class="text-xs text-muted-foreground">
            {{
              t('tools.libraryIntegrity.findings.showingCount', {
                shown: findings.unreadableDirectories.items.length,
                total: findings.unreadableDirectories.total,
              })
            }}
          </p>
          <p v-if="findings.unreadableDirectories.items.length === 0" class="text-xs text-muted-foreground">
            {{ t('tools.libraryIntegrity.findings.none') }}
          </p>
          <ul v-else class="max-h-64 space-y-2 overflow-y-auto rounded-md bg-muted/30 p-3">
            <li v-for="item in findings.unreadableDirectories.items" :key="item.path" class="space-y-0.5 text-xs">
              <span class="block text-muted-foreground">{{ item.libraryName }}</span>
              <code class="block break-all text-foreground">{{ item.path }}</code>
            </li>
          </ul>
        </section>
      </div>
      <p v-if="findings?.truncated" class="mt-2 text-xs text-warning">{{ t('tools.libraryIntegrity.findings.scanTruncated') }}</p>
      <div v-if="findings?.hasMore" class="mt-3 flex justify-center">
        <Button size="sm" variant="outline" :disabled="findingsLoading" @click="loadFilesystemFindings(true)">{{
          findingsLoading ? t('tools.libraryIntegrity.findings.loadingMore') : t('tools.libraryIntegrity.findings.loadMore')
        }}</Button>
      </div>
    </section>

    <section class="grid gap-4 md:grid-cols-2" :aria-label="t('tools.libraryIntegrity.checksLabel')">
      <article class="flex flex-col gap-4 rounded-xl border border-border bg-card p-5">
        <div class="flex items-start justify-between gap-3">
          <div class="grid size-10 place-items-center rounded-lg bg-muted text-foreground">
            <Copy class="size-5" aria-hidden="true" />
          </div>
        </div>
        <div class="space-y-1">
          <h2 class="text-base font-semibold text-foreground">{{ t('tools.header.duplicateBooks') }}</h2>
          <p class="text-sm text-muted-foreground">{{ t('tools.libraryIntegrity.duplicateDescription') }}</p>
        </div>
        <Button class="mt-auto self-start" variant="outline" size="sm" @click="openDuplicateBooks">
          {{ t('tools.libraryIntegrity.openCheck') }}
          <ArrowRight class="size-4" aria-hidden="true" />
        </Button>
      </article>

      <article class="flex flex-col gap-4 rounded-xl border border-border bg-card p-5">
        <div class="flex items-start justify-between gap-3">
          <div class="grid size-10 place-items-center rounded-lg bg-muted text-foreground">
            <Merge class="size-5" aria-hidden="true" />
          </div>
        </div>
        <div class="space-y-1">
          <h2 class="text-base font-semibold text-foreground">{{ t('tools.header.bookMerge') }}</h2>
          <p class="text-sm text-muted-foreground">{{ t('tools.bookMerge.initial.description') }}</p>
        </div>
        <Button class="mt-auto self-start" variant="outline" size="sm" @click="openBookMerge">
          {{ t('tools.libraryIntegrity.openCheck') }}
          <ArrowRight class="size-4" aria-hidden="true" />
        </Button>
      </article>

      <article class="flex flex-col gap-4 rounded-xl border border-border bg-card p-5">
        <div class="flex items-start justify-between gap-3">
          <div class="grid size-10 place-items-center rounded-lg bg-muted text-foreground">
            <Files class="size-5" aria-hidden="true" />
          </div>
        </div>
        <div class="space-y-1">
          <h2 class="text-base font-semibold text-foreground">{{ t('tools.libraryIntegrity.duplicateFormats.title') }}</h2>
          <p class="text-sm text-muted-foreground">{{ t('tools.libraryIntegrity.duplicateFormats.description') }}</p>
        </div>
        <Button class="mt-auto self-start" variant="outline" size="sm" @click="openDuplicateFormats">
          {{ t('tools.libraryIntegrity.openCheck') }}
          <ArrowRight class="size-4" aria-hidden="true" />
        </Button>
      </article>
      <article class="flex flex-col gap-4 rounded-xl border border-border bg-card p-5">
        <div class="flex items-start justify-between gap-3">
          <div class="grid size-10 place-items-center rounded-lg bg-muted text-foreground">
            <GitMerge class="size-5" aria-hidden="true" />
          </div>
        </div>
        <div class="space-y-1">
          <h2 class="text-base font-semibold text-foreground">{{ t('tools.libraryIntegrity.seriesCleanup.title') }}</h2>
          <p class="text-sm text-muted-foreground">{{ t('tools.libraryIntegrity.seriesCleanup.description') }}</p>
        </div>
        <Button class="mt-auto self-start" variant="outline" size="sm" @click="openSeriesCleanup">
          {{ t('tools.libraryIntegrity.openCheck') }}
          <ArrowRight class="size-4" aria-hidden="true" />
        </Button>
      </article>
    </section>

    <section class="flex flex-col gap-4 rounded-xl border border-border bg-card p-5">
      <header class="space-y-1">
        <h2 class="text-lg font-semibold text-foreground">{{ t('tools.header.missingResources') }}</h2>
        <p class="text-sm text-muted-foreground">{{ t('tools.libraryIntegrity.missingDescription') }}</p>
      </header>
      <MissingResourcesView embedded />
    </section>

    <section class="rounded-xl border border-dashed border-border bg-card/30 p-5">
      <div class="flex items-start gap-3">
        <div class="grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
          <ShieldCheck class="size-4" aria-hidden="true" />
        </div>
        <div class="space-y-1">
          <h2 class="text-sm font-semibold text-foreground">{{ t('tools.libraryIntegrity.futureTitle') }}</h2>
          <p class="text-sm text-muted-foreground">{{ t('tools.libraryIntegrity.futureDescription') }}</p>
        </div>
      </div>
    </section>
  </div>
</template>
