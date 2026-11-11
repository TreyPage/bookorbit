<script setup lang="ts">
import { RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'

import ContentVerificationPanel from '../components/ContentVerificationPanel.vue'

const { t } = useI18n()
</script>

<template>
  <div class="flex h-full min-h-0 flex-col gap-4 overflow-y-auto pr-1">
    <RouterLink
      :to="{ name: 'tools-library-integrity' }"
      class="w-fit text-sm text-muted-foreground underline decoration-muted-foreground/40 underline-offset-2 hover:text-primary"
    >
      {{ t('tools.libraryIntegrity.contentVerification.backToIntegrity') }}
    </RouterLink>
    <ContentVerificationPanel />
  </div>
</template>
