import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  HardcoverListsResult,
  HardcoverSettings,
  HardcoverShelvesResult,
  HardcoverTokenValidationResult,
  UpsertHardcoverSettingsPayload,
} from '@bookorbit/types'

vi.mock('../../api/hardcover.api', () => ({
  fetchHardcoverSettings: vi.fn<() => Promise<HardcoverSettings>>(),
  fetchHardcoverShelves: vi.fn<() => Promise<HardcoverShelvesResult>>(),
  fetchHardcoverLists: vi.fn<(token?: string) => Promise<HardcoverListsResult>>(),
  upsertHardcoverSettings: vi.fn<(payload: UpsertHardcoverSettingsPayload) => Promise<HardcoverSettings>>(),
  disconnectHardcover: vi.fn<() => Promise<void>>(),
  validateHardcoverToken: vi.fn<(token?: string) => Promise<HardcoverTokenValidationResult>>(),
}))

import {
  disconnectHardcover,
  fetchHardcoverShelves,
  fetchHardcoverLists,
  fetchHardcoverSettings,
  upsertHardcoverSettings,
  validateHardcoverToken,
} from '../../api/hardcover.api'

const mockFetchShelves = vi.mocked(fetchHardcoverShelves)
const mockFetchLists = vi.mocked(fetchHardcoverLists)
const mockFetchSettings = vi.mocked(fetchHardcoverSettings)
const mockUpsert = vi.mocked(upsertHardcoverSettings)
const mockDisconnect = vi.mocked(disconnectHardcover)
const mockValidate = vi.mocked(validateHardcoverToken)

const SETTINGS: HardcoverSettings = {
  tokenConfigured: true,
  enabled: true,
  effectiveEnabled: true,
  disabledReason: null,
  bookSyncMode: 'all_eligible',
  hardcoverShelfIds: [],
  hardcoverListIds: [],
  autoSyncOnStatusChange: true,
  autoSyncOnProgressUpdate: true,
  autoSyncOnRatingChange: true,
  privacySettingId: 3,
  lastSyncedAt: null,
}

async function loadComposable() {
  const { useHardcoverSettings } = await import('../useHardcoverSettings')
  return useHardcoverSettings()
}

describe('useHardcoverSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
  })

  it('fetchLists loads custom lists using a supplied token', async () => {
    mockFetchLists.mockResolvedValue({ lists: [{ id: 19, name: 'Owned', booksCount: 63 }] })
    const c = await loadComposable()

    await expect(c.fetchLists('new-token')).resolves.toBe(true)
    expect(mockFetchLists).toHaveBeenCalledWith('new-token')
    expect(c.lists.value).toEqual([{ id: 19, name: 'Owned', booksCount: 63 }])
    expect(c.listsError.value).toBeNull()
  })

  it('fetchLists surfaces errors', async () => {
    mockFetchLists.mockRejectedValue(new Error('Missing list scope'))
    const c = await loadComposable()

    await expect(c.fetchLists()).resolves.toBe(false)
    expect(c.lists.value).toEqual([])
    expect(c.listsError.value).toBe('Missing list scope')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('fetchSettings populates settings on success', async () => {
    mockFetchSettings.mockResolvedValue(SETTINGS)
    const c = await loadComposable()
    await c.fetchSettings()
    expect(c.settings.value).toEqual(SETTINGS)
    expect(c.loading.value).toBe(false)
    expect(c.error.value).toBeNull()
  })

  it('fetchSettings sets error on failure', async () => {
    mockFetchSettings.mockRejectedValue(new Error('Network error'))
    const c = await loadComposable()
    await c.fetchSettings()
    expect(c.settings.value).toBeNull()
    expect(c.error.value).toBe('Network error')
    expect(c.loading.value).toBe(false)
  })

  it('saveSettings updates settings on success', async () => {
    const payload: UpsertHardcoverSettingsPayload = {
      apiToken: 'tok',
      enabled: true,
      autoSyncOnStatusChange: true,
      autoSyncOnProgressUpdate: true,
      autoSyncOnRatingChange: true,
      privacySettingId: 3,
    }
    mockUpsert.mockResolvedValue(SETTINGS)
    const c = await loadComposable()
    const ok = await c.saveSettings(payload)
    expect(ok).toBe(true)
    expect(c.settings.value).toEqual(SETTINGS)
    expect(c.saving.value).toBe(false)
  })

  it('saveSettings returns false on failure', async () => {
    mockUpsert.mockRejectedValue(new Error('Bad token'))
    const c = await loadComposable()
    const ok = await c.saveSettings({ apiToken: 'bad' })
    expect(ok).toBe(false)
    expect(c.error.value).toBe('Bad token')
  })

  it('disconnect clears settings', async () => {
    mockDisconnect.mockResolvedValue(undefined)
    mockFetchSettings.mockResolvedValue(SETTINGS)
    mockFetchShelves.mockResolvedValue({ shelves: [{ id: 'read', name: 'Read' }] })
    mockFetchLists.mockResolvedValue({ lists: [{ id: 19, name: 'Owned', booksCount: 63 }] })
    const c = await loadComposable()
    await c.fetchSettings()
    await c.fetchShelves()
    await c.disconnect()
    expect(c.settings.value).toBeNull()
    expect(c.shelves.value).toEqual([])
    expect(c.lists.value).toEqual([])
  })

  it('fetchShelves populates shelves on success', async () => {
    mockFetchShelves.mockResolvedValue({ shelves: [{ id: 'read', name: 'Read' }] })
    const c = await loadComposable()

    await expect(c.fetchShelves()).resolves.toBe(true)
    expect(c.shelves.value).toEqual([{ id: 'read', name: 'Read' }])
    expect(c.shelvesError.value).toBeNull()
  })

  it('fetchShelves surfaces errors', async () => {
    mockFetchShelves.mockRejectedValue(new Error('Failed to fetch'))
    const c = await loadComposable()

    await expect(c.fetchShelves()).resolves.toBe(false)
    expect(c.shelves.value).toEqual([])
    expect(c.shelvesError.value).toBe('Failed to fetch')
  })

  it('validateToken returns valid true on success', async () => {
    const result: HardcoverTokenValidationResult = { valid: true, hardcoverUsername: 'alice' }
    mockValidate.mockResolvedValue(result)
    const c = await loadComposable()
    const r = await c.validateToken()
    expect(r.valid).toBe(true)
    expect(r.username).toBe('alice')
  })

  it('validateToken returns valid false on error', async () => {
    mockValidate.mockRejectedValue(new Error('Unauthorized'))
    const c = await loadComposable()
    const r = await c.validateToken()
    expect(r.valid).toBe(false)
  })
})
