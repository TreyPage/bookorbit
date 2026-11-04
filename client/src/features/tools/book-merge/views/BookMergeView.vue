<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { AlertCircle, ArrowRightLeft, Loader2, Merge, Search, FolderTree } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import type { BookMergeCandidatePair } from '@bookorbit/types'

import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import { Button } from '@/components/ui/button'
import { usePermissions } from '@/features/auth/composables/usePermissions'
import { useLibraries } from '@/features/library/composables/useLibraries'
import { useBookMerge } from '../../composables/useBookMerge'
import { Select } from '@/components/ui/select'
import { formatNumber } from '@/i18n/formatters'

const { t } = useI18n()
const { hasPermission, isDemoRestrictedAccount } = usePermissions()
const { libraries, fetchLibraries, error: librariesError } = useLibraries()
const mergeTool = useBookMerge()

const selectedLibraryId = ref('')
const similarityPercent = ref(85)
const searchedLibraryId = ref('')
const searchedSimilarityPercent = ref(85)
const targetBookIds = ref(new Map<string, number>())
const pendingMerge = ref<{ pair: BookMergeCandidatePair; targetBookId: number } | null>(null)

const canUseTool = computed(() => hasPermission('library_delete_books'))
const canMerge = computed(() => canUseTool.value && !isDemoRestrictedAccount.value)
const filtersChanged = computed(
  () =>
    mergeTool.loaded.value && (selectedLibraryId.value !== searchedLibraryId.value || similarityPercent.value !== searchedSimilarityPercent.value),
)
const confirmTarget = computed(() => pendingMerge.value?.pair.books.find((book) => book.id === pendingMerge.value?.targetBookId))
const confirmSource = computed(() => pendingMerge.value?.pair.books.find((book) => book.id !== pendingMerge.value?.targetBookId))
const confirmDescription = computed(() =>
  t('tools.bookMerge.confirm.description', {
    source: confirmSource.value?.title ?? t('tools.bookMerge.unknownTitle'),
    target: confirmTarget.value?.title ?? t('tools.bookMerge.unknownTitle'),
  }),
)

onMounted(() => {
  if (canUseTool.value) void fetchLibraries()
})

function pairKey(pair: BookMergeCandidatePair): string {
  return `${pair.bookIdA}-${pair.bookIdB}`
}

function targetBookId(pair: BookMergeCandidatePair): number {
  return targetBookIds.value.get(pairKey(pair)) ?? pair.books[0].id
}

function formatAuthors(authors: string[]): string {
  return authors.length > 0 ? authors.join(', ') : t('tools.bookMerge.unknownAuthor')
}

function formatSimilarity(pair: BookMergeCandidatePair): string {
  return `${Math.round(pair.titleSimilarity * 100)}%`
}

function handleLibraryChange(event: Event): void {
  if (event.currentTarget instanceof HTMLSelectElement) selectedLibraryId.value = event.currentTarget.value
}

function handleSimilaritySelect(event: Event): void {
  if (!(event.currentTarget instanceof HTMLSelectElement)) return

  similarityPercent.value = Number(event.currentTarget.value)
}

function handleChooseTarget(event: Event): void {
  if (!(event.currentTarget instanceof HTMLInputElement)) return
  const key = event.currentTarget.dataset.pairKey
  const bookId = Number(event.currentTarget.value)
  if (!key || !Number.isInteger(bookId) || bookId < 1) return
  const next = new Map(targetBookIds.value)
  next.set(key, bookId)
  targetBookIds.value = next
}

function handleFindMatches(): void {
  const libraryId = selectedLibraryId.value ? Number(selectedLibraryId.value) : undefined
  searchedLibraryId.value = selectedLibraryId.value
  searchedSimilarityPercent.value = similarityPercent.value
  void mergeTool.loadCandidates(libraryId, similarityPercent.value)
}

function handleLoadMore(): void {
  void mergeTool.loadMore()
}

function handleRequestMerge(pair: BookMergeCandidatePair): void {
  if (!canMerge.value) return
  pendingMerge.value = { pair, targetBookId: targetBookId(pair) }
}

function handleCancelMerge(): void {
  if (mergeTool.merging.value) return
  pendingMerge.value = null
}

async function handleConfirmMerge(): Promise<void> {
  const request = pendingMerge.value
  if (!request) return
  if (await mergeTool.merge(request.pair, request.targetBookId)) pendingMerge.value = null
}
</script>

<template>
  <div v-if="!canUseTool" role="alert" class="rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground">
    {{ t('tools.bookMerge.accessDenied') }}
  </div>

  <div v-else class="flex h-full min-h-0 w-full flex-col gap-4 overflow-y-auto pr-1">
    <section class="flex shrink-0 flex-col gap-2 rounded-xl border border-border bg-card px-2.5 py-2">
      <div class="flex flex-wrap items-center gap-2">
        <label class="flex min-w-0 flex-1 basis-40 items-center gap-1.5 sm:flex-none">
          <span class="sr-only">{{ t('tools.bookMerge.library') }}</span>
          <FolderTree class="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <Select
            class="h-8 w-full min-w-0 text-[12.5px] sm:w-auto sm:min-w-[10rem]"
            :model-value="selectedLibraryId"
            :disabled="mergeTool.loading.value || mergeTool.merging.value"
            @change="handleLibraryChange"
          >
            <option value="">{{ t('tools.bookMerge.allLibraries') }}</option>
            <option v-for="library in libraries" :key="library.id" :value="String(library.id)">
              {{ library.name }}
            </option>
          </Select>
        </label>

        <label class="flex shrink-0 items-center gap-1.5">
          <span class="hidden text-[12.5px] whitespace-nowrap text-muted-foreground sm:inline">
            {{ t('tools.bookMerge.similarity') }}
          </span>
          <Select
            class="h-8 w-auto min-w-[6.5rem] text-[12.5px]"
            :model-value="similarityPercent"
            :disabled="mergeTool.loading.value || mergeTool.merging.value"
            @change="handleSimilaritySelect"
          >
            <option v-for="value in [70, 75, 80, 85, 90, 95, 100]" :key="value" :value="value">
              {{ t('tools.bookMerge.similarityOption', { percent: formatNumber(value / 100, { style: 'percent' }) }) }}
            </option>
          </Select>
        </label>

        <Button class="ms-auto h-8 shrink-0" size="sm" :disabled="mergeTool.loading.value || mergeTool.merging.value" @click="handleFindMatches">
          <Loader2 v-if="mergeTool.loading.value" class="animate-spin" aria-hidden="true" />
          <Search v-else aria-hidden="true" />
          {{ t('tools.bookMerge.findMatches') }}
        </Button>
      </div>
    </section>

    <p v-if="librariesError" role="alert" class="text-sm text-destructive">{{ librariesError }}</p>
    <p v-if="isDemoRestrictedAccount" role="status" class="text-sm text-muted-foreground">
      {{ t('tools.bookMerge.demoRestricted') }}
    </p>
    <div
      v-if="mergeTool.error.value"
      role="alert"
      class="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive"
    >
      <AlertCircle class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <span>{{ mergeTool.error.value }}</span>
    </div>

    <div v-if="mergeTool.loading.value && mergeTool.candidates.value.length === 0" class="flex flex-1 items-center justify-center py-10">
      <Loader2 class="size-6 animate-spin text-muted-foreground" aria-hidden="true" />
      <span class="sr-only">{{ t('common.loading') }}</span>
    </div>

    <section
      v-else-if="mergeTool.loaded.value && mergeTool.candidates.value.length === 0"
      class="rounded-lg border border-dashed border-border/60 bg-card/20 p-10 text-center"
    >
      <p class="text-base font-semibold text-foreground">{{ t('tools.bookMerge.empty.title') }}</p>
      <p class="mt-1 text-sm text-muted-foreground">{{ t('tools.bookMerge.empty.description') }}</p>
    </section>

    <section v-else-if="mergeTool.candidates.value.length > 0" class="flex flex-col gap-3">
      <p class="text-sm text-muted-foreground" aria-live="polite">
        {{ t('tools.bookMerge.matchCount', { count: mergeTool.candidates.value.length }) }}
      </p>
      <p v-if="filtersChanged" class="text-sm text-muted-foreground">{{ t('tools.bookMerge.filtersChanged') }}</p>

      <article v-for="pair in mergeTool.candidates.value" :key="pairKey(pair)" class="rounded-lg border border-border bg-card p-4">
        <header class="mb-3 flex flex-wrap items-center justify-between gap-2">
          <span class="text-sm font-medium text-muted-foreground">
            {{ t('tools.bookMerge.similarTitle', { percent: formatSimilarity(pair) }) }}
          </span>
          <Button size="sm" :disabled="!canMerge || mergeTool.merging.value" @click="handleRequestMerge(pair)">
            <Merge aria-hidden="true" />
            {{ t('tools.bookMerge.mergeIntoSelected') }}
          </Button>
        </header>

        <div class="grid gap-3 md:grid-cols-2">
          <div
            v-for="book in pair.books"
            :key="book.id"
            class="flex gap-3 rounded-md border p-3 transition-colors hover:bg-muted/40"
            :class="targetBookId(pair) === book.id ? 'border-primary bg-primary/5' : 'border-border'"
          >
            <label class="mt-1 flex shrink-0 items-start gap-2 text-sm text-foreground">
              <input
                type="radio"
                :name="`merge-target-${pairKey(pair)}`"
                :value="book.id"
                :data-pair-key="pairKey(pair)"
                :checked="targetBookId(pair) === book.id"
                :aria-label="t('tools.bookMerge.keepBook', { title: book.title ?? t('tools.bookMerge.unknownTitle') })"
                class="accent-primary"
                @change="handleChooseTarget"
              />
              <span class="sr-only">{{ t('tools.bookMerge.keepThisBook') }}</span>
            </label>
            <span class="min-w-0 flex-1">
              <span class="flex items-start justify-between gap-2">
                <RouterLink
                  :to="{ name: 'book-detail', params: { bookId: book.id } }"
                  class="font-semibold text-foreground underline-offset-4 hover:underline"
                >
                  {{ book.title ?? t('tools.bookMerge.unknownTitle') }}
                </RouterLink>
                <span class="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                  {{ t('tools.bookMerge.keepThisBook') }}
                </span>
              </span>
              <span class="mt-1 block text-sm text-muted-foreground">{{ formatAuthors(book.authors) }}</span>
              <span class="mt-2 flex flex-wrap gap-1.5 text-xs text-muted-foreground">
                <span class="rounded bg-muted px-2 py-1">{{ book.libraryName }}</span>
                <span v-for="format in book.formats" :key="format" class="rounded bg-muted px-2 py-1">{{ format }}</span>
              </span>
              <span class="mt-2 block break-all text-xs text-muted-foreground">{{ book.folderPath }}</span>
            </span>
          </div>
        </div>
      </article>

      <Button v-if="mergeTool.nextCursor.value" variant="outline" :disabled="mergeTool.loading.value || filtersChanged" @click="handleLoadMore">
        <Loader2 v-if="mergeTool.loading.value" class="animate-spin motion-reduce:animate-none" aria-hidden="true" />
        <ArrowRightLeft v-else aria-hidden="true" />
        {{ t('tools.bookMerge.loadMore') }}
      </Button>
    </section>

    <section
      v-else
      class="flex flex-1 flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border/60 bg-card/20 p-10 text-center"
    >
      <ArrowRightLeft class="size-8 text-muted-foreground" aria-hidden="true" />
      <p class="max-w-md text-sm text-muted-foreground">{{ t('tools.bookMerge.initial.description') }}</p>
    </section>
  </div>

  <ConfirmDialog
    :open="pendingMerge !== null"
    :title="t('tools.bookMerge.confirm.title')"
    :description="confirmDescription"
    :confirm-label="t('tools.bookMerge.confirm.action')"
    :confirmation-phrase="t('tools.bookMerge.confirm.phrase')"
    :busy="mergeTool.merging.value"
    @confirm="handleConfirmMerge"
    @cancel="handleCancelMerge"
  />
</template>
