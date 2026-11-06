<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { SidecarFileEntry } from '@bookorbit/types'

const props = defineProps<{ entry: SidecarFileEntry }>()
const { t } = useI18n()

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let size = value / 1024
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit += 1
  }
  return `${size.toFixed(1)} ${units[unit]}`
}

const kindLabel = () => t(`tools.missingResources.sidecar.kinds.${props.entry.kind}`)
</script>

<template>
  <li class="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
    <div class="min-w-0 flex-1 space-y-1">
      <p class="text-sm font-medium text-foreground">{{ kindLabel() }}</p>
      <p class="break-all text-sm text-foreground">{{ entry.path }}</p>
      <p class="text-xs text-muted-foreground">{{ entry.libraryName }}</p>
    </div>
    <span class="shrink-0 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground">
      {{ formatBytes(entry.sizeBytes) }}<template v-if="entry.kind === 'conversion_directory'"> · {{ t('tools.missingResources.sidecar.fileCount', { count: entry.fileCount }) }}</template>
    </span>
  </li>
</template>
