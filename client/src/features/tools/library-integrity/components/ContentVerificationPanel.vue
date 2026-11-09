<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import { Button } from '@/components/ui/button'
import {
  getContentVerificationJobStatus,
  getContentVerificationPage,
  reviewBookFileContent,
  startContentVerificationBatch,
  verifyBookFileContent,
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
const verifyingFileId = ref<number | null>(null)
const jobStatus = ref<ContentVerificationJobStatus | null>(null)
const startingBatch = ref(false)
const reviewNotes = ref<Record<number, string>>({})
const reviewingFileId = ref<number | null>(null)
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
  try {
    await verifyBookFileContent(item.fileId)
    await load()
  } catch {
    error.value = true
  } finally {
    verifyingFileId.value = null
  }
}

async function review(item: ContentVerificationEntry, decision: ContentVerificationReviewStatus): Promise<void> {
  reviewingFileId.value = item.fileId
  error.value = false
  try {
    await reviewBookFileContent(item.fileId, decision, reviewNotes.value[item.fileId])
    await load()
  } catch {
    error.value = true
  } finally {
    reviewingFileId.value = null
  }
}

function reviewStatusLabel(item: ContentVerificationEntry): string | null {
  return item.reviewStatus
    ? t(`tools.libraryIntegrity.contentVerification.review.status.${item.reviewStatus}`)
    : null
}

function statusLabel(item: ContentVerificationEntry): string {
  if (item.stale) return t('tools.libraryIntegrity.contentVerification.stale')
  if (!item.status) return t('tools.libraryIntegrity.contentVerification.notChecked')
  return t(`tools.libraryIntegrity.contentVerification.status.${item.status}`)
}

onMounted(() => {
  void load()
  void loadJobStatus()
})

onUnmounted(() => {
  if (statusRefresh) clearInterval(statusRefresh)
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
        <select
          v-model="filter"
          class="h-9 rounded-md border border-input bg-background px-2 text-xs"
          @change="page = 1; load()"
        >
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
          {{ jobStatus?.status === 'running' ? t('tools.libraryIntegrity.contentVerification.background.running') : t('tools.libraryIntegrity.contentVerification.background.run') }}
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
        {{ t('tools.libraryIntegrity.contentVerification.background.counts', {
          processed: jobStatus.processed,
          matches: jobStatus.matches,
          mismatches: jobStatus.mismatches,
          inconclusive: jobStatus.inconclusive,
          errors: jobStatus.errors,
        }) }}
      </p>
      <p v-if="jobStatus.lastError" class="text-destructive">{{ jobStatus.lastError }}</p>
    </div>

    <p v-if="error" class="text-sm text-destructive">
      {{ t('tools.libraryIntegrity.contentVerification.failed') }}
    </p>
    <p v-else-if="loading && items.length === 0" class="text-sm text-muted-foreground">
      {{ t('tools.libraryIntegrity.contentVerification.loading') }}
    </p>
    <p v-else-if="items.length === 0" class="text-sm text-muted-foreground">
      {{ filter === 'needs_review' ? t('tools.libraryIntegrity.contentVerification.review.emptyNeedsReview') : t('tools.libraryIntegrity.contentVerification.empty') }}
    </p>

    <div v-else class="divide-y divide-border">
      <div v-for="item in items" :key="item.fileId" class="flex flex-wrap items-center justify-between gap-3 py-3">
        <div class="min-w-0 flex-1 space-y-1">
          <p class="truncate text-sm font-medium text-foreground">
            {{ item.title || t('tools.libraryIntegrity.contentVerification.untitled') }}
          </p>
          <p class="text-xs text-muted-foreground">
            {{ (item.format || '').toUpperCase() }} · {{ statusLabel(item) }}
            <span v-if="item.confidence !== null && !item.stale">
              · {{ Math.round(item.confidence * 100) }}%
            </span>
          </p>
          <p v-if="item.detectedTitle" class="truncate text-xs text-muted-foreground">
            {{ t('tools.libraryIntegrity.contentVerification.detected') }}: {{ item.detectedTitle }}
            <span v-if="item.detectedAuthor"> — {{ item.detectedAuthor }}</span>
          </p>
          <p
            v-if="item.explanation && (item.status === 'mismatch' || item.status === 'inconclusive')"
            class="text-xs text-muted-foreground"
          >
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
              <template v-if="item.status === 'mismatch'">
                <Button
                  size="sm"
                  variant="outline"
                  :disabled="item.stale || reviewingFileId !== null"
                  @click="review(item, 'confirmed_mismatch')"
                >
                  {{ t('tools.libraryIntegrity.contentVerification.review.confirmMismatch') }}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  :disabled="item.stale || reviewingFileId !== null"
                  @click="review(item, 'false_positive')"
                >
                  {{ t('tools.libraryIntegrity.contentVerification.review.falsePositive') }}
                </Button>
              </template>
              <Button
                size="sm"
                variant="outline"
                :disabled="item.stale || reviewingFileId !== null"
                @click="review(item, 'needs_recheck')"
              >
                {{ t('tools.libraryIntegrity.contentVerification.review.needsRecheck') }}
              </Button>
            </div>
          </div>
        </div>
        <Button size="sm" variant="outline" :disabled="verifyingFileId !== null" @click="verify(item)">
          {{ verifyingFileId === item.fileId ? t('tools.libraryIntegrity.contentVerification.verifying') : t('tools.libraryIntegrity.contentVerification.verify') }}
        </Button>
      </div>
    </div>

    <div v-if="total > pageSize" class="flex items-center justify-between text-sm">
      <span class="text-muted-foreground">
        {{ total }} {{ t('tools.libraryIntegrity.contentVerification.files') }}
      </span>
      <div class="flex gap-2">
        <Button size="sm" variant="outline" :disabled="page <= 1 || loading" @click="page--; load()">
          {{ t('tools.libraryIntegrity.contentVerification.previous') }}
        </Button>
        <Button size="sm" variant="outline" :disabled="page * pageSize >= total || loading" @click="page++; load()">
          {{ t('tools.libraryIntegrity.contentVerification.next') }}
        </Button>
      </div>
    </div>
  </section>
</template>
