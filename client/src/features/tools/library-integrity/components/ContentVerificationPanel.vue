<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'

import { Button } from '@/components/ui/button'
import {
  executeContentVerificationCorrection,
  getContentVerificationJobStatus,
  getContentVerificationPage,
  previewContentVerificationCorrection,
  reviewBookFileContent,
  searchContentVerificationCorrectionTargets,
  startContentVerificationBatch,
  verifyBookFileContent,
  type ContentVerificationCorrectionInput,
  type ContentVerificationCorrectionPreview,
  type ContentVerificationCorrectionTarget,
  type ContentVerificationEntry,
  type ContentVerificationFilter,
  type ContentVerificationJobStatus,
  type ContentVerificationReviewStatus,
} from '@/features/tools/api/content-verification'

const { t } = useI18n()
const items = ref<ContentVerificationEntry[]>([])
const total = ref(0)
const page = ref(1)
const pageSize = 25
const filter = ref<ContentVerificationFilter>('needs_review')
const loading = ref(false)
const error = ref(false)
const errorMessage = ref('')
const reviewSuccess = ref('')
const verifyingFileId = ref<number | null>(null)
const jobStatus = ref<ContentVerificationJobStatus | null>(null)
const startingBatch = ref(false)
const reviewNotes = ref<Record<number, string>>({})
const reviewingFileId = ref<number | null>(null)
const correctingFileId = ref<number | null>(null)
const correctionMode = ref<'new_book' | 'existing_book'>('new_book')
const correctionTitle = ref('')
const correctionAuthor = ref('')
const correctionQuery = ref('')
const correctionTargets = ref<ContentVerificationCorrectionTarget[]>([])
const selectedTargetBookId = ref<number | null>(null)
const selectedTargetTitle = ref('')
const correctionPreview = ref<ContentVerificationCorrectionPreview | null>(null)
const searchingCorrectionTargets = ref(false)
const previewingCorrection = ref(false)
const executingCorrection = ref(false)
const correctionSuccess = ref('')
let correctionSearchTimer: ReturnType<typeof setTimeout> | undefined
let correctionSearchGeneration = 0
let statusRefresh: ReturnType<typeof setInterval> | undefined

async function loadJobStatus(): Promise<void> {
  try {
    jobStatus.value = await getContentVerificationJobStatus()
  } catch {
    // Keep the file list usable when background status is temporarily unavailable.
  }
}

async function load(): Promise<void> {
  loading.value = true
  error.value = false
  try {
    const result = await getContentVerificationPage({ page: page.value, pageSize, filter: filter.value })
    items.value = result.items
    total.value = result.total
  } catch {
    error.value = true
  } finally {
    loading.value = false
  }
}

async function startBatch(): Promise<void> {
  startingBatch.value = true
  try {
    jobStatus.value = await startContentVerificationBatch()
    if (statusRefresh) clearInterval(statusRefresh)
    statusRefresh = setInterval(async () => {
      await loadJobStatus()
      if (jobStatus.value?.status !== 'running' && statusRefresh) {
        clearInterval(statusRefresh)
        statusRefresh = undefined
        await load()
      }
    }, 3000)
  } catch {
    error.value = true
  } finally {
    startingBatch.value = false
  }
}

async function verify(item: ContentVerificationEntry): Promise<void> {
  verifyingFileId.value = item.fileId
  error.value = false
  errorMessage.value = ''
  try {
    await verifyBookFileContent(item.fileId)
    await load()
  } catch (cause) {
    error.value = true
    errorMessage.value = cause instanceof Error ? cause.message : t('tools.libraryIntegrity.contentVerification.failed')
  } finally {
    verifyingFileId.value = null
  }
}

async function review(item: ContentVerificationEntry, decision: ContentVerificationReviewStatus): Promise<void> {
  reviewingFileId.value = item.fileId
  error.value = false
  errorMessage.value = ''
  reviewSuccess.value = ''
  try {
    await reviewBookFileContent(item.fileId, decision, reviewNotes.value[item.fileId])
    reviewSuccess.value = `${t('tools.libraryIntegrity.contentVerification.review.label')}: ${t('tools.libraryIntegrity.contentVerification.review.status.' + decision)}`
    await load()
  } catch (cause) {
    error.value = true
    errorMessage.value = cause instanceof Error ? cause.message : t('tools.libraryIntegrity.contentVerification.failed')
  } finally {
    reviewingFileId.value = null
  }
}


function openCorrection(item: ContentVerificationEntry): void {
  correctionSearchGeneration += 1
  searchingCorrectionTargets.value = false
  correctingFileId.value = item.fileId
  correctionMode.value = 'new_book'
  correctionTitle.value = item.detectedTitle ?? ''
  correctionAuthor.value = item.detectedAuthor ?? ''
  correctionQuery.value = ''
  correctionTargets.value = []
  selectedTargetBookId.value = null
  selectedTargetTitle.value = ''
  correctionPreview.value = null
  correctionSuccess.value = ''
  error.value = false
  errorMessage.value = ''
}

function closeCorrection(): void {
  correctionSearchGeneration += 1
  searchingCorrectionTargets.value = false
  correctingFileId.value = null
  correctionPreview.value = null
  correctionTargets.value = []
  selectedTargetBookId.value = null
  selectedTargetTitle.value = ''
  if (correctionSearchTimer) clearTimeout(correctionSearchTimer)
}

function onCorrectionModeChange(): void {
  correctionSearchGeneration += 1
  searchingCorrectionTargets.value = false
  correctionPreview.value = null
  selectedTargetBookId.value = null
  selectedTargetTitle.value = ''
  correctionQuery.value = ''
  correctionTargets.value = []
  if (correctionSearchTimer) clearTimeout(correctionSearchTimer)
}

async function searchCorrectionTargets(fileId: number, query: string): Promise<void> {
  const generation = ++correctionSearchGeneration
  searchingCorrectionTargets.value = true
  try {
    const targets = await searchContentVerificationCorrectionTargets(fileId, query)
    if (generation === correctionSearchGeneration) correctionTargets.value = targets
  } catch (cause) {
    if (generation === correctionSearchGeneration) {
      error.value = true
      errorMessage.value = cause instanceof Error && !cause.message.startsWith('content_verification_correction_')
        ? cause.message
        : t('tools.libraryIntegrity.contentVerification.correction.searchFailed')
    }
  } finally {
    if (generation === correctionSearchGeneration) searchingCorrectionTargets.value = false
  }
}

function onCorrectionTargetInput(): void {
  selectedTargetBookId.value = null
  selectedTargetTitle.value = ''
  correctionTargets.value = []
  scheduleCorrectionTargetSearch()
}

function scheduleCorrectionTargetSearch(): void {
  correctionSearchGeneration += 1
  if (correctionSearchTimer) clearTimeout(correctionSearchTimer)
  correctionPreview.value = null
  if (correctingFileId.value === null) return
  const fileId = correctingFileId.value
  const query = correctionQuery.value.trim()
  correctionSearchTimer = setTimeout(() => void searchCorrectionTargets(fileId, query), 250)
}

function selectCorrectionTarget(target: ContentVerificationCorrectionTarget): void {
  selectedTargetBookId.value = target.bookId
  const title = target.title ?? t('tools.libraryIntegrity.contentVerification.untitled')
  selectedTargetTitle.value = target.authors.length ? `${title} — ${target.authors.join(', ')}` : title
  correctionQuery.value = title
  correctionTargets.value = []
  correctionPreview.value = null
}

function correctionInput(): ContentVerificationCorrectionInput | null {
  if (correctionMode.value === 'new_book') {
    const title = correctionTitle.value.trim()
    const author = correctionAuthor.value.trim()
    return title && author ? { targetType: 'new_book', title, author } : null
  }
  return selectedTargetBookId.value === null ? null : { targetType: 'existing_book', targetBookId: selectedTargetBookId.value }
}

async function previewCorrection(item: ContentVerificationEntry): Promise<void> {
  const input = correctionInput()
  if (!input) return
  previewingCorrection.value = true
  correctionPreview.value = null
  error.value = false
  errorMessage.value = ''
  try {
    correctionPreview.value = await previewContentVerificationCorrection(item.fileId, input)
  } catch (cause) {
    error.value = true
    errorMessage.value = cause instanceof Error && !cause.message.startsWith('content_verification_correction_')
      ? cause.message
      : t('tools.libraryIntegrity.contentVerification.correction.previewFailed')
  } finally {
    previewingCorrection.value = false
  }
}

async function applyCorrection(item: ContentVerificationEntry): Promise<void> {
  const input = correctionInput()
  if (!input || !correctionPreview.value) return
  executingCorrection.value = true
  error.value = false
  errorMessage.value = ''
  correctionSuccess.value = ''
  try {
    const result = await executeContentVerificationCorrection(item.fileId, input)
    correctionSuccess.value = result.sourceCleanupPending
      ? t('tools.libraryIntegrity.contentVerification.correction.cleanupPending')
      : t('tools.libraryIntegrity.contentVerification.correction.success')
    closeCorrection()
    await load()
  } catch (cause) {
    error.value = true
    errorMessage.value = cause instanceof Error && !cause.message.startsWith('content_verification_correction_')
      ? cause.message
      : t('tools.libraryIntegrity.contentVerification.correction.failed')
  } finally {
    executingCorrection.value = false
  }
}

watch([correctionMode, correctionTitle, correctionAuthor, selectedTargetBookId], () => {
  correctionPreview.value = null
})

function reviewStatusLabel(item: ContentVerificationEntry): string | null {
  return item.reviewStatus ? t(`tools.libraryIntegrity.contentVerification.review.status.${item.reviewStatus}`) : null
}

function statusLabel(item: ContentVerificationEntry): string {
  if (item.stale) return t('tools.libraryIntegrity.contentVerification.stale')
  if (!item.status) return t('tools.libraryIntegrity.contentVerification.notChecked')
  return t(`tools.libraryIntegrity.contentVerification.status.${item.status}`)
}

function onFilterChange(): void {
  page.value = 1
  void load()
}

function previousPage(): void {
  page.value--
  void load()
}

function nextPage(): void {
  page.value++
  void load()
}

onMounted(() => {
  void load()
  void loadJobStatus()
})

onUnmounted(() => {
  if (statusRefresh) clearInterval(statusRefresh)
  if (correctionSearchTimer) clearTimeout(correctionSearchTimer)
  correctionSearchGeneration += 1
})
</script>

<template>
  <section class="space-y-4 rounded-xl border border-border bg-card p-5">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div class="space-y-1">
        <h2 class="text-base font-semibold text-foreground">
          {{ t('tools.libraryIntegrity.contentVerification.title') }}
        </h2>
        <p class="text-sm text-muted-foreground">
          {{ t('tools.libraryIntegrity.contentVerification.description') }}
        </p>
      </div>
      <div class="flex flex-wrap gap-2">
        <select v-model="filter" class="h-9 rounded-md border border-input bg-background px-2 text-xs" @change="onFilterChange">
          <option value="needs_review">{{ t('tools.libraryIntegrity.contentVerification.review.filters.needsReview') }}</option>
          <option value="mismatch">{{ t('tools.libraryIntegrity.contentVerification.review.filters.mismatches') }}</option>
          <option value="reviewed">{{ t('tools.libraryIntegrity.contentVerification.review.filters.reviewed') }}</option>
          <option value="all">{{ t('tools.libraryIntegrity.contentVerification.review.filters.all') }}</option>
        </select>
        <Button
          size="sm"
          variant="outline"
          :disabled="startingBatch || jobStatus?.status === 'running' || jobStatus?.status === 'waiting_for_provider'"
          @click="startBatch"
        >
          {{
            jobStatus?.status === 'running'
              ? t('tools.libraryIntegrity.contentVerification.background.running')
              : t('tools.libraryIntegrity.contentVerification.background.run')
          }}
        </Button>
        <Button size="sm" variant="outline" :disabled="loading" @click="load">
          {{ t('tools.libraryIntegrity.contentVerification.refresh') }}
        </Button>
      </div>
    </div>

    <div v-if="jobStatus" class="rounded-lg bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
      <p>
        {{ t('tools.libraryIntegrity.contentVerification.background.status') }}:
        {{ t('tools.libraryIntegrity.contentVerification.background.states.' + jobStatus.status) }}
      </p>
      <p>
        {{
          t('tools.libraryIntegrity.contentVerification.background.counts', {
            processed: jobStatus.processed,
            matches: jobStatus.matches,
            mismatches: jobStatus.mismatches,
            inconclusive: jobStatus.inconclusive,
            errors: jobStatus.errors,
          })
        }}
      </p>
      <p v-if="jobStatus.lastError" class="text-destructive">{{ jobStatus.lastError }}</p>
    </div>

    <p v-if="reviewSuccess" role="status" aria-live="polite" class="text-sm font-medium text-emerald-600">
      {{ reviewSuccess }}
    </p>
    <p v-if="correctionSuccess" role="status" aria-live="polite" class="text-sm font-medium text-emerald-600">
      {{ correctionSuccess }}
    </p>
    <p v-if="error" role="alert" class="text-sm text-destructive">
      {{ errorMessage || t('tools.libraryIntegrity.contentVerification.failed') }}
    </p>
    <p v-else-if="loading && items.length === 0" class="text-sm text-muted-foreground">
      {{ t('tools.libraryIntegrity.contentVerification.loading') }}
    </p>
    <p v-else-if="items.length === 0" class="text-sm text-muted-foreground">
      {{
        filter === 'needs_review'
          ? t('tools.libraryIntegrity.contentVerification.review.emptyNeedsReview')
          : t('tools.libraryIntegrity.contentVerification.empty')
      }}
    </p>

    <div v-else class="divide-y divide-border">
      <div v-for="item in items" :key="item.fileId" class="flex flex-wrap items-center justify-between gap-3 py-3">
        <div class="min-w-0 flex-1 space-y-1">
          <p class="truncate text-sm font-medium text-foreground">
            <RouterLink
              :to="{ name: 'book-detail', params: { bookId: item.bookId } }"
              class="underline decoration-muted-foreground/40 underline-offset-2 hover:text-primary"
            >
              {{ item.title || t('tools.libraryIntegrity.contentVerification.untitled') }}
            </RouterLink>
          </p>
          <p class="text-xs text-muted-foreground">
            {{ (item.format || '').toUpperCase() }} · {{ statusLabel(item) }}
            <span v-if="item.confidence !== null && !item.stale"> · {{ Math.round(item.confidence * 100) }}% </span>
          </p>
          <p v-if="item.detectedTitle" class="truncate text-xs text-muted-foreground">
            {{ t('tools.libraryIntegrity.contentVerification.detected') }}: {{ item.detectedTitle }}
            <span v-if="item.detectedAuthor"> — {{ item.detectedAuthor }}</span>
          </p>
          <p v-if="item.explanation && (item.status === 'mismatch' || item.status === 'inconclusive')" class="text-xs text-muted-foreground">
            {{ item.explanation }}
          </p>
          <p v-if="reviewStatusLabel(item)" class="text-xs font-medium text-muted-foreground">
            {{ t('tools.libraryIntegrity.contentVerification.review.label') }}: {{ reviewStatusLabel(item) }}
          </p>
          <p v-if="item.reviewNote" class="text-xs text-muted-foreground">
            {{ t('tools.libraryIntegrity.contentVerification.review.note') }}: {{ item.reviewNote }}
          </p>
          <details v-if="item.evidence?.length" class="pt-1 text-xs">
            <summary class="cursor-pointer text-muted-foreground">
              {{ t('tools.libraryIntegrity.contentVerification.review.showEvidence') }}
            </summary>
            <div v-for="(evidence, index) in item.evidence" :key="index" class="mt-2 space-y-1 rounded-md bg-muted/40 p-2">
              <p class="font-medium text-foreground">{{ evidence.label }}</p>
              <p class="whitespace-pre-wrap break-words text-muted-foreground">{{ evidence.text }}</p>
            </div>
          </details>
          <div v-if="item.status === 'mismatch' || item.status === 'inconclusive' || item.status === 'error'" class="mt-2 space-y-2">
            <textarea
              v-model="reviewNotes[item.fileId]"
              :placeholder="t('tools.libraryIntegrity.contentVerification.review.notePlaceholder')"
              :disabled="item.stale || reviewingFileId !== null"
              maxlength="1000"
              rows="2"
              class="w-full rounded-md border border-input bg-background px-2 py-1.5 text-xs"
            />
            <div class="flex flex-wrap gap-2">
              <template v-if="item.status === 'mismatch' || item.status === 'inconclusive'">
                <Button size="sm" variant="outline" :disabled="item.stale || reviewingFileId !== null" @click="review(item, 'confirmed_mismatch')">
                  {{ t('tools.libraryIntegrity.contentVerification.review.confirmMismatch') }}
                </Button>
                <Button size="sm" variant="outline" :disabled="item.stale || reviewingFileId !== null" @click="review(item, 'false_positive')">
                  {{ t('tools.libraryIntegrity.contentVerification.review.falsePositive') }}
                </Button>
              </template>
              <Button size="sm" variant="outline" :disabled="item.stale || reviewingFileId !== null" @click="review(item, 'needs_recheck')">
                {{ t('tools.libraryIntegrity.contentVerification.review.needsRecheck') }}
              </Button>
            </div>
          </div>

          <div v-if="item.reviewStatus === 'confirmed_mismatch' && !item.stale" class="mt-2">
            <Button
              size="sm"
              variant="outline"
              :disabled="executingCorrection || previewingCorrection || (correctingFileId !== null && correctingFileId !== item.fileId)"
              @click="correctingFileId === item.fileId ? closeCorrection() : openCorrection(item)"
            >
              {{
                correctingFileId === item.fileId
                  ? t('tools.libraryIntegrity.contentVerification.correction.close')
                  : t('tools.libraryIntegrity.contentVerification.correction.open')
              }}
            </Button>
          </div>

          <div v-if="correctingFileId === item.fileId" class="mt-3 space-y-3 rounded-lg border border-border bg-muted/20 p-3">
            <div class="space-y-1">
              <p class="text-sm font-semibold text-foreground">
                {{ t('tools.libraryIntegrity.contentVerification.correction.title') }}
              </p>
              <p class="text-xs text-muted-foreground">
                {{ t('tools.libraryIntegrity.contentVerification.correction.description') }}
              </p>
            </div>

            <label class="block space-y-1 text-xs">
              <span class="font-medium text-foreground">{{ t('tools.libraryIntegrity.contentVerification.correction.destination') }}</span>
              <select
                v-model="correctionMode"
                class="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                :disabled="previewingCorrection || executingCorrection"
                @change="onCorrectionModeChange"
              >
                <option value="new_book">{{ t('tools.libraryIntegrity.contentVerification.correction.newBook') }}</option>
                <option value="existing_book">{{ t('tools.libraryIntegrity.contentVerification.correction.existingBook') }}</option>
              </select>
            </label>

            <div v-if="correctionMode === 'new_book'" class="grid gap-2 sm:grid-cols-2">
              <label class="block space-y-1 text-xs">
                <span class="font-medium text-foreground">{{ t('tools.libraryIntegrity.contentVerification.correction.bookTitle') }}</span>
                <input
                  v-model="correctionTitle"
                  maxlength="1000"
                  class="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                  :disabled="previewingCorrection || executingCorrection"
                />
              </label>
              <label class="block space-y-1 text-xs">
                <span class="font-medium text-foreground">{{ t('tools.libraryIntegrity.contentVerification.correction.author') }}</span>
                <input
                  v-model="correctionAuthor"
                  maxlength="500"
                  class="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                  :disabled="previewingCorrection || executingCorrection"
                />
              </label>
            </div>

            <div v-else class="space-y-2">
              <label class="block space-y-1 text-xs">
                <span class="font-medium text-foreground">{{ t('tools.libraryIntegrity.contentVerification.correction.findBook') }}</span>
                <input
                  v-model="correctionQuery"
                  :placeholder="t('tools.libraryIntegrity.contentVerification.correction.searchPlaceholder')"
                  class="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                  :disabled="previewingCorrection || executingCorrection"
                  @focus="scheduleCorrectionTargetSearch"
                  @input="onCorrectionTargetInput"
                />
              </label>
              <p v-if="searchingCorrectionTargets" class="text-xs text-muted-foreground">
                {{ t('tools.libraryIntegrity.contentVerification.correction.searching') }}
              </p>
              <div v-else-if="correctionTargets.length" class="max-h-40 overflow-y-auto rounded-md border border-border bg-background">
                <button
                  v-for="target in correctionTargets"
                  :key="target.bookId"
                  type="button"
                  class="flex w-full items-center justify-between gap-2 border-b border-border px-3 py-2 text-left text-sm last:border-b-0 hover:bg-accent"
                  @click="selectCorrectionTarget(target)"
                >
                  <span class="min-w-0">
                    <span class="block truncate">{{ target.title || t('tools.libraryIntegrity.contentVerification.untitled') }}</span>
                    <span v-if="target.authors.length" class="block truncate text-xs text-muted-foreground">{{ target.authors.join(', ') }}</span>
                  </span>
                  <span class="shrink-0 text-xs text-muted-foreground">#{{ target.bookId }}</span>
                </button>
              </div>
              <p v-else-if="selectedTargetBookId === null && correctionQuery.trim().length >= 2" class="text-xs text-muted-foreground">
                {{ t('tools.libraryIntegrity.contentVerification.correction.noTargets') }}
              </p>
              <p v-if="selectedTargetBookId !== null" class="text-xs text-muted-foreground">
                {{ t('tools.libraryIntegrity.contentVerification.correction.selectedBook', { title: selectedTargetTitle }) }}
              </p>
            </div>

            <div class="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                :disabled="!correctionInput() || previewingCorrection || executingCorrection"
                @click="previewCorrection(item)"
              >
                {{
                  previewingCorrection
                    ? t('tools.libraryIntegrity.contentVerification.correction.previewing')
                    : t('tools.libraryIntegrity.contentVerification.correction.preview')
                }}
              </Button>
              <Button size="sm" variant="ghost" :disabled="executingCorrection" @click="closeCorrection">
                {{ t('common.cancel') }}
              </Button>
            </div>

            <div v-if="correctionPreview" class="space-y-2 rounded-md border border-border bg-background p-3">
              <p class="text-sm font-semibold text-foreground">
                {{ t('tools.libraryIntegrity.contentVerification.correction.previewReady', { title: correctionPreview.destinationTitle }) }}
              </p>
              <p class="text-xs text-muted-foreground">
                {{ correctionPreview.sourceBookTitle || t('tools.libraryIntegrity.contentVerification.untitled') }} → {{ correctionPreview.destinationTitle }}
              </p>
              <div class="space-y-1 text-xs">
                <p class="text-muted-foreground">{{ t('tools.libraryIntegrity.contentVerification.correction.from') }}</p>
                <p class="break-all font-mono text-foreground">{{ correctionPreview.sourcePath }}</p>
                <p class="pt-1 text-muted-foreground">{{ t('tools.libraryIntegrity.contentVerification.correction.to') }}</p>
                <p class="break-all font-mono text-foreground">{{ correctionPreview.destinationPath }}</p>
              </div>
              <p class="text-xs text-muted-foreground">
                {{ t('tools.libraryIntegrity.contentVerification.correction.preserveEvidence') }}
              </p>
              <Button size="sm" :disabled="executingCorrection" @click="applyCorrection(item)">
                {{
                  executingCorrection
                    ? t('tools.libraryIntegrity.contentVerification.correction.applying')
                    : t('tools.libraryIntegrity.contentVerification.correction.apply')
                }}
              </Button>
            </div>
          </div>
        </div>
        <Button size="sm" variant="outline" :disabled="verifyingFileId !== null || executingCorrection" @click="verify(item)">
          {{
            verifyingFileId === item.fileId
              ? t('tools.libraryIntegrity.contentVerification.verifying')
              : t('tools.libraryIntegrity.contentVerification.verify')
          }}
        </Button>
      </div>
    </div>

    <div v-if="total > pageSize" class="flex items-center justify-between text-sm">
      <span class="text-muted-foreground"> {{ total }} {{ t('tools.libraryIntegrity.contentVerification.files') }} </span>
      <div class="flex gap-2">
        <Button size="sm" variant="outline" :disabled="page <= 1 || loading" @click="previousPage">
          {{ t('tools.libraryIntegrity.contentVerification.previous') }}
        </Button>
        <Button size="sm" variant="outline" :disabled="page * pageSize >= total || loading" @click="nextPage">
          {{ t('tools.libraryIntegrity.contentVerification.next') }}
        </Button>
      </div>
    </div>
  </section>
</template>
