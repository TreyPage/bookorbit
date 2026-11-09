import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BookRequestActivityItem } from '@bookorbit/types'

const api = vi.fn<(input: string) => Promise<Response>>()
vi.mock('@/lib/api', () => ({ api: (...args: [string]) => api(...args) }))

import RequestActivityPanel from '../components/RequestActivityPanel.vue'

const activity: BookRequestActivityItem = {
  id: 41,
  action: 'book_request.stalled',
  description: 'Download stalled after 12 hours without progress; automatic recovery was started',
  actorUsername: 'system',
  actorName: null,
  createdAt: '2026-11-08T18:00:00.000Z',
}

beforeEach(() => api.mockReset())

describe('RequestActivityPanel', () => {
  it('loads and displays the request-scoped lifecycle history', async () => {
    api.mockResolvedValue({ ok: true, json: () => Promise.resolve({ data: [activity], total: 1 }) } as Response)
    const wrapper = mount(RequestActivityPanel, { props: { requestId: 7 } })
    await flushPromises()

    expect(api).toHaveBeenCalledWith('/api/v1/book-requests/7/activity')
    expect(wrapper.text()).toContain(activity.description)
    expect(wrapper.text()).toContain('BookOrbit automation')
  })

  it('shows an empty state when the request has no audit events', async () => {
    api.mockResolvedValue({ ok: true, json: () => Promise.resolve({ data: [], total: 0 }) } as Response)
    const wrapper = mount(RequestActivityPanel, { props: { requestId: 7 } })
    await flushPromises()

    expect(wrapper.text()).toContain('No activity has been recorded yet.')
  })

  it('reports an activity loading error without hiding the rest of the request', async () => {
    api.mockResolvedValue({ ok: false } as Response)
    const wrapper = mount(RequestActivityPanel, { props: { requestId: 7 } })
    await flushPromises()

    expect(wrapper.find('[role="alert"]').exists()).toBe(true)
  })
})
