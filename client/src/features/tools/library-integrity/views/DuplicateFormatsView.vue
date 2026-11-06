<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { AlertCircle, FileWarning, Loader2, RefreshCw } from '@lucide/vue'
import type { DuplicateFormatGroup } from '@bookorbit/types'

import { Button } from '@/components/ui/button'
import { getDuplicateFormatIssues } from '../../api/library-integrity'

const { t } = useI18n()
const items = ref<DuplicateFormatGroup[]>([])
const total = ref(0)
const page = ref(1)
const pageSize = 25
const loading = ref(false)
const loaded = ref(false)
const error = ref<string | null>(null)
const totalPages = computed(() => Math.max(1, Math.ceil(total.value / pageSize)))

function hasIdenticalContent(group: DuplicateFormatGroup): boolean {
  const hashes = group.files.map((file) => file.fileHash)
  return hashes.length > 1 && hashes.every((hash) => hash !== null && hash === hashes[0])
}

function formatBytes(value: number | null): string {
  if (value === null) return t('tools.libraryIntegrity.duplicateFormats.unknownSize')
  if (value < 1024) return `${value} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let size = value / 1024
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit++
  }
  return `${size.toFixed(1)} ${units[unit]}`
}

async function load(): Promise<void> {
  loading.value = true
  error.value = null
  try {
    const result = await getDuplicateFormatIssues({ page: page.value, pageSize })
    items.value = result.items
    total.value = result.total
    loaded.value = true
  } catch {
    error.value = t('tools.libraryIntegrity.duplicateFormats.loadFailed')
  } finally {
    loading.value = false
  }
}

function previousPage(): void {
  if (page.value > 1) {
    page.value--
    void load()
  }
}

function nextPage(): void {
  if (page.value < totalPages.value) {
    page.value++
    void load()
  }
}

onMounted(() => void load())
</script>

<template>
  <div class="flex h-full min-h-0 flex-col gap-4 overflow-y-auto pr-1">
    <header class="flex flex-wrap items-start justify-between gap-3">
      <div class="space-y-1">
        <h1 class="text-2xl font-semibold tracking-tight text-foreground">{{ t('tools.libraryIntegrity.duplicateFormats.title') }}</h1>
        <p class="max-w-3xl text-sm text-muted-foreground">{{ t('tools.libraryIntegrity.duplicateFormats.description') }}</p>
      </div>
      <Button variant="outline" size="sm" :disabled="loading" @click="load">
        <RefreshCw class="size-4" :class="{ 'animate-spin': loading }" aria-hidden="true" />
        {{ t('tools.libraryIntegrity.duplicateFormats.refresh') }}
      </Button>
    </header>

    <div
      v-if="error"
      role="alert"
      class="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive"
    >
      <AlertCircle class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      {{ error }}
    </div>

    <div class="flex items-center justify-between gap-3 text-sm text-muted-foreground" aria-live="polite">
      <span>{{ t('tools.libraryIntegrity.duplicateFormats.resultCount', { count: total }) }}</span>
      <span v-if="loaded">{{ t('tools.libraryIntegrity.duplicateFormats.page', { page, total: totalPages }) }}</span>
    </div>

    <div v-if="loading && !loaded" class="flex flex-1 items-center justify-center py-12">
      <Loader2 class="size-6 animate-spin text-muted-foreground" aria-hidden="true" />
      <span class="sr-only">{{ t('common.loading') }}</span>
    </div>

    <div
      v-else-if="loaded && items.length === 0"
      class="flex flex-1 flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border/60 bg-card/20 p-10 text-center"
    >
      <div class="flex size-14 items-center justify-center rounded-full bg-muted/70">
        <FileWarning class="size-6 text-muted-foreground" aria-hidden="true" />
      </div>
      <p class="text-base font-semibold text-foreground">{{ t('tools.libraryIntegrity.duplicateFormats.emptyTitle') }}</p>
      <p class="max-w-md text-sm text-muted-foreground">{{ t('tools.libraryIntegrity.duplicateFormats.emptyDescription') }}</p>
    </div>

    <section v-else class="flex flex-col gap-3">
      <article v-for="group in items" :key="`${group.bookId}-${group.format}`" class="rounded-lg border border-border bg-card p-4">
        <div class="flex flex-wrap items-start justify-between gap-2">
          <div class="min-w-0 space-y-1">
            <h2 class="font-semibold text-foreground">{{ group.title || t('tools.libraryIntegrity.duplicateFormats.untitled') }}</h2>
            <p class="break-all text-xs text-muted-foreground">{{ group.folderPath }}</p>
            <p class="text-xs text-muted-foreground">{{ group.libraryName }}</p>
          </div>
          <div class="flex shrink-0 flex-wrap items-center gap-2">
            <span class="rounded-md bg-muted px-2 py-1 text-xs font-medium uppercase">{{ group.format }}</span>
            <span class="rounded-md border border-border px-2 py-1 text-xs">{{
              t('tools.libraryIntegrity.duplicateFormats.fileCount', { count: group.fileCount })
            }}</span>
            <span v-if="hasIdenticalContent(group)" class="rounded-md border border-border bg-muted px-2 py-1 text-xs text-muted-foreground">{{
              t('tools.libraryIntegrity.duplicateFormats.identical')
            }}</span>
          </div>
        </div>
        <ul class="mt-3 space-y-2 border-t border-border pt-3">
          <li v-for="file in group.files" :key="file.id" class="flex flex-wrap items-start justify-between gap-2 text-sm">
            <span class="min-w-0 break-all text-foreground">{{ file.absolutePath }}</span>
            <span class="shrink-0 text-xs text-muted-foreground">{{ formatBytes(file.sizeBytes) }}</span>
          </li>
        </ul>
      </article>
    </section>

    <nav v-if="totalPages > 1" class="flex items-center justify-center gap-3">
      <Button variant="outline" size="sm" :disabled="page <= 1 || loading" @click="previousPage">{{ t('common.previous') }}</Button>
      <span class="text-sm text-muted-foreground">{{ t('tools.libraryIntegrity.duplicateFormats.page', { page, total: totalPages }) }}</span>
      <Button variant="outline" size="sm" :disabled="page >= totalPages || loading" @click="nextPage">{{ t('common.next') }}</Button>
    </nav>
  </div>
</template>
