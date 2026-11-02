<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { AlertCircle, ChevronDown } from '@lucide/vue'
import type { MissingSeriesBook, MissingSeriesBooksStatus } from '@bookorbit/types'

const { t } = useI18n()
const collapsed = ref(false)

const props = withDefaults(
  defineProps<{
    gaps: number[]
    missingBooks?: MissingSeriesBook[]
    authors?: string[]
    lookupStatus?: MissingSeriesBooksStatus
    canRequest?: boolean
  }>(),
  { missingBooks: () => [], authors: () => [], lookupStatus: 'not_configured', canRequest: false },
)
const emit = defineEmits<{ request: [book: MissingSeriesBook]; discover: [index: number]; retry: [] }>()
const gapsLabel = computed(() => props.gaps.map((gap) => `#${gap}`).join(', '))
const listedBooks = computed(() => {
  const booksByIndex = new Map(props.missingBooks.map((book) => [book.index, book]))
  return props.gaps.map((index) => ({ index, book: booksByIndex.get(index) ?? null }))
})
const unresolvedCount = computed(() => Math.max(0, props.gaps.length - props.missingBooks.length))
const lookupMessage = computed(() => {
  if (props.missingBooks.length > 0) {
    return unresolvedCount.value > 0 ? t('series.gaps.partialTitles', { count: unresolvedCount.value }) : null
  }
  switch (props.lookupStatus) {
    case 'not_configured':
      return t('series.gaps.connectHardcover')
    case 'not_found':
      return t('series.gaps.titlesNotFound')
    case 'failed':
      return t('series.gaps.titleLookupFailed')
    case 'insufficient_scope':
      return t('series.gaps.catalogScopeRequired')
    case 'not_loaded':
      return t('series.gaps.titleLookupLoading')
    case 'available':
    case 'no_missing':
      return null
  }
})

function handleRequest(book: MissingSeriesBook): void {
  emit('request', book)
}

function handleRetry(): void {
  emit('retry')
}

function handleDiscover(index: number): void {
  emit('discover', index)
}

function toggleCollapsed(): void {
  collapsed.value = !collapsed.value
}
</script>

<template>
  <section v-if="gaps.length > 0" class="flex flex-col gap-3 rounded-lg border border-primary/30 bg-primary/5 p-3">
    <div class="flex items-start justify-between gap-2">
      <div class="flex min-w-0 items-start gap-2">
        <AlertCircle :size="18" class="mt-0.5 shrink-0 text-primary" aria-hidden="true" />
        <div class="min-w-0">
          <h2 class="text-sm font-semibold text-foreground">{{ t('series.gaps.label') }}</h2>
          <p class="mt-0.5 text-xs text-muted-foreground">{{ t('series.gaps.missingList', { list: gapsLabel }) }}</p>
          <p class="mt-0.5 text-xs text-muted-foreground">{{ t('series.gaps.orderHint') }}</p>
        </div>
      </div>
      <button
        type="button"
        class="inline-flex min-h-8 shrink-0 items-center gap-1 rounded-md px-2 text-xs font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        :aria-expanded="!collapsed"
        aria-controls="series-gap-details"
        @click="toggleCollapsed"
      >
        {{ collapsed ? t('series.gaps.expand') : t('series.gaps.collapse') }}
        <ChevronDown :size="14" class="transition-transform" :class="collapsed ? '' : 'rotate-180'" aria-hidden="true" />
      </button>
    </div>
    <div v-if="!collapsed" id="series-gap-details" class="flex flex-col gap-3">
      <p v-if="lookupMessage" role="status" class="ps-6 text-sm text-muted-foreground">{{ lookupMessage }}</p>
      <button
        v-if="lookupStatus === 'failed'"
        type="button"
        class="ms-6 w-fit text-sm font-medium text-primary underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        @click="handleRetry"
      >
        {{ t('series.gaps.retryTitleLookup') }}
      </button>
      <ul class="space-y-2 ps-6">
        <li
          v-for="{ index, book } in listedBooks"
          :key="index"
          class="flex flex-col gap-2 rounded-md border border-border bg-card p-3 sm:flex-row sm:items-center"
        >
          <div class="min-w-0 flex-1">
            <p class="text-xs font-medium text-muted-foreground">{{ t('series.gaps.volume', { number: index }) }}</p>
            <template v-if="book">
              <p class="truncate text-sm font-semibold text-foreground" :title="book.title">{{ book.title }}</p>
              <p v-if="book.authors.length" class="truncate text-xs text-muted-foreground">{{ book.authors.join(', ') }}</p>
            </template>
            <template v-else>
              <p class="text-sm font-semibold text-foreground">{{ t('series.gaps.titleUnavailable') }}</p>
              <p v-if="authors.length" class="truncate text-xs text-muted-foreground">{{ authors.join(', ') }}</p>
            </template>
          </div>
          <button
            v-if="canRequest && book"
            type="button"
            class="inline-flex min-h-9 shrink-0 items-center justify-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            :aria-label="t('series.gaps.requestTitle', { title: book.title })"
            @click="handleRequest(book)"
          >
            {{ t('series.gaps.requestTitle', { title: book.title }) }}
          </button>
          <button
            v-else-if="canRequest"
            type="button"
            class="inline-flex min-h-9 shrink-0 items-center justify-center rounded-md border border-input bg-background px-3 text-sm font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            :aria-label="t('series.gaps.findTitle', { number: index })"
            @click="handleDiscover(index)"
          >
            {{ t('series.gaps.findTitle', { number: index }) }}
          </button>
        </li>
      </ul>
    </div>
  </section>
</template>
