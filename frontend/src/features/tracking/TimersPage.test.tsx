// @vitest-environment jsdom
import { json, net, type StubRequest } from '@/test/fetchStub'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAuthStore } from '@/api/authStore'
import { setupApi } from '@/api/setup'
import type { Instance, User } from '@/api/types'
import { App } from '@/app/App'
import { useCalendarStore } from '@/features/calendar/calendarStore'
import { createBrowserPlatform } from '@/platform/browser'
import { PlatformContext } from '@/platform/context'

const NOW = new Date('2026-10-14T09:00:00Z') // 12:00 in Moscow

const user: User = {
  id: 'u1',
  display_name: 'Ann',
  timezone: 'Europe/Moscow',
  slot_minutes: 30,
  default_view: 'day',
  deviation_threshold_minutes: 10,
}

let instances: Instance[]

const timer = (id: string, title: string, startedAt: string): Instance => ({
  id,
  title,
  description: '',
  planned_start: null,
  planned_end: null,
  actual_start: startedAt,
  actual_end: null,
  status: 'in_progress',
  comment: '',
  category_ids: [],
  series_id: null,
  habit_id: null,
  rescheduled_from: null,
  rescheduled_to: null,
  deviations: [],
})

function server(req: StubRequest): Response {
  if (req.path === '/auth/dev')
    return json(200, { token: 't', expires_at: '2030-01-01T00:00:00Z', user })
  if (req.method === 'GET' && req.path === '/me') return json(200, user)
  if (req.method === 'GET' && req.path === '/instances/running') {
    return json(
      200,
      instances.filter((i) => i.status === 'in_progress'),
    )
  }
  if (req.method === 'GET' && req.path === '/instances') {
    return json(200, instances)
  }
  if (req.method === 'GET' && req.path === '/categories') return json(200, [])
  const stop = /^\/instances\/([^/]+)\/stop$/.exec(req.path)
  if (req.method === 'POST' && stop) {
    const target = instances.find((i) => i.id === stop[1])!
    Object.assign(target, { status: 'done', actual_end: NOW.toISOString() })
    return json(200, target)
  }
  return json(404, { code: 'not_found', message: 'nf' })
}

const platform = createBrowserPlatform()

function renderAt(path: string) {
  render(
    <PlatformContext.Provider value={platform}>
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <MemoryRouter initialEntries={[path]}>
          <App />
        </MemoryRouter>
      </QueryClientProvider>
    </PlatformContext.Provider>,
  )
}

beforeAll(() => {
  window.matchMedia = (() => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia
  setupApi(platform)
})

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW })
  instances = []
  net.calls.length = 0
  net.handler = server
  useAuthStore.getState().setToken(null)
  useCalendarStore.setState({ view: null, anchor: null, mode: 'both' })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('running timers', () => {
  it('shows a mark with the number of timers in the calendar header, leading to the list', async () => {
    instances = [
      timer('a', 'Спорт', '2026-10-14T08:00:00Z'),
      timer('b', 'Чтение', '2026-10-10T08:00:00Z'),
    ]
    renderAt('/')
    const badge = await screen.findByRole('link', { name: 'Запущенные таймеры: 2' })
    expect(badge.textContent).toBe('2')
    expect(badge.getAttribute('href')).toBe('/timers')
  })

  it('shows no mark when nothing runs', async () => {
    renderAt('/')
    await screen.findByRole('radio', { name: 'День' })
    await vi.waitFor(() =>
      expect(net.calls.some((c) => c.path === '/instances/running')).toBe(true),
    )
    expect(screen.queryByRole('link', { name: /Запущенные таймеры/ })).toBeNull()
  })

  it('draws a pulsing dot on a running task in the grid', async () => {
    instances = [timer('a', 'Спорт', '2026-10-14T08:00:00Z')]
    renderAt('/')
    const block = await screen.findByRole('button', { name: /Спорт/ })
    expect(block.querySelector('[data-running]')).toBeTruthy()
    expect(block.querySelector('[data-mark]')).toBeNull()
  })

  it('lists the timers from every day with their running time', async () => {
    instances = [
      timer('a', 'Спорт', '2026-10-14T07:20:00Z'), // 10:20 today: 1:40:00 so far
      timer('b', 'Чтение', '2026-10-12T07:00:00Z'), // two days ago
    ]
    renderAt('/timers')

    const cards = await screen.findAllByRole('listitem')
    expect(cards).toHaveLength(2)
    expect(within(cards[0]!).getByTestId('elapsed').textContent).toBe('1:40:00')
    expect(within(cards[0]!).getByText(/с 10:20/)).toBeTruthy()
    expect(within(cards[0]!).queryByTestId('too-long')).toBeNull()
    // The old one shows the day it was started on.
    expect(within(cards[1]!).getByText(/с 10:00, 12\.10/)).toBeTruthy()
    expect(within(cards[1]!).getByTestId('too-long').textContent).toMatch(
      /больше 12 часов.*первые 12/,
    )
  })

  it('says so when there are no timers', async () => {
    renderAt('/timers')
    expect(await screen.findByText(/Нет запущенных таймеров/)).toBeTruthy()
  })

  it('stops a timer from the list', async () => {
    const ui = userEvent.setup()
    instances = [timer('a', 'Спорт', '2026-10-14T08:00:00Z')]
    renderAt('/timers')
    await ui.click(await screen.findByRole('button', { name: 'Стоп' }))

    await vi.waitFor(() => expect(screen.queryByRole('listitem')).toBeNull())
    expect(net.calls.filter((c) => c.method === 'POST').map((c) => c.path)).toContain(
      '/instances/a/stop',
    )
    expect(screen.getByText(/Нет запущенных таймеров/)).toBeTruthy()
  })

  it('opens the day of the timer in the calendar', async () => {
    const ui = userEvent.setup()
    instances = [timer('b', 'Чтение', '2026-10-12T07:00:00Z')]
    renderAt('/timers')
    await ui.click(await screen.findByRole('button', { name: 'Открыть в календаре' }))

    await screen.findByRole('radio', { name: 'День' })
    expect(document.querySelector('[data-day="2026-10-12"]')).toBeTruthy()
  })

  it('is reachable from the calendar menu', async () => {
    const ui = userEvent.setup()
    instances = [timer('a', 'Спорт', '2026-10-14T08:00:00Z')]
    renderAt('/')
    await ui.click(await screen.findByRole('button', { name: 'Меню' }))
    expect(screen.getByRole('link', { name: 'Таймеры (1)' }).getAttribute('href')).toBe('/timers')
    expect(screen.getByRole('link', { name: 'Статистика' }).getAttribute('href')).toBe('/stats')
  })
})
