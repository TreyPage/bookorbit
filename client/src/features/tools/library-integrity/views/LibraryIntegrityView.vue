<script setup lang="ts">
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { ArrowRight, Copy, Files, FolderSearch, ShieldCheck } from '@lucide/vue'

import { Button } from '@/components/ui/button'

const router = useRouter()
const { t } = useI18n()

function openMissingResources(): void {
  void router.push({ name: 'tools-missing-resources' })
}

function openDuplicateFormats(): void {
  void router.push({ name: 'tools-library-integrity-duplicate-formats' })
}

function openDuplicateBooks(): void {
  void router.push({ name: 'tools-duplicate-books' })
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col gap-6 overflow-y-auto pr-1">
    <header class="space-y-2">
      <div class="flex items-center gap-2 text-primary">
        <ShieldCheck class="size-5" aria-hidden="true" />
        <span class="text-xs font-semibold uppercase tracking-wider">{{ t('tools.libraryIntegrity.eyebrow') }}</span>
      </div>
      <h1 class="text-2xl font-semibold tracking-tight text-foreground">{{ t('titles.libraryIntegrity') }}</h1>
      <p class="max-w-3xl text-sm text-muted-foreground">{{ t('tools.libraryIntegrity.description') }}</p>
    </header>

    <section class="grid gap-4 md:grid-cols-2" :aria-label="t('tools.libraryIntegrity.checksLabel')">
      <article class="flex flex-col gap-4 rounded-xl border border-border bg-card p-5">
        <div class="flex items-start justify-between gap-3">
          <div class="grid size-10 place-items-center rounded-lg bg-muted text-foreground">
            <FolderSearch class="size-5" aria-hidden="true" />
          </div>
          <span class="rounded-full border border-border px-2 py-1 text-xs text-muted-foreground">{{ t('tools.libraryIntegrity.existingCheck') }}</span>
        </div>
        <div class="space-y-1">
          <h2 class="text-base font-semibold text-foreground">{{ t('tools.header.missingResources') }}</h2>
          <p class="text-sm text-muted-foreground">{{ t('tools.libraryIntegrity.missingDescription') }}</p>
        </div>
        <Button class="mt-auto self-start" variant="outline" size="sm" @click="openMissingResources">
          {{ t('tools.libraryIntegrity.openCheck') }}
          <ArrowRight class="size-4" aria-hidden="true" />
        </Button>
      </article>

      <article class="flex flex-col gap-4 rounded-xl border border-border bg-card p-5">
        <div class="flex items-start justify-between gap-3">
          <div class="grid size-10 place-items-center rounded-lg bg-muted text-foreground">
            <Copy class="size-5" aria-hidden="true" />
          </div>
          <span class="rounded-full border border-border px-2 py-1 text-xs text-muted-foreground">{{ t('tools.libraryIntegrity.existingCheck') }}</span>
        </div>
        <div class="space-y-1">
          <h2 class="text-base font-semibold text-foreground">{{ t('tools.header.duplicateBooks') }}</h2>
          <p class="text-sm text-muted-foreground">{{ t('tools.libraryIntegrity.duplicateDescription') }}</p>
        </div>
        <Button class="mt-auto self-start" variant="outline" size="sm" @click="openDuplicateBooks">
          {{ t('tools.libraryIntegrity.openCheck') }}
          <ArrowRight class="size-4" aria-hidden="true" />
        </Button>
      </article>
    </section>

      <article class="flex flex-col gap-4 rounded-xl border border-border bg-card p-5">
        <div class="flex items-start justify-between gap-3">
          <div class="grid size-10 place-items-center rounded-lg bg-muted text-foreground">
            <Files class="size-5" aria-hidden="true" />
          </div>
          <span class="rounded-full border border-border px-2 py-1 text-xs text-muted-foreground">{{ t('tools.libraryIntegrity.newCheck') }}</span>
        </div>
        <div class="space-y-1">
          <h2 class="text-base font-semibold text-foreground">{{ t('tools.libraryIntegrity.duplicateFormats.title') }}</h2>
          <p class="text-sm text-muted-foreground">{{ t('tools.libraryIntegrity.duplicateFormats.description') }}</p>
        </div>
        <Button class="mt-auto self-start" variant="outline" size="sm" @click="openDuplicateFormats">
          {{ t('tools.libraryIntegrity.openCheck') }}
          <ArrowRight class="size-4" aria-hidden="true" />
        </Button>
      </article>
    <section class="rounded-xl border border-dashed border-border bg-card/30 p-5">
      <div class="flex items-start gap-3">
        <div class="grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
          <ShieldCheck class="size-4" aria-hidden="true" />
        </div>
        <div class="space-y-1">
          <h2 class="text-sm font-semibold text-foreground">{{ t('tools.libraryIntegrity.futureTitle') }}</h2>
          <p class="text-sm text-muted-foreground">{{ t('tools.libraryIntegrity.futureDescription') }}</p>
        </div>
      </div>
    </section>
  </div>
</template>
