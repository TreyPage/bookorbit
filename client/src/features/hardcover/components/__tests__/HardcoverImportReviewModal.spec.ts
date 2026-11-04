import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HardcoverImportPreview, HardcoverImportPreviewRow } from '@bookorbit/types'
import { resetLibraries } from '@/features/library/composables/useLibraries'
import HardcoverImportReviewModal from '../HardcoverImportReviewModal.vue'

type ApiFn = (input: RequestInfo | URL, init?: RequestInit & { _isRetry?: boolean }) => Promise<Response>

vi.mock('@/lib/api', () => ({
  api: vi.fn<ApiFn>(),
}))

import { api } from '@/lib/api'

const mockApi = vi.mocked(api)

function makeRow(overrides: Partial<HardcoverImportPreviewRow> = {}): HardcoverImportPreviewRow {
  const id = overrides.hardcoverUserBookId ?? 1000
  return {
    hardcoverUserBookId: id,
    hardcoverBookId: id + 10,
    hardcoverEditionId: id + 20,
    hardcoverReadId: id + 30,
    hardcoverTitle: `Hardcover ${id}`,
    hardcoverAuthors: ['Frank Herbert'],
    hardcoverIsbn10: null,
    hardcoverIsbn13: null,
    hardcoverStatusId: 3,
    hardcoverStatusLabel: 'Read',
    importedStatus: 'read',
    importedStartedAt: '2024-01-01',
    importedFinishedAt: '2024-01-10',
    importedProgressPercent: 100,
    localBookId: id + 40,
    localPrimaryFileId: id + 50,
    localTitle: `Book ${id}`,
    localAuthors: ['Frank Herbert'],
    localReadStatus: null,
    localProgressPercent: null,
    matchMethod: 'isbn',
    confidence: 100,
    outcome: 'will_update',
    reason: 'Ready to import',
    progressOutcome: 'will_update',
    progressReason: 'Ready to import progress',
    ...overrides,
  }
}

function makePreview(
  rows: HardcoverImportPreviewRow[],
  hardcoverShelfIds: HardcoverImportPreview['hardcoverShelfIds'] = ['read'],
  hardcoverListIds: HardcoverImportPreview['hardcoverListIds'] = [],
): HardcoverImportPreview {
  return {
    rows,
    hardcoverShelfIds,
    hardcoverListIds,
    summary: {
      totalHardcoverBooks: rows.length,
      matchedBooks: rows.filter((row) => row.localBookId != null).length,
      willUpdate: rows.filter((row) => row.outcome === 'will_update').length,
      needsReview: rows.filter((row) => row.outcome === 'needs_review').length,
      conflicts: rows.filter((row) => row.outcome === 'conflict').length,
      unmatched: rows.filter((row) => row.outcome === 'unmatched').length,
      skipped: rows.filter((row) => row.outcome === 'skipped').length,
      progressWillUpdate: rows.filter((row) => row.progressOutcome === 'will_update').length,
      progressConflicts: rows.filter((row) => row.progressOutcome === 'conflict').length,
      progressSkipped: rows.filter((row) => row.progressOutcome === 'skipped').length,
    },
  }
}

function mountModal(preview = makePreview([makeRow()])) {
  return mount(HardcoverImportReviewModal, {
    props: {
      preview,
      applying: false,
      importProgress: true,
    },
    global: {
      stubs: { Teleport: true },
    },
  })
}

describe('HardcoverImportReviewModal', () => {
  beforeEach(() => {
    mockApi.mockReset()
    resetLibraries()
  })

  it('selects ready rows by default and emits the selected ids', async () => {
    const wrapper = mountModal(
      makePreview([
        makeRow({ hardcoverUserBookId: 1000, outcome: 'will_update' }),
        makeRow({
          hardcoverUserBookId: 1001,
          outcome: 'needs_review',
          matchMethod: 'title_author',
          confidence: 91,
          reason: 'Review title and author match before import',
        }),
      ]),
    )

    await wrapper
      .findAll('button')
      .find((button) => button.text().includes('Import selected'))!
      .trigger('click')

    expect(wrapper.emitted('apply')).toEqual([[[1000]]])
  })

  it('shows list-only books by default when a custom list is selected', () => {
    const wrapper = mountModal(
      makePreview(
        [
          makeRow({ hardcoverUserBookId: 1000, outcome: 'will_update' }),
          makeRow({
            hardcoverUserBookId: -9001,
            hardcoverListBookId: 9001,
            hardcoverListName: 'Owned',
            hardcoverTitle: 'Owned only book',
            localTitle: null,
            hardcoverStatusId: null,
            hardcoverStatusLabel: 'Unknown',
            importedStatus: null,
            outcome: 'unmatched',
            progressOutcome: 'skipped',
            reason: 'No matching book found',
          }),
        ],
        ['want_to_read'],
        [19],
      ),
    )

    expect(wrapper.text()).toContain('Owned only book')
  })

  it('allows review rows and progress import to be selected explicitly', async () => {
    const wrapper = mountModal(
      makePreview([
        makeRow({ hardcoverUserBookId: 1000, outcome: 'will_update' }),
        makeRow({
          hardcoverUserBookId: 1001,
          outcome: 'needs_review',
          matchMethod: 'title_author',
          confidence: 91,
          reason: 'Review title and author match before import',
        }),
      ]),
    )

    await wrapper.findAll('input[type="checkbox"]')[0]!.setValue(false)
    await wrapper
      .findAll('button')
      .find((button) => button.text().includes('Review'))!
      .trigger('click')
    await wrapper.findAll('input[type="checkbox"]')[1]!.setValue(true)
    await wrapper
      .findAll('button')
      .find((button) => button.text().includes('Import selected'))!
      .trigger('click')

    expect(wrapper.emitted('update:importProgress')).toEqual([[false]])
    expect(wrapper.emitted('apply')).toEqual([[[1000, 1001]]])
  })

  it('paginates large previews without rendering every row at once', async () => {
    const rows = Array.from({ length: 55 }, (_, index) => makeRow({ hardcoverUserBookId: 1000 + index }))
    const wrapper = mountModal(makePreview(rows))

    expect(wrapper.text()).toContain('1-50 of 55')
    expect(wrapper.text()).toContain('Book 1000')
    expect(wrapper.text()).not.toContain('Book 1054')

    await wrapper.get('button[aria-label="Next page"]').trigger('click')

    expect(wrapper.text()).toContain('51-55 of 55')
    expect(wrapper.text()).toContain('Book 1054')
  })

  it('shows an empty state when filters match no rows', async () => {
    const wrapper = mountModal(makePreview([makeRow({ localTitle: 'Dune' })]))

    await wrapper.get('input[type="search"]').setValue('foundation')

    expect(wrapper.text()).toContain('No rows match the current filters.')
  })

  it('matches accented book metadata with an unaccented search term', async () => {
    const wrapper = mountModal(makePreview([makeRow({ localTitle: 'El Criticón', localAuthors: ['Baltasar Gracián'] })]))

    await wrapper.get('input[type="search"]').setValue('gracian')

    expect(wrapper.text()).toContain('El Criticón')
    expect(wrapper.text()).not.toContain('No rows match the current filters.')
  })

  it('supports bulk selection controls across the current page', async () => {
    const wrapper = mountModal(
      makePreview([
        makeRow({ hardcoverUserBookId: 1000, outcome: 'will_update' }),
        makeRow({
          hardcoverUserBookId: 1001,
          outcome: 'needs_review',
          matchMethod: 'title_author',
          confidence: 91,
          reason: 'Review title and author match before import',
        }),
      ]),
    )

    await wrapper
      .findAll('button')
      .find((button) => button.text().includes('Clear selection'))!
      .trigger('click')
    await wrapper
      .findAll('button')
      .find((button) => button.text().includes('Review'))!
      .trigger('click')
    await wrapper
      .findAll('button')
      .find((button) => button.text().includes('Select page'))!
      .trigger('click')
    await wrapper
      .findAll('button')
      .find((button) => button.text().includes('Clear page'))!
      .trigger('click')
    await wrapper
      .findAll('button')
      .find((button) => button.text().includes('Select ready'))!
      .trigger('click')
    await wrapper
      .findAll('button')
      .find((button) => button.text().includes('Import selected'))!
      .trigger('click')

    expect(wrapper.emitted('apply')).toEqual([[[1000]]])
  })

  it('renders fallback labels and non-ready outcome states', async () => {
    const wrapper = mountModal(
      makePreview([
        makeRow({
          hardcoverUserBookId: 1000,
          localTitle: null,
          hardcoverTitle: null,
          localAuthors: [],
          hardcoverAuthors: [],
          importedStatus: null,
          localReadStatus: 'on_hold',
          matchMethod: 'hardcover_id',
          confidence: null,
          outcome: 'conflict',
          progressOutcome: 'conflict',
          progressReason: 'BookOrbit already has reading progress',
          importedProgressPercent: 12.34,
          localProgressPercent: 4.5,
          reason: 'BookOrbit already has a read status',
        }),
        makeRow({
          hardcoverUserBookId: 1001,
          localTitle: null,
          hardcoverTitle: 'Remote only',
          localAuthors: ['Local Author'],
          hardcoverAuthors: ['Hardcover Author'],
          matchMethod: null,
          confidence: null,
          outcome: 'unmatched',
          progressOutcome: 'skipped',
          progressReason: 'No matching BookOrbit book found',
          importedProgressPercent: null,
          localProgressPercent: null,
          reason: 'No matching BookOrbit book found',
        }),
        makeRow({
          hardcoverUserBookId: 1002,
          outcome: 'skipped',
          matchMethod: 'title_author',
          progressOutcome: 'skipped',
          reason: 'Hardcover status is not imported',
        }),
      ]),
    )

    await wrapper
      .findAll('button')
      .find((button) => button.text().includes('All'))!
      .trigger('click')

    expect(wrapper.text()).toContain('Untitled')
    expect(wrapper.text()).toContain('Remote only')
    expect(wrapper.text()).toContain('Local Author / Hardcover Author')
    expect(wrapper.text()).toContain('Hardcover ID / -')
    expect(wrapper.text()).toContain('Title + author')
    expect(wrapper.text()).toContain('12.3% Hardcover')
    expect(wrapper.text()).toContain('4.5% BookOrbit')
    expect(wrapper.text()).toContain('Conflict')
    expect(wrapper.text()).toContain('Unmatched')
    expect(wrapper.text()).toContain('Skipped')
  })

  it('does not close while apply is in progress', async () => {
    const wrapper = mount(HardcoverImportReviewModal, {
      props: {
        preview: makePreview([makeRow()]),
        applying: true,
        importProgress: true,
      },
      global: {
        stubs: { Teleport: true },
      },
    })

    await wrapper.get('button[aria-label="Close import review"]').trigger('click')

    expect(wrapper.emitted('close')).toBeUndefined()
  })

  it('can request a missing book from a selected custom Hardcover list', async () => {
    mockApi.mockImplementation(async (path, init) => {
      if (path === '/api/v1/libraries') {
        return new Response(JSON.stringify([{ id: 12, name: 'Books', folders: [{ id: 19, path: 'C:/Books' }] }]), { status: 200 })
      }
      if (path === '/api/v1/book-requests/default-destinations') {
        return new Response(
          JSON.stringify({
            ebook: { libraryId: null, libraryName: null, folderId: null },
            audiobook: { libraryId: null, libraryName: null, folderId: null },
          }),
          { status: 200 },
        )
      }
      if (path === '/api/v1/book-requests/availability') {
        const body = JSON.parse(String(init?.body)) as { items: Array<{ mediaKind: string }> }
        return new Response(
          JSON.stringify(
            body.items.map((item) => ({
              ownedBookId: item.mediaKind === 'audiobook' ? 88 : null,
              existingRequestId: null,
              existingRequestStatus: null,
              alreadySubscribed: false,
            })),
          ),
          { status: 200 },
        )
      }
      return new Response(JSON.stringify({ request: { id: 44, status: 'pending' }, subscribed: false }), { status: 201 })
    })

    const wrapper = mount(HardcoverImportReviewModal, {
      props: {
        preview: makePreview(
          [
            makeRow({
              hardcoverUserBookId: -9001,
              hardcoverListBookId: 9001,
              hardcoverListName: 'Owned',
              hardcoverBookId: 1010,
              hardcoverTitle: 'Hardcover 1000',
              hardcoverIsbn13: '9780441172719',
            }),
          ],
          [],
          [19],
        ),
        applying: false,
        importProgress: true,
        canRequestBooks: true,
        requiresRequestDestination: true,
      },
      global: { stubs: { Teleport: true } },
    })
    await flushPromises()

    expect(mockApi).toHaveBeenCalledWith('/api/v1/book-requests/availability', expect.objectContaining({ method: 'POST' }))
    await wrapper.get('input[value="list:9001:ebook"]').setValue(true)
    await wrapper
      .findAll('button')
      .find((button) => button.text().includes('Add 1 to requests'))!
      .trigger('click')
    await flushPromises()

    expect(mockApi).toHaveBeenCalledWith(
      '/api/v1/book-requests',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          title: 'Hardcover 1000',
          mediaKind: 'ebook',
          authors: ['Frank Herbert'],
          isbn10: null,
          isbn13: '9780441172719',
          providerKey: 'hardcover',
          providerId: '1010',
          targetLibraryId: 12,
          targetFolderId: 19,
        }),
      }),
    )
    expect(wrapper.text()).toContain('1 added, 0 joined existing requests, 0 skipped because availability changed.')
  })
})
