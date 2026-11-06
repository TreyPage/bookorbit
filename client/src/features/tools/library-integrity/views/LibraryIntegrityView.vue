<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { ArrowRight, Copy, Files, GitMerge, Merge, RefreshCw, ShieldCheck } from '@lucide/vue'

import type { LibraryFilesystemFindingsResult, LibraryIntegrityScanStatus } from '@bookorbit/types'

import { getLibraryFilesystemFindings, getLibraryIntegrityScanStatus, startLibraryIntegrityScan } from '@/features/tools/api/library-integrity'
import MissingResourcesView from '@/features/tools/missing-resources/views/MissingResourcesView.vue'

import { Button } from '@/components/ui/button'

const router = useRouter()
const { t } = useI18n()
const scanStatus = ref<LibraryIntegrityScanStatus | null>(null)
const scanLoading = ref(false)
const scanError = ref(false)
const findings = ref<LibraryFilesystemFindingsResult | null>(null)
const findingsLoading = ref(false)
const findingsError = ref(false)
const scanMetrics = computed(() => {
  const summary = scanStatus.value?.summary
  if (!summary) return []
  return [
    { key: 'libraries', value: summary.libraryCount },
    { key: 'duplicateGroups', value: summary.duplicateFormatGroups },
    { key: 'duplicateFiles', value: summary.duplicateFormatFiles },
    { key: 'sidecars', value: summary.sidecarEntries },
    { key: 'orphanedMetadata', value: summary.orphanedMetadataFiles },
    { key: 'emptyFolders', value: summary.emptyBookFolders },
    { key: 'unreadableDirectories', value: summary.unreadableDirectories ?? 0 },
    { key: 'orphanedCovers', value: summary.orphanedCoverDirectories },
    { key: 'coverBytes', value: summary.orphanedCoverBytes },
  ]
})

async function loadFilesystemFindings(): Promise<void> {
  findingsLoading.value = true
  findingsError.value = false
  try {
    findings.value = await getLibraryFilesystemFindings()
  } catch {
    findingsError.value = true
  } finally {
    findingsLoading.value = false
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

async function runScan(): Promise<void> {
  scanLoading.value = true
  scanError.value = false
  try {
    scanStatus.value = await startLibraryIntegrityScan()
  } catch {
    scanError.value = true
  } finally {
    scanLoading.value = false
  }
}

function formatScanDate(value: string | null): string {
  return value ? new Date(value).toLocaleString() : t('tools.libraryIntegrity.scanStatus.notCompleted')
}

onMounted(() => { void refreshScanStatus() })

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
          <span><strong>{{ t('tools.libraryIntegrity.scanStatus.status') }}:</strong> {{ t('tools.libraryIntegrity.scanStatus.states.' + scanStatus.status) }}</span>
          <span><strong>{{ t('tools.libraryIntegrity.scanStatus.started') }}:</strong> {{ formatScanDate(scanStatus.startedAt) }}</span>
          <span v-if="scanStatus.completedAt"><strong>{{ t('tools.libraryIntegrity.scanStatus.completed') }}:</strong> {{ formatScanDate(scanStatus.completedAt) }}</span>
        </div>
        <p v-if="scanStatus.errorMessage" class="text-sm text-destructive">{{ scanStatus.errorMessage }}</p>
        <dl v-if="scanStatus.summary" class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div v-for="item in scanMetrics" :key="item.key" class="rounded-lg bg-muted/50 px-3 py-2">
            <dt class="text-xs text-muted-foreground">{{ t('tools.libraryIntegrity.scanStatus.metrics.' + item.key) }}</dt>
            <dd class="text-lg font-semibold tabular-nums text-foreground">{{ item.key === 'coverBytes' ? (item.value / 1024 / 1024).toFixed(2) + ' MB' : item.value }}</dd>
          </div>
        </dl>
        <p v-if="scanStatus.summary?.sidecarScanTruncated || scanStatus.summary?.filesystemScanTruncated" class="text-sm text-warning">{{ t('tools.libraryIntegrity.scanStatus.truncated') }}</p>
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
          <div v-else-if="findings" class="mt-3 grid gap-4 lg:grid-cols-2">
            <section class="min-w-0 space-y-2">
              <h4 class="text-sm font-medium">{{ t('tools.libraryIntegrity.findings.orphanedMetadata', { count: findings.orphanedMetadataFiles.total }) }}</h4>
              <p v-if="findings.orphanedMetadataFiles.items.length === 0" class="text-xs text-muted-foreground">{{ t('tools.libraryIntegrity.findings.none') }}</p>
              <ul v-else class="max-h-64 space-y-2 overflow-y-auto rounded-md bg-muted/30 p-3">
                <li v-for="item in findings.orphanedMetadataFiles.items" :key="item.path" class="space-y-0.5 text-xs">
                  <span class="block text-muted-foreground">{{ item.libraryName }}</span>
                  <code class="block break-all text-foreground">{{ item.path }}</code>
                </li>
              </ul>
            </section>
            <section class="min-w-0 space-y-2">
              <h4 class="text-sm font-medium">{{ t('tools.libraryIntegrity.findings.emptyFolders', { count: findings.emptyBookFolders.total }) }}</h4>
              <p v-if="findings.emptyBookFolders.items.length === 0" class="text-xs text-muted-foreground">{{ t('tools.libraryIntegrity.findings.none') }}</p>
              <ul v-else class="max-h-64 space-y-2 overflow-y-auto rounded-md bg-muted/30 p-3">
                <li v-for="item in findings.emptyBookFolders.items" :key="item.path" class="space-y-0.5 text-xs">
                  <span class="block text-muted-foreground">{{ item.libraryName }}</span>
                  <code class="block break-all text-foreground">{{ item.path }}</code>
                </li>
              </ul>
            </section>
            <section class="min-w-0 space-y-2">
              <h4 class="text-sm font-medium">{{ t('tools.libraryIntegrity.findings.unreadableDirectories', { count: findings.unreadableDirectories.total }) }}</h4>
              <p v-if="findings.unreadableDirectories.items.length === 0" class="text-xs text-muted-foreground">{{ t('tools.libraryIntegrity.findings.none') }}</p>
              <ul v-else class="max-h-64 space-y-2 overflow-y-auto rounded-md bg-muted/30 p-3">
                <li v-for="item in findings.unreadableDirectories.items" :key="item.path" class="space-y-0.5 text-xs">
                  <span class="block text-muted-foreground">{{ item.libraryName }}</span>
                  <code class="block break-all text-foreground">{{ item.path }}</code>
                </li>
              </ul>
            </section>
          </div>
          <p v-if="findings?.truncated || findings?.resultsTruncated" class="mt-2 text-xs text-warning">{{ t('tools.libraryIntegrity.findings.truncated') }}</p>
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
