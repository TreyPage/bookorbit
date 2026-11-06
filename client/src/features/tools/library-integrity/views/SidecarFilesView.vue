<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { AlertCircle, FileWarning, Loader2, RefreshCw } from '@lucide/vue'

import { Button } from '@/components/ui/button'
import { getSidecarFileIssues, type SidecarFileEntry } from '../../api/library-integrity'

const items = ref<SidecarFileEntry[]>([])
const total = ref(0)
const page = ref(1)
const pageSize = 25
const truncated = ref(false)
const loading = ref(false)
const loaded = ref(false)
const error = ref<string | null>(null)
const totalPages = computed(() => Math.max(1, Math.ceil(total.value / pageSize)))

const kindLabels: Record<SidecarFileEntry['kind'], string> = {
  text_file: 'Text file (.txt)',
  temporary_file: 'Temporary file',
  conversion_directory: 'Conversion leftovers directory',
}

function formatBytes(value: number): string {
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
    const result = await getSidecarFileIssues({ page: page.value, pageSize })
    items.value = result.items
    total.value = result.total
    truncated.value = result.truncated
    loaded.value = true
  } catch {
    error.value = 'Could not scan library sidecar files. Please try again.'
  } finally {
    loading.value = false
  }
}

function changePage(next: number): void {
  if (next < 1 || next > totalPages.value || loading.value) return
  page.value = next
  void load()
}

onMounted(() => void load())
</script>

<template>
  <div class="flex h-full min-h-0 flex-col gap-4 overflow-y-auto pr-1">
    <header class="flex flex-wrap items-start justify-between gap-3">
      <div class="space-y-1">
        <h1 class="text-2xl font-semibold tracking-tight text-foreground">Sidecar and temporary files</h1>
        <p class="max-w-3xl text-sm text-muted-foreground">
          Review .txt files, temporary download files, and .chaptarr-conversions folders found inside accessible library folders.
          This scan does not modify or delete files.
        </p>
      </div>
      <Button variant="outline" size="sm" :disabled="loading" @click="load">
        <RefreshCw class="size-4" :class="{ 'animate-spin': loading }" aria-hidden="true" />
        Scan again
      </Button>
    </header>

    <div v-if="truncated" role="status" class="rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
      The scan reached its safety limit before all library folders could be checked. Run another scan after narrowing the library scope.
    </div>
    <div v-if="error" role="alert" class="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
      <AlertCircle class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      {{ error }}
    </div>

    <div class="flex items-center justify-between gap-3 text-sm text-muted-foreground" aria-live="polite">
      <span>{{ total }} potential cleanup item(s)</span>
      <span v-if="loaded">Page {{ page }} of {{ totalPages }}</span>
    </div>

    <div v-if="loading && !loaded" class="flex flex-1 items-center justify-center py-12">
      <Loader2 class="size-6 animate-spin text-muted-foreground" aria-hidden="true" />
    </div>
    <div v-else-if="loaded && items.length === 0" class="flex flex-1 flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border/60 bg-card/20 p-10 text-center">
      <FileWarning class="size-6 text-muted-foreground" aria-hidden="true" />
      <p class="text-base font-semibold text-foreground">No sidecar or temporary files found</p>
      <p class="max-w-md text-sm text-muted-foreground">The scanned library folders did not contain any of the file patterns this check recognizes.</p>
    </div>
    <section v-else class="flex flex-col gap-3">
      <article v-for="item in items" :key="`${item.libraryId}:${item.path}`" class="rounded-lg border border-border bg-card p-4">
        <div class="flex flex-wrap items-start justify-between gap-2">
          <div class="min-w-0 space-y-1">
            <p class="font-medium text-foreground">{{ kindLabels[item.kind] }}</p>
            <p class="break-all text-sm text-foreground">{{ item.path }}</p>
            <p class="text-xs text-muted-foreground">{{ item.libraryName }}</p>
          </div>
          <span class="shrink-0 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground">
            {{ formatBytes(item.sizeBytes) }}<template v-if="item.kind === 'conversion_directory'"> · {{ item.fileCount }} file(s)</template>
          </span>
        </div>
      </article>
    </section>

    <nav v-if="totalPages > 1" class="flex items-center justify-center gap-3">
      <Button variant="outline" size="sm" :disabled="page <= 1 || loading" @click="changePage(page - 1)">Previous</Button>
      <span class="text-sm text-muted-foreground">Page {{ page }} of {{ totalPages }}</span>
      <Button variant="outline" size="sm" :disabled="page >= totalPages || loading" @click="changePage(page + 1)">Next</Button>
    </nav>
  </div>
</template>
