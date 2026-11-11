<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { toast } from 'vue-sonner'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'

interface ContentVerificationSchedule {
  enabled: boolean
  startTime: string
  endTime: string
  batchSize: number
  delaySeconds: number
}

const DEFAULT_SCHEDULE: ContentVerificationSchedule = {
  enabled: true,
  startTime: '01:00',
  endTime: '06:00',
  batchSize: 3,
  delaySeconds: 30,
}

const schedule = ref<ContentVerificationSchedule>({ ...DEFAULT_SCHEDULE })
const loading = ref(true)
const saving = ref(false)
const loadError = ref(false)

async function loadSchedule() {
  loading.value = true
  loadError.value = false
  try {
    const response = await api('/api/v1/maintenance/content-verification/background/settings')
    if (!response.ok) throw new Error('Could not load content verification schedule')
    schedule.value = { ...DEFAULT_SCHEDULE, ...((await response.json()) as ContentVerificationSchedule) }
  } catch {
    loadError.value = true
  } finally {
    loading.value = false
  }
}

async function saveSchedule() {
  saving.value = true
  try {
    const response = await api('/api/v1/maintenance/content-verification/background/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(schedule.value),
    })
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { message?: string | string[] } | null
      const message = Array.isArray(body?.message) ? body.message.join(', ') : body?.message
      throw new Error(message || 'Could not save content verification schedule')
    }
    schedule.value = (await response.json()) as ContentVerificationSchedule
    toast.success('Content verification schedule saved')
  } catch (error) {
    toast.error(error instanceof Error ? error.message : 'Could not save content verification schedule')
  } finally {
    saving.value = false
  }
}

onMounted(loadSchedule)
</script>

<template>
  <section class="settings-card space-y-4">
    <div class="settings-card-header">
      <div>
        <h2 class="settings-card-title">Content verification schedule</h2>
        <p class="mt-1 settings-hint">Run AI-based file checks during server downtime instead of immediately after imports.</p>
      </div>
      <span class="settings-state-pill">{{ schedule.enabled ? 'Enabled' : 'Paused' }}</span>
    </div>

    <div v-if="loading" class="px-4 py-3 text-sm text-muted-foreground">Loading schedule…</div>
    <p v-else-if="loadError" role="alert" class="px-4 text-sm text-destructive">
      Could not load the schedule. Check that you have permission to manage libraries or app settings, then refresh this page.
    </p>
    <form v-else class="space-y-4 px-4 pb-4 md:px-5" @submit.prevent="saveSchedule">
      <label class="flex items-center justify-between gap-4">
        <span class="text-sm font-medium text-foreground">Enable scheduled verification</span>
        <input v-model="schedule.enabled" type="checkbox" class="size-4 accent-primary" />
      </label>

      <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label class="grid gap-1.5">
          <span class="text-sm font-medium text-foreground">Start time</span>
          <input v-model="schedule.startTime" type="time" required class="input-field" />
        </label>
        <label class="grid gap-1.5">
          <span class="text-sm font-medium text-foreground">End time</span>
          <input v-model="schedule.endTime" type="time" required class="input-field" />
        </label>
      </div>

      <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label class="grid gap-1.5">
          <span class="text-sm font-medium text-foreground">Files per batch</span>
          <input v-model.number="schedule.batchSize" type="number" min="1" max="25" step="1" required class="input-field" />
          <span class="settings-hint">Between 1 and 25 files.</span>
        </label>
        <label class="grid gap-1.5">
          <span class="text-sm font-medium text-foreground">Pause between files (seconds)</span>
          <input v-model.number="schedule.delaySeconds" type="number" min="0" max="3600" step="1" required class="input-field" />
          <span class="settings-hint">Set to 0 to run the batch without a pause.</span>
        </label>
      </div>

      <p class="settings-hint">
        Times use the server's configured timezone. A batch stops starting new files when the window closes; unfinished work resumes during the next
        window. Manual verification remains available on demand.
      </p>

      <div class="flex justify-end">
        <Button type="submit" :disabled="saving">
          {{ saving ? 'Saving…' : 'Save schedule' }}
        </Button>
      </div>
    </form>
  </section>
</template>
