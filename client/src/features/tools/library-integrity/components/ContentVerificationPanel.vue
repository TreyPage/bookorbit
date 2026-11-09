<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import { Button } from '@/components/ui/button'
import {
  getContentVerificationPage,
  getContentVerificationJobStatus,
  startContentVerificationBatch,
  verifyBookFileContent,
  type ContentVerificationEntry,
  type ContentVerificationJobStatus,
} from '@/features/tools/api/content-verification'

const { t } = useI18n()
const items = ref<ContentVerificationEntry[]>([])
const total = ref(0)
const page = ref(1)
const pageSize = 25
const loading = ref(false)
const error = ref(false)
const verifyingFileId = ref<number | null>(null)
const jobStatus = ref<ContentVerificationJobStatus | null>(null)
const startingBatch = ref(false)
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
    const result = await getContentVerificationPage({ page: page.value, pageSize })
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
      {{ t('tools.libraryIntegrity.contentVerification.empty') }}
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
