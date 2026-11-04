import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { nextTick, ref } from 'vue'
import type { HardcoverList, HardcoverShelf, HardcoverSettings, UpsertHardcoverSettingsPayload } from '@bookorbit/types'
import HardcoverConnectionCard from '../HardcoverConnectionCard.vue'

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

const mocks = vi.hoisted(() => ({
  fetchSettings: vi.fn<() => Promise<void>>(),
  saveSettings: vi.fn<(payload: UpsertHardcoverSettingsPayload) => Promise<boolean>>(),
  disconnect: vi.fn<() => Promise<void>>(),
  validateToken: vi.fn<(token?: string) => Promise<{ valid: boolean; username?: string }>>(),
  fetchShelves: vi.fn<() => Promise<boolean>>(),
  fetchLists: vi.fn<(token?: string) => Promise<boolean>>(),
}))

const toastSuccess = vi.hoisted(() => vi.fn<(message: string) => void>())
const toastError = vi.hoisted(() => vi.fn<(message: string) => void>())

vi.mock('../../composables/useHardcoverSettings', () => ({
  useHardcoverSettings: () => ({
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
    fetchSettings: mocks.fetchSettings,
    saveSettings: mocks.saveSettings,
    disconnect: mocks.disconnect,
    validateToken: mocks.validateToken,
    fetchShelves: mocks.fetchShelves,
    fetchLists: mocks.fetchLists,
  }),
}))

vi.mock('vue-sonner', () => ({
  toast: {
    success: toastSuccess,
    error: toastError,
  },
}))

function makeSettings(overrides: Partial<HardcoverSettings> = {}): HardcoverSettings {
  return {
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
    ...overrides,
  }
}

describe('HardcoverConnectionCard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    settings.value = makeSettings()
    shelves.value = []
    lists.value = []
    loading.value = false
    saving.value = false
    validating.value = false
    loadingShelves.value = false
    loadingLists.value = false
    shelvesError.value = null
    listsError.value = null
    error.value = null
    mocks.saveSettings.mockResolvedValue(true)
    mocks.disconnect.mockResolvedValue()
    mocks.validateToken.mockResolvedValue({ valid: true, username: 'neon' })
    mocks.fetchShelves.mockImplementation(async () => {
      shelves.value = [
        { id: 'want_to_read', name: 'Want to Read' },
        { id: 'currently_reading', name: 'Currently Reading' },
        { id: 'read', name: 'Read' },
        { id: 'paused', name: 'Paused' },
        { id: 'did_not_finish', name: 'Did Not Finish' },
        { id: 'ignored', name: 'Ignored' },
      ]
      return true
    })
    mocks.fetchLists.mockImplementation(async () => {
      lists.value = [{ id: 19, name: 'Owned', booksCount: 63 }]
      return true
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders the scope selector and saves the selected-only mode', async () => {
    settings.value = makeSettings({
      enabled: false,
      bookSyncMode: 'all_eligible',
      autoSyncOnStatusChange: false,
      autoSyncOnProgressUpdate: true,
      autoSyncOnRatingChange: false,
      privacySettingId: 2,
    })

    const wrapper = mount(HardcoverConnectionCard)
    await flushPromises()
    await flushPromises()

    expect(wrapper.text()).toContain('Book sync scope')
    expect(wrapper.text()).toContain('All eligible books')
    expect(wrapper.text()).toContain('Selected books only')

    const buttons = wrapper.findAll('button')
    const selectedOnlyButton = buttons.find((button) => button.text().includes('Selected books only'))
    const saveButton = buttons.find((button) => button.text().includes('Save'))
    const switches = wrapper.findAll('[role="switch"]')
    const privacySelect = wrapper.get('select')
    const tokenInput = wrapper.get('input[placeholder="Paste your Hardcover API token"]')

    expect(selectedOnlyButton).toBeDefined()
    await selectedOnlyButton!.trigger('click')
    await switches[0].trigger('click')
    await switches[1].trigger('click')
    await switches[2].trigger('click')
    await switches[3].trigger('click')
    await nextTick()
    await privacySelect.setValue('1')
    await tokenInput.setValue('  token-123  ')
    await saveButton!.trigger('click')
    await flushPromises()

    expect(mocks.saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        apiToken: 'token-123',
        hardcoverShelfIds: [],
        enabled: true,
        bookSyncMode: 'selected_only',
        autoSyncOnStatusChange: true,
        autoSyncOnProgressUpdate: false,
        autoSyncOnRatingChange: true,
        privacySettingId: 1,
      }),
    )
    expect(toastSuccess).toHaveBeenCalledWith('Hardcover settings saved')
  })

  it('hides Hardcover-specific controls when the account is not configured', async () => {
    settings.value = makeSettings({ tokenConfigured: false })

    const wrapper = mount(HardcoverConnectionCard)
    await flushPromises()
    await flushPromises()

    expect(wrapper.text()).not.toContain('Sync options')
    expect(wrapper.text()).not.toContain('Book sync scope')
    expect(wrapper.text()).not.toContain('Hardcover shelves')
  })

  it('validates tokens and shows both valid and invalid results', async () => {
    const wrapper = mount(HardcoverConnectionCard)
    await flushPromises()

    const tokenInput = wrapper.get('input[placeholder="Paste your Hardcover API token"]')
    const validateButton = wrapper.findAll('button').find((button) => button.text().includes('Validate token'))!

    await tokenInput.setValue('  valid-token  ')
    await validateButton.trigger('click')
    await flushPromises()

    expect(mocks.validateToken).toHaveBeenCalledWith('valid-token')
    expect(mocks.fetchShelves).toHaveBeenCalled()
    expect(mocks.fetchLists).toHaveBeenCalledWith('valid-token')
    expect(wrapper.text()).toContain('Valid (neon)')
    expect(wrapper.text()).toContain('Owned')

    mocks.validateToken.mockResolvedValueOnce({ valid: false })
    await tokenInput.setValue('bad-token')
    await validateButton.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('Invalid token')
  })

  it('loads saved lists and submits the selected list IDs', async () => {
    settings.value = makeSettings({ hardcoverShelfIds: ['read'] })
    const wrapper = mount(HardcoverConnectionCard)
    await flushPromises()
    await flushPromises()

    expect(mocks.fetchLists).toHaveBeenCalled()
    const owned = wrapper.findAll('label').find((label) => label.text().includes('Owned'))
    expect(owned).toBeDefined()
    await owned!.get('input').setValue(true)

    const saveButton = wrapper.findAll('button').find((button) => button.text().includes('Save'))!
    await saveButton.trigger('click')
    await flushPromises()

    expect(mocks.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ hardcoverShelfIds: ['read'], hardcoverListIds: [19] }))
  })

  it('warns on empty validation, surfaces save failures, and clears state on disconnect', async () => {
    mocks.saveSettings.mockResolvedValueOnce(false)
    error.value = 'Hardcover rejected the request'

    const wrapper = mount(HardcoverConnectionCard)
    await flushPromises()

    const tokenInput = wrapper.get('input[placeholder="Paste your Hardcover API token"]')
    const showButton = wrapper.get('button[type="button"]')
    const validateButton = wrapper.findAll('button').find((button) => button.text().includes('Validate token'))!
    const disconnectButton = wrapper.findAll('button').find((button) => button.text().includes('Disconnect'))!
    const saveButton = wrapper.findAll('button').find((button) => button.text().includes('Save'))!

    expect(tokenInput.attributes('type')).toBe('text')
    expect(tokenInput.classes()).toContain('input-secret')
    await showButton.trigger('click')
    expect(tokenInput.attributes('type')).toBe('text')
    expect(tokenInput.classes()).not.toContain('input-secret')

    await validateButton.trigger('click')
    expect(toastError).toHaveBeenCalledWith('Enter your Hardcover API token first')
    expect(mocks.validateToken).not.toHaveBeenCalled()

    await tokenInput.setValue('pending-token')
    await saveButton.trigger('click')
    await flushPromises()

    expect(toastError).toHaveBeenCalledWith('Hardcover rejected the request')
    expect((tokenInput.element as HTMLInputElement).value).toBe('pending-token')

    await tokenInput.setValue('disconnect-token')
    await validateButton.trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('Valid (neon)')

    await disconnectButton.trigger('click')
    await flushPromises()

    expect(mocks.disconnect).toHaveBeenCalledTimes(1)
    expect(toastSuccess).toHaveBeenCalledWith('Hardcover disconnected')
    expect((tokenInput.element as HTMLInputElement).value).toBe('')
    expect(wrapper.text()).not.toContain('Valid (neon)')
  })
})
