import { flushPromises, mount } from '@vue/test-utils'
import { computed, ref } from 'vue'
import type { MissingBookEntry, MissingResourcesSummary, SidecarFileEntry } from '@bookorbit/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const permissions = ref<string[]>(['library_delete_books', 'library_edit_metadata', 'manage_libraries'])
const demoRestricted = ref(false)

vi.mock('@/features/auth/composables/usePermissions', () => ({
  usePermissions: () => ({
    hasPermission: (name: string) => permissions.value.includes(name),
    hasExplicitPermission: (name: string) => permissions.value.includes(name),
    isDemoRestrictedAccount: computed(() => demoRestricted.value),
    isSuperuser: computed(() => false),
    userPermissions: computed(() => permissions.value),
  }),
}))

vi.mock('../../api/missing-resources', () => ({
  cleanBrokenCovers: vi.fn<(...args: unknown[]) => unknown>(),
  cleanMissingBooks: vi.fn<(...args: unknown[]) => unknown>(),
  cleanOrphanedCoverDirs: vi.fn<(...args: unknown[]) => unknown>(),
  getBrokenCovers: vi.fn<(...args: unknown[]) => unknown>(),
  getCoverSweep: vi.fn<(...args: unknown[]) => unknown>(),
  getMissingBooks: vi.fn<(...args: unknown[]) => unknown>(),
  getMissingResourcesSummary: vi.fn<(...args: unknown[]) => unknown>(),
  getOrphanedCoverDirs: vi.fn<(...args: unknown[]) => unknown>(),
  startCoverSweep: vi.fn<(...args: unknown[]) => unknown>(),
}))

vi.mock('../../api/library-integrity', () => ({ getSidecarFileIssues: vi.fn<(...args: unknown[]) => unknown>() }))

vi.mock('vue-sonner', () => ({ toast: { success: vi.fn<(...args: unknown[]) => void>(), error: vi.fn<(...args: unknown[]) => void>() } }))

import * as api from '../../api/missing-resources'
import * as integrityApi from '../../api/library-integrity'
import MissingResourcesView from './MissingResourcesView.vue'

const summary: MissingResourcesSummary = { missingBooks: 2, sweep: null }

function sidecarFile(): SidecarFileEntry {
  return { libraryId: 1, libraryName: 'Main', path: '/library/book/notes.txt', kind: 'text_file', sizeBytes: 128, fileCount: 1 }
}

function missingBook(id: number): MissingBookEntry {
  return {
    id,
    title: `Book ${id}`,
    authors: ['Someone'],
    libraryId: 1,
    libraryName: 'Main',
    folderPath: `/library/book-${id}`,
    formats: ['epub'],
    updatedAt: null,
  }
}

async function mountView() {
  const wrapper = mount(MissingResourcesView, { attachTo: document.body })
  await flushPromises()
  return wrapper
}

describe('MissingResourcesView', () => {
  beforeEach(() => {
    permissions.value = ['library_delete_books', 'library_edit_metadata', 'manage_libraries']
    demoRestricted.value = false
    vi.mocked(api.getMissingResourcesSummary).mockResolvedValue(summary)
    vi.mocked(api.getMissingBooks).mockResolvedValue({ items: [missingBook(1), missingBook(2)], total: 2, page: 1, pageSize: 50 })
    vi.mocked(api.getBrokenCovers).mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 50 })
    vi.mocked(api.getOrphanedCoverDirs).mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 50 })
    vi.mocked(integrityApi.getSidecarFileIssues).mockResolvedValue({ items: [sidecarFile()], total: 1, page: 1, pageSize: 50, truncated: false })
  })

  afterEach(() => {
    vi.resetAllMocks()
  })

  it('refuses the tool without the book deletion permission', async () => {
    permissions.value = ['library_edit_metadata']
    const wrapper = await mountView()

    expect(wrapper.get('[role="alert"]').text()).toContain('do not have permission')
    expect(api.getMissingResourcesSummary).not.toHaveBeenCalled()
  })

  it('lists the missing books with a tab per permitted category', async () => {
    const wrapper = await mountView()

    expect(wrapper.findAll('[role="tab"]')).toHaveLength(4)
    expect(wrapper.text()).toContain('2 books with missing files')
    expect(wrapper.text()).toContain('Book 1')
  })

  it('hides the cover categories a user cannot clean', async () => {
    permissions.value = ['library_delete_books']
    const wrapper = await mountView()

    const tabs = wrapper.findAll('[role="tab"]').map((tab) => tab.text())
    expect(tabs).toHaveLength(2)
    expect(tabs[0]).toContain('Missing books')
    expect(tabs[1]).toContain('Sidecar and temporary files')
  })

  it('disables the cover tabs until a sweep has completed', async () => {
    const wrapper = await mountView()

    const tabs = wrapper.findAll('[role="tab"]')
    expect((tabs[1]!.element as HTMLButtonElement).disabled).toBe(true)
    expect((tabs[2]!.element as HTMLButtonElement).disabled).toBe(true)
    expect((tabs[3]!.element as HTMLButtonElement).disabled).toBe(false)
  })

  it('shows sidecar findings as a read-only category in the shared results view', async () => {
    const wrapper = await mountView()
    const sidecarTab = wrapper.findAll('[role="tab"]').find((tab) => tab.text().includes('Sidecar and temporary files'))

    await sidecarTab!.trigger('click')
    await flushPromises()

    expect(integrityApi.getSidecarFileIssues).toHaveBeenCalledWith({ page: 1, pageSize: 50 })
    expect(wrapper.text()).toContain('/library/book/notes.txt')
    expect(wrapper.text()).toContain('Text file (.txt)')
    expect(wrapper.find('input[type="checkbox"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('Clean 1 selected')
    wrapper.unmount()
  })

  it('confirms before cleaning the selected books', async () => {
    vi.mocked(api.cleanMissingBooks).mockResolvedValue({ category: 'missing_books', requested: 1, cleaned: 1, skipped: 0, remaining: 1 })
    const wrapper = await mountView()

    const rowCheckboxes = wrapper.findAll('li input[type="checkbox"]')
    await rowCheckboxes[0]!.setValue(true)
    await wrapper.get('button.bg-destructive').trigger('click')
    await flushPromises()

    expect(document.body.textContent).toContain('Clean missing resources?')
    expect(api.cleanMissingBooks).not.toHaveBeenCalled()

    const confirmButton = [...document.body.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Clean')
    confirmButton?.click()
    await flushPromises()

    expect(api.cleanMissingBooks).toHaveBeenCalledWith({ bookIds: [1] })
    wrapper.unmount()
  })

  it('hides the clean action for a demo-restricted account', async () => {
    demoRestricted.value = true
    const wrapper = await mountView()

    await wrapper.findAll('li input[type="checkbox"]')[0]!.setValue(true)

    expect(wrapper.text()).toContain('Clear selection')
    expect(wrapper.find('button.bg-destructive').exists()).toBe(false)
    wrapper.unmount()
  })

  it('starts a cover sweep from the panel', async () => {
    vi.mocked(api.startCoverSweep).mockResolvedValue({
      status: 'running',
      processedBooks: 0,
      totalBooks: 10,
      progressPercent: 0,
      brokenCovers: 0,
      orphanedCoverDirs: 0,
      orphanedBytes: 0,
      truncated: false,
      errorCode: null,
      startedAt: '2026-08-01T00:00:00.000Z',
      completedAt: null,
    })
    vi.mocked(api.getCoverSweep).mockResolvedValue(null)
    const wrapper = await mountView()

    const runButton = wrapper.findAll('button').find((button) => button.text().includes('Run check'))
    await runButton!.trigger('click')
    await flushPromises()

    expect(api.startCoverSweep).toHaveBeenCalled()
    expect(wrapper.text()).toContain('Checked 0 of 10 books')
    wrapper.unmount()
  })
})
