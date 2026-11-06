<script setup lang="ts">
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { ArrowRight, Copy, FolderSearch, ShieldCheck } from '@lucide/vue'

import { Button } from '@/components/ui/button'

const router = useRouter()
const { t } = useI18n()

function openMissingResources(): void {
  void router.push({ name: 'tools-missing-resources' })
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
        <span class="text-xs font-semibold uppercase tracking-wider">Tools</span>
      </div>
      <h1 class="text-2xl font-semibold tracking-tight text-foreground">Library Integrity</h1>
      <p class="max-w-3xl text-sm text-muted-foreground">
        Review library health from one place. Existing maintenance and duplicate-book checks remain separate workflows while they are brought under a shared integrity system.
      </p>
    </header>

    <section class="grid gap-4 md:grid-cols-2" aria-label="Library integrity tools">
      <article class="flex flex-col gap-4 rounded-xl border border-border bg-card p-5">
        <div class="flex items-start justify-between gap-3">
          <div class="grid size-10 place-items-center rounded-lg bg-muted text-foreground">
            <FolderSearch class="size-5" aria-hidden="true" />
          </div>
          <span class="rounded-full border border-border px-2 py-1 text-xs text-muted-foreground">Existing check</span>
        </div>
        <div class="space-y-1">
          <h2 class="text-base font-semibold text-foreground">{{ t('tools.header.missingResources') }}</h2>
          <p class="text-sm text-muted-foreground">
            Check for books with missing files, broken cover references, and cover folders left behind by deleted books.
          </p>
        </div>
        <Button class="mt-auto self-start" variant="outline" size="sm" @click="openMissingResources">
          Open check
          <ArrowRight class="size-4" aria-hidden="true" />
        </Button>
      </article>

      <article class="flex flex-col gap-4 rounded-xl border border-border bg-card p-5">
        <div class="flex items-start justify-between gap-3">
          <div class="grid size-10 place-items-center rounded-lg bg-muted text-foreground">
            <Copy class="size-5" aria-hidden="true" />
          </div>
          <span class="rounded-full border border-border px-2 py-1 text-xs text-muted-foreground">Existing check</span>
        </div>
        <div class="space-y-1">
          <h2 class="text-base font-semibold text-foreground">{{ t('tools.header.duplicateBooks') }}</h2>
          <p class="text-sm text-muted-foreground">
            Find duplicate book records using file hashes, ISBNs, and metadata matches. Review the candidates before removing records.
          </p>
        </div>
        <Button class="mt-auto self-start" variant="outline" size="sm" @click="openDuplicateBooks">
          Open check
          <ArrowRight class="size-4" aria-hidden="true" />
        </Button>
      </article>
    </section>

    <section class="rounded-xl border border-dashed border-border bg-card/30 p-5">
      <div class="flex items-start gap-3">
        <div class="grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
          <ShieldCheck class="size-4" aria-hidden="true" />
        </div>
        <div class="space-y-1">
          <h2 class="text-sm font-semibold text-foreground">Additional integrity checks</h2>
          <p class="text-sm text-muted-foreground">
            Duplicate files within a book, unwanted sidecar files, orphaned book files, and invalid file paths will be added here. Detection will be separated from repair so ambiguous files are never deleted automatically.
          </p>
        </div>
      </div>
    </section>
  </div>
</template>
