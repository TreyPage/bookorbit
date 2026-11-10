<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { RefreshCw } from '@lucide/vue'
import { AuditAction } from '@bookorbit/types'
import { formatDateTime } from '@/i18n/formatters'
import { api } from '@/lib/api'

type AutomationEvent = {
  id: number
  action: string
  description: string
  createdAt: string
  meta: Record<string, unknown> | null
  resourceId: number | null
}

const events = ref<AutomationEvent[]>([])
const loading = ref(false)
const failed = ref(false)
const runningJob = ref<string | null>(null)
const runMessage = ref('')

const jobs = [
  { id: 'periodic_search', title: 'Periodic re-search', cadence: 'Hourly' },
  { id: 'watchdog', title: 'Stalled download watchdog', cadence: 'Every 10 minutes' },
  { id: 'seed_cleanup', title: 'Seed-goal cleanup', cadence: 'Every minute' },
] as const

const latestByJob = computed(() => {
  const latest = new Map<string, AutomationEvent>()
  for (const event of events.value) {
    if (event.action !== AuditAction.BookRequestAutomationRun) continue
    const job = typeof event.meta?.job === 'string' ? event.meta.job : ''
    if (job && !latest.has(job)) latest.set(job, event)
  }
  return latest
})

const activityEvents = computed(() => events.value.slice(0, 30))

async function runNow(job: string): Promise<void> {
  runningJob.value = job
  runMessage.value = ''
  try {
    const response = await api(`/api/v1/admin/book-request-automation/runs/${job}/run`, { method: 'POST' })
    if (!response.ok) throw new Error('Could not start automation job')
    const result = (await response.json()) as { started: boolean }
    runMessage.value = result.started ? 'Run completed. Refreshing activity…' : 'This job is already running.'
    await refresh()
  } catch {
    runMessage.value = 'Could not run this job. Check permissions and server logs.'
  } finally {
    runningJob.value = null
  }
}

async function refresh(): Promise<void> {
  loading.value = true
  failed.value = false
  try {
    const response = await api('/api/v1/admin/book-request-automation/runs')
    if (!response.ok) throw new Error('Could not load request automation activity')
    const result = (await response.json()) as { data: AutomationEvent[] }
    events.value = result.data
  } catch {
    failed.value = true
  } finally {
    loading.value = false
  }
}

function eventStatus(event: AutomationEvent): string {
  const status = event.meta?.status
  return typeof status === 'string' ? status : 'recorded'
}

function eventDetail(event: AutomationEvent): string {
  const duration = event.meta?.durationMs
  return typeof duration === 'number' ? `${(duration / 1000).toFixed(1)}s` : ''
}

onMounted(() => void refresh())
</script>

<template>
  <section class="space-y-5" aria-labelledby="request-automation-heading">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h2 id="request-automation-heading" class="text-lg font-semibold text-foreground">Request automation</h2>
        <p class="text-sm text-muted-foreground">Background scheduler health and recent automated actions.</p>
      </div>
      <button
        type="button"
        class="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm hover:bg-muted disabled:opacity-50"
        :disabled="loading"
        @click="refresh"
      >
        <RefreshCw :size="15" :class="loading && 'animate-spin'" aria-hidden="true" />
        Refresh
      </button>
    </div>

    <div class="grid gap-3 md:grid-cols-3">
      <article v-for="job in jobs" :key="job.id" class="rounded-lg border border-border bg-card p-4">
        <div class="flex items-start justify-between gap-2">
          <h3 class="font-medium text-foreground">{{ job.title }}</h3>
          <span class="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">{{ job.cadence }}</span>
        </div>
        <template v-if="latestByJob.get(job.id)">
          <p class="mt-3 text-sm text-muted-foreground">Last run</p>
          <p class="text-sm font-medium text-foreground">{{ formatDateTime(new Date(latestByJob.get(job.id)!.createdAt)) }}</p>
          <p class="mt-1 text-xs" :class="eventStatus(latestByJob.get(job.id)!) === 'failed' ? 'text-destructive' : 'text-muted-foreground'">
            {{ eventStatus(latestByJob.get(job.id)!) }}
            <span v-if="eventDetail(latestByJob.get(job.id)!)">· {{ eventDetail(latestByJob.get(job.id)!) }}</span>
          </p>
        </template>
        <p v-else class="mt-3 text-sm text-muted-foreground">No scheduler run recorded yet.</p>
        <button
          type="button"
          class="mt-3 rounded-md border border-border px-2.5 py-1.5 text-xs hover:bg-muted disabled:opacity-50"
          :disabled="runningJob !== null"
          @click="runNow(job.id)"
        >
          {{ runningJob === job.id ? 'Running…' : 'Run now' }}
        </button>
      </article>
    </div>

    <p v-if="runMessage" role="status" class="text-sm text-muted-foreground">{{ runMessage }}</p>
    <div v-if="failed" role="alert" class="rounded-lg border border-destructive/40 p-3 text-sm text-destructive">
      Could not load automation history. Check your permissions and try again.
    </div>
    <div v-else class="rounded-lg border border-border">
      <div class="border-b border-border px-4 py-3">
        <h3 class="font-medium text-foreground">Recent activity</h3>
        <p class="text-xs text-muted-foreground">Scheduler runs and automated request decisions.</p>
      </div>
      <p v-if="loading && events.length === 0" class="p-4 text-sm text-muted-foreground">Loading automation history…</p>
      <p v-else-if="activityEvents.length === 0" class="p-4 text-sm text-muted-foreground">
        No automation activity has been recorded yet. This does not prove the schedulers are healthy; their next runs will appear here.
      </p>
      <ol v-else class="divide-y divide-border">
        <li v-for="event in activityEvents" :key="event.id" class="flex flex-wrap items-start justify-between gap-2 px-4 py-3">
          <div class="min-w-0">
            <p class="text-sm text-foreground">{{ event.description }}</p>
            <p class="mt-1 text-xs text-muted-foreground">
              {{ event.resourceId ? `Request #${event.resourceId}` : event.action }}
              <span v-if="event.meta?.failureCode"> · {{ event.meta.failureCode }}</span>
            </p>
          </div>
          <time class="shrink-0 text-xs text-muted-foreground" :datetime="event.createdAt">{{ formatDateTime(new Date(event.createdAt)) }}</time>
        </li>
      </ol>
    </div>
  </section>
</template>
