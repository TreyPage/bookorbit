<script setup lang="ts">
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Loader2 } from '@lucide/vue'
import type { BookRequestActivityItem } from '@bookorbit/types'
import { formatDateTime } from '@/i18n/formatters'
import { api } from '@/lib/api'

const props = defineProps<{ requestId: number }>()
const { t } = useI18n()
const events = ref<BookRequestActivityItem[]>([])
const loading = ref(false)
const failed = ref(false)

async function load(requestId: number): Promise<void> {
  loading.value = true
  failed.value = false
  try {
    const response = await api(`/api/v1/book-requests/${requestId}/activity`)
    if (!response.ok) throw new Error('Could not load request activity')
    const result = (await response.json()) as { data: BookRequestActivityItem[] }
    if (props.requestId === requestId) events.value = result.data
  } catch {
    if (props.requestId === requestId) failed.value = true
  } finally {
    if (props.requestId === requestId) loading.value = false
  }
}

watch(
  () => props.requestId,
  (id) => void load(id),
  { immediate: true },
)
</script>

<template>
  <section class="rounded-lg border border-border bg-card p-4" :aria-label="t('bookRequests.detail.activity.title')">
    <h3 class="mb-3 text-xs font-semibold tracking-wide text-muted-foreground uppercase">{{ t('bookRequests.detail.activity.title') }}</h3>
    <div v-if="loading" class="flex items-center gap-2 text-sm text-muted-foreground">
      <Loader2 class="size-4 animate-spin" aria-hidden="true" />
      {{ t('common.loading') }}
    </div>
    <p v-else-if="failed" role="alert" class="text-sm text-destructive">{{ t('bookRequests.detail.activity.loadFailed') }}</p>
    <p v-else-if="events.length === 0" class="text-sm text-muted-foreground">{{ t('bookRequests.detail.activity.empty') }}</p>
    <ol v-else class="space-y-3">
      <li v-for="event in events" :key="event.id" class="border-l-2 border-border pl-3">
        <p class="text-sm text-foreground">{{ event.description }}</p>
        <p class="mt-0.5 text-xs text-muted-foreground">
          {{ event.actorName || (event.actorUsername === 'system' ? t('bookRequests.detail.activity.system') : event.actorUsername) }}
          <span aria-hidden="true">·</span>
          <time :datetime="event.createdAt">{{ formatDateTime(new Date(event.createdAt)) }}</time>
        </p>
      </li>
    </ol>
  </section>
</template>
