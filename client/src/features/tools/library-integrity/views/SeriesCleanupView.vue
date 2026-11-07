<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { AlertCircle, GitMerge, Loader2, RefreshCw } from '@lucide/vue'
import type { SimilarSeriesPair } from '@bookorbit/types'
import { Button } from '@/components/ui/button'
import { getSimilarSeriesCandidates, mergeSimilarSeries, type SeriesMergeError } from '../../api/library-integrity'

const { t } = useI18n()
const items = ref<SimilarSeriesPair[]>([])
const targets = ref<Record<string, number>>({})
const loading = ref(false)
const loaded = ref(false)
const busy = ref<string | null>(null)
const confirmKey = ref<string | null>(null)
const conflictCount = ref(0)
const truncated = ref(false)
const error = ref<string | null>(null)

const keyOf = (pair: SimilarSeriesPair) => `${pair.left.id}-${pair.right.id}`
const targetOf = (pair: SimilarSeriesPair): number => targets.value[keyOf(pair)] ?? pair.left.id
const sourceOf = (pair: SimilarSeriesPair) => (targetOf(pair) === pair.left.id ? pair.right.id : pair.left.id)

async function load() {
  loading.value = true
  error.value = null
  confirmKey.value = null
  try {
    const result = await getSimilarSeriesCandidates()
    items.value = result.items
    truncated.value = result.truncated
    for (const pair of result.items) {
      const key = keyOf(pair)
      if (targets.value[key] !== pair.left.id && targets.value[key] !== pair.right.id) targets.value[key] = pair.left.id
    }
    loaded.value = true
  } catch {
    error.value = t('tools.libraryIntegrity.seriesCleanup.loadFailed')
  } finally {
    loading.value = false
  }
}

async function merge(pair: SimilarSeriesPair, confirmPositionConflicts = false) {
  const key = keyOf(pair)
  busy.value = key
  error.value = null
  try {
    await mergeSimilarSeries({
      targetSeriesId: targetOf(pair),
      sourceSeriesIds: [sourceOf(pair)],
      confirmPositionConflicts,
    })
    await load()
  } catch (caught) {
    const failure = caught as SeriesMergeError
    if (failure.status === 409 && failure.body.errorCode === 'series_position_conflicts' && !confirmPositionConflicts) {
      confirmKey.value = key
      conflictCount.value = Number(failure.body.errorMeta?.conflictCount ?? 0)
    } else if (failure.status === 409 && failure.body.errorCode === 'series_has_inaccessible_books') {
      error.value = t('tools.libraryIntegrity.seriesCleanup.inaccessibleError')
    } else {
      error.value = t('tools.libraryIntegrity.seriesCleanup.mergeFailed')
    }
  } finally {
    busy.value = null
  }
}

onMounted(() => void load())
</script>

<template>
  <div class="flex h-full min-h-0 flex-col gap-4 overflow-y-auto pr-1">
    <header class="flex flex-wrap items-start justify-between gap-3">
      <div class="space-y-1">
        <h1 class="text-2xl font-semibold tracking-tight text-foreground">{{ t('tools.libraryIntegrity.seriesCleanup.title') }}</h1>
        <p class="max-w-3xl text-sm text-muted-foreground">{{ t('tools.libraryIntegrity.seriesCleanup.description') }}</p>
      </div>
      <Button variant="outline" size="sm" :disabled="loading || busy !== null" @click="load">
        <RefreshCw class="size-4" :class="{ 'animate-spin': loading }" aria-hidden="true" />
        {{ t('tools.libraryIntegrity.seriesCleanup.refresh') }}
      </Button>
    </header>

    <div
      v-if="error"
      role="alert"
      class="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive"
    >
      <AlertCircle class="size-4 shrink-0" aria-hidden="true" />{{ error }}
    </div>
    <p v-if="truncated" role="status" class="rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
      {{ t('tools.libraryIntegrity.seriesCleanup.truncated') }}
    </p>
    <p class="text-sm text-muted-foreground" aria-live="polite">
      {{ t('tools.libraryIntegrity.seriesCleanup.resultCount', { count: items.length }) }}
    </p>

    <div v-if="loading && !loaded" class="flex flex-1 items-center justify-center py-12">
      <Loader2 class="size-6 animate-spin text-muted-foreground" aria-hidden="true" />
      <span class="sr-only">{{ t('common.loading') }}</span>
    </div>
    <div
      v-else-if="loaded && items.length === 0"
      class="flex flex-1 flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border/60 p-10 text-center"
    >
      <GitMerge class="size-6 text-muted-foreground" aria-hidden="true" />
      <p class="font-semibold text-foreground">{{ t('tools.libraryIntegrity.seriesCleanup.emptyTitle') }}</p>
      <p class="max-w-md text-sm text-muted-foreground">{{ t('tools.libraryIntegrity.seriesCleanup.emptyDescription') }}</p>
    </div>
    <section v-else class="flex flex-col gap-3">
      <article v-for="pair in items" :key="keyOf(pair)" class="rounded-lg border border-border bg-card p-4">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div class="flex flex-wrap items-center gap-2">
            <h2 class="font-semibold text-foreground">{{ pair.left.name }}</h2>
            <span class="text-xs text-muted-foreground">↔</span>
            <h2 class="font-semibold text-foreground">{{ pair.right.name }}</h2>
          </div>
          <span class="text-xs text-muted-foreground">{{
            t('tools.libraryIntegrity.seriesCleanup.similarity', { value: Math.round(pair.similarity * 100) })
          }}</span>
        </div>
        <p class="mt-1 text-xs text-muted-foreground">
          {{ t('tools.libraryIntegrity.seriesCleanup.bookCounts', { left: pair.left.bookCount, right: pair.right.bookCount }) }}
        </p>
        <p
          v-if="!pair.mergeAllowed"
          class="mt-3 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm text-amber-700 dark:text-amber-300"
        >
          {{
            t('tools.libraryIntegrity.seriesCleanup.inaccessibleWarning', {
              left: pair.left.inaccessibleBookCount,
              right: pair.right.inaccessibleBookCount,
            })
          }}
        </p>
        <div class="mt-4 flex flex-wrap items-end gap-3 border-t border-border pt-3">
          <label class="min-w-0 flex-1 space-y-1 text-sm">
            <span class="font-medium text-foreground">{{ t('tools.libraryIntegrity.seriesCleanup.canonicalLabel') }}</span>
            <select
              v-model.number="targets[keyOf(pair)]"
              class="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              :disabled="!pair.mergeAllowed || busy !== null"
            >
              <option :value="pair.left.id">{{ pair.left.name }}</option>
              <option :value="pair.right.id">{{ pair.right.name }}</option>
            </select>
          </label>
          <Button size="sm" :disabled="!pair.mergeAllowed || busy !== null" @click="merge(pair)">
            <Loader2 v-if="busy === keyOf(pair)" class="size-4 animate-spin" aria-hidden="true" />
            <GitMerge v-else class="size-4" aria-hidden="true" />
            {{ t('tools.libraryIntegrity.seriesCleanup.merge') }}
          </Button>
        </div>
        <div v-if="confirmKey === keyOf(pair)" class="mt-3 rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
          <p class="text-sm text-foreground">{{ t('tools.libraryIntegrity.seriesCleanup.positionConflictWarning', { count: conflictCount }) }}</p>
          <div class="mt-2 flex justify-end">
            <Button size="sm" variant="destructive" :disabled="busy !== null" @click="merge(pair, true)">{{
              t('tools.libraryIntegrity.seriesCleanup.confirmPositionMerge')
            }}</Button>
          </div>
        </div>
      </article>
    </section>
  </div>
</template>
