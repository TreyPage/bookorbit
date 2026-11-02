import { ref } from 'vue'
import type { HardcoverList, HardcoverShelf, HardcoverSettings, UpsertHardcoverSettingsPayload } from '@bookorbit/types'
import {
  disconnectHardcover,
  fetchHardcoverLists,
  fetchHardcoverShelves,
  fetchHardcoverSettings,
  upsertHardcoverSettings,
  validateHardcoverToken,
} from '../api/hardcover.api'

const settings = ref<HardcoverSettings | null>(null)
const shelves = ref<HardcoverShelf[]>([])
const lists = ref<HardcoverList[]>([])
const loading = ref(false)
const saving = ref(false)
const validating = ref(false)
const loadingShelves = ref(false)
const loadingLists = ref(false)
const shelvesError = ref<string | null>(null)
const listsError = ref<string | null>(null)
const error = ref<string | null>(null)

export function useHardcoverSettings() {
  async function fetchSettings(): Promise<void> {
    loading.value = true
    error.value = null
    try {
      settings.value = await fetchHardcoverSettings()
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Failed to load settings'
    } finally {
      loading.value = false
    }
  }

  async function saveSettings(payload: UpsertHardcoverSettingsPayload): Promise<boolean> {
    saving.value = true
    error.value = null
    try {
      settings.value = await upsertHardcoverSettings(payload)
      return true
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Failed to save settings'
      return false
    } finally {
      saving.value = false
    }
  }

  async function disconnect(): Promise<void> {
    saving.value = true
    error.value = null
    try {
      await disconnectHardcover()
      settings.value = null
      shelves.value = []
      lists.value = []
      shelvesError.value = null
      listsError.value = null
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Failed to disconnect'
    } finally {
      saving.value = false
    }
  }

  async function validateToken(token?: string): Promise<{ valid: boolean; username?: string }> {
    validating.value = true
    try {
      const result = await validateHardcoverToken(token)
      return { valid: result.valid, username: result.hardcoverUsername }
    } catch {
      return { valid: false }
    } finally {
      validating.value = false
    }
  }

  async function fetchShelves(): Promise<boolean> {
    loadingShelves.value = true
    shelvesError.value = null
    try {
      const result = await fetchHardcoverShelves()
      shelves.value = result.shelves
      return true
    } catch (err) {
      shelves.value = []
      shelvesError.value = err instanceof Error ? err.message : 'Failed to fetch Hardcover shelves'
      return false
    } finally {
      loadingShelves.value = false
    }
  }

  async function fetchLists(token?: string): Promise<boolean> {
    loadingLists.value = true
    listsError.value = null
    try {
      const result = await fetchHardcoverLists(token)
      lists.value = result.lists
      return true
    } catch (err) {
      lists.value = []
      listsError.value = err instanceof Error ? err.message : 'Failed to fetch Hardcover lists'
      return false
    } finally {
      loadingLists.value = false
    }
  }

  return {
    settings,
    shelves,
    lists,
    loading,
    saving,
    validating,
    loadingShelves,
    loadingLists,
    shelvesError,
    listsError,
    error,
    fetchSettings,
    saveSettings,
    disconnect,
    validateToken,
    fetchShelves,
    fetchLists,
  }
}
