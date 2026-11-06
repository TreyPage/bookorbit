<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { BrokenCoverEntry, MissingBookEntry, MissingResourceCategory, OrphanedCoverDirEntry, SidecarFileEntry } from '@bookorbit/types'

import { entryId, type MissingResourceEntry } from '../../composables/useMissingResources'
import BrokenCoverRow from './BrokenCoverRow.vue'
import MissingBookRow from './MissingBookRow.vue'
import OrphanedCoverRow from './OrphanedCoverRow.vue'
import SidecarFileRow from './SidecarFileRow.vue'

const props = defineProps<{
  category: MissingResourceCategory
  items: MissingResourceEntry[]
  selectedIds: Set<number>
  selectAllMatching: boolean
  allOnPageSelected: boolean
  disabled: boolean
  selectable: boolean
}>()
const emit = defineEmits<{ toggle: [id: number]; togglePage: [] }>()

const { t } = useI18n()

const missingBooks = computed(() => (props.category === 'missing_books' ? (props.items as MissingBookEntry[]) : []))
const brokenCovers = computed(() => (props.category === 'broken_covers' ? (props.items as BrokenCoverEntry[]) : []))
const orphanedDirs = computed(() => (props.category === 'orphaned_cover_dirs' ? (props.items as OrphanedCoverDirEntry[]) : []))
const sidecarFiles = computed(() => (props.category === 'sidecar_files' ? (props.items as SidecarFileEntry[]) : []))

function isSelected(entry: MissingResourceEntry): boolean {
  return props.selectAllMatching || props.selectedIds.has(entryId(entry))
}

function handleTogglePage(): void {
  emit('togglePage')
}

function handleToggle(id: number): void {
  emit('toggle', id)
}
</script>

<template>
  <div class="overflow-hidden rounded-lg border border-border">
    <div v-if="selectable" class="flex items-center gap-3 border-b border-border bg-muted/30 px-4 py-2.5">
      <label class="flex items-center gap-2 text-sm text-muted-foreground">
        <input
          type="checkbox"
          class="rounded-xs accent-primary"
          :checked="allOnPageSelected || selectAllMatching"
          :disabled="disabled || items.length === 0"
          @change="handleTogglePage"
        />
        <span>{{ t('tools.missingResources.table.selectPage') }}</span>
      </label>
    </div>

    <ul v-if="category === 'missing_books'" class="divide-y divide-border">
      <MissingBookRow
        v-for="entry in missingBooks"
        :key="entry.id"
        :entry="entry"
        :selected="isSelected(entry)"
        :disabled="disabled"
        @toggle="handleToggle"
      />
    </ul>

    <ul v-else-if="category === 'broken_covers'" class="divide-y divide-border">
      <BrokenCoverRow
        v-for="entry in brokenCovers"
        :key="entry.id"
        :entry="entry"
        :selected="isSelected(entry)"
        :disabled="disabled"
        @toggle="handleToggle"
      />
    </ul>

    <ul v-else-if="category === 'orphaned_cover_dirs'" class="divide-y divide-border">
      <OrphanedCoverRow
        v-for="entry in orphanedDirs"
        :key="entry.bookId"
        :entry="entry"
        :selected="isSelected(entry)"
        :disabled="disabled"
        @toggle="handleToggle"
      />
    </ul>

    <ul v-else class="divide-y divide-border">
      <SidecarFileRow v-for="entry in sidecarFiles" :key="entry.libraryId + ':' + entry.path" :entry="entry" />
    </ul>
  </div>
</template>
