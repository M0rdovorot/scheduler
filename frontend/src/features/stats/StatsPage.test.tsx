// @vitest-environment jsdom
import { json, net, type StubRequest } from '@/test/fetchStub'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAuthStore } from '@/api/authStore'
import { setupApi } from '@/api/setup'
import type { Category, StatsReport, User } from '@/api/types'
import { App } from '@/app/App'
import { createBrowserPlatform } from '@/platform/browser'
import { PlatformContext } from '@/platform/context'

const NOW = new Date('2026-10-14T09:00:00Z') // Wednesday, 12:00 in Moscow

const user: User = {
  id: 'u1',
  display_name: 'Ann',
  timezone: 'Europe/Moscow',
  slot_minutes: 30,
  default_view: 'day',
  deviation_threshold_minutes: 10,
}

const category = (
  id: string,
  name: string,
  color: string,
  parent: string | null = null,
): Category => ({
  id,
  name,
  parent_id: parent,
  color,
  archived_at: null,
})

const categories = [
  category('sport', 'Спорт', '#ef4444'),
  category('run', 'Бег', '#f97316', 'sport'),
  category('work', 'Работа', '#3b82f6'),
]

const report = (over: Partial<StatsReport> = {}): StatsReport => ({
  from: '2026-10-11T21:00:00Z',
  to: '2026-10-18T21:00:00Z',
  actual_minutes: 270,
  planned_minutes: 300,
  unplanned_minutes: 30,
  unplanned_count: 1,
  long_running_timers: 0,
  uncategorized_minutes: 30,
  categories: [
    { category_id: 'sport', minutes: 90 },
    { category_id: 'run', minutes: 60 },
    { category_id: 'work', minutes: 120 },
  ],
  tasks: [
    { title: 'Работа', count: 2, minutes: 120 },
    { title: 'Бег', count: 1, minutes: 60 },
  ],
  days: [
    {
      date: '2026-10-12',
      minutes: 150,
      by_category: [
        { category_id: 'work', minutes: 120 },
        { category_id: 'run', minutes: 30 },
      ],
    },
    { date: '2026-10-13', minutes: 120, by_category: [{ category_id: null, minutes: 30 }] },
  ],
  plan_vs_fact: {
    planned_count: 4,
    done: 2,
    partial: 1,
    not_done: 1,
    in_progress: 0,
    unmarked: 0,
    upcoming: 0,
    rescheduled: 1,
    late_starts: 2,
    overran: 1,
    percent_done: 50,
  },
  deviations: [
    {
      id: 'i1',
      title: 'Бег',
      description: '',
      planned_start: '2026-10-12T06:00:00Z',
      planned_end: '2026-10-12T07:00:00Z',
      actual_start: null,
      actual_end: null,
      status: 'not_done',
      comment: 'Болел',
      category_ids: [],
      series_id: null,
      habit_id: null,
      rescheduled_from: null,
      rescheduled_to: null,
      deviations: [],
    },
  ],
  ...over,
})

let current: StatsReport

function server(req: StubRequest): Response {
  if (req.path === '/auth/dev')
    return json(200, { token: 't', expires_at: '2030-01-01T00:00:00Z', user })
  if (req.method === 'GET' && req.path === '/me') return json(200, user)
  if (req.path === '/stats') return json(200, current)
  if (req.path === '/categories') return json(200, categories)
  if (req.path.startsWith('/instances')) return json(200, [])
  return json(404, { code: 'not_found', message: 'nf' })
}

const platform = createBrowserPlatform()

function renderStats() {
  render(
    <PlatformContext.Provider value={platform}>
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <MemoryRouter initialEntries={['/stats']}>
          <App />
        </MemoryRouter>
      </QueryClientProvider>
    </PlatformContext.Provider>,
  )
}

const statsCalls = () => net.calls.filter((c) => c.path === '/stats')

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
  current = report()
  net.calls.length = 0
  net.handler = server
  useAuthStore.getState().setToken(null)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('StatsPage', () => {
  it('asks for the current week in the user time zone', async () => {
    renderStats()
    await screen.findByTestId('actual-total')
    const call = statsCalls()[0]!
    expect(call.query.get('from')).toBe('2026-10-11T21:00:00.000Z')
    expect(call.query.get('to')).toBe('2026-10-18T21:00:00.000Z')
    expect(screen.getByTestId('period-label').textContent).toMatch(/^12 – 18/)
  })

  it('shows the fact as the headline and the plan next to it', async () => {
    renderStats()
    expect((await screen.findByTestId('actual-total')).textContent).toBe('4 ч 30 мин')
    expect(screen.getByText(/План: 5 ч/)).toBeTruthy()
    expect(screen.getByText(/вне плана: 30 мин \(1\)/)).toBeTruthy()
    expect(document.querySelector('[data-tile="percent-done"]')!.textContent).toContain('50%')
    expect(document.querySelector('[data-tile="late-starts"]')!.textContent).toContain('2')
  })

  it('lists categories as a tree with the largest first, and what has no category', async () => {
    renderStats()
    const list = await screen.findByTestId('category-rows')
    const items = within(list).getAllByRole('listitem')
    expect(items.map((li) => li.getAttribute('data-category'))).toEqual([
      'work',
      'sport',
      'run',
      'none',
    ])
    expect(items[2]!.textContent).toContain('1 ч')
  })

  it('lists deviations with their comments', async () => {
    renderStats()
    const row = await screen.findByTestId('deviation-rows')
    expect(row.textContent).toContain('Не выполнено')
    expect(row.textContent).toContain('«Болел»')
  })

  it('moves to the next week and asks again', async () => {
    const user = userEvent.setup()
    renderStats()
    await screen.findByTestId('actual-total')
    await user.click(screen.getByRole('button', { name: 'Следующий период' }))
    await vi.waitFor(() => expect(statsCalls()).toHaveLength(2))
    expect(statsCalls()[1]!.query.get('from')).toBe('2026-10-18T21:00:00.000Z')
  })

  it('switches to a day without drawing a one-column chart', async () => {
    const user = userEvent.setup()
    renderStats()
    await screen.findByTestId('daily-chart')
    await user.click(screen.getByRole('tab', { name: 'День' }))
    await vi.waitFor(() => expect(statsCalls()).toHaveLength(2))
    expect(statsCalls()[1]!.query.get('from')).toBe('2026-10-13T21:00:00.000Z')
    await vi.waitFor(() => expect(screen.queryByTestId('daily-chart')).toBeNull())
  })

  it('does not ask the server for a custom period that is too long', async () => {
    const user = userEvent.setup()
    renderStats()
    await screen.findByTestId('actual-total')
    await user.click(screen.getByRole('tab', { name: 'Период' }))
    const from = screen.getByLabelText('С')
    await user.clear(from)
    await user.type(from, '2025-01-01')
    expect((await screen.findByRole('alert')).textContent).toMatch(/не длиннее/)
    const before = statsCalls().length
    await new Promise((r) => setTimeout(r, 30))
    // The last request, if any, was for a valid range.
    for (const call of statsCalls().slice(before - 1)) {
      const days = (Date.parse(call.query.get('to')!) - Date.parse(call.query.get('from')!)) / 864e5
      expect(days).toBeLessThanOrEqual(367)
    }
  })

  it('keeps the dates in view when leaving a custom period', async () => {
    const user = userEvent.setup()
    renderStats()
    await screen.findByTestId('actual-total')
    await user.click(screen.getByRole('tab', { name: 'Период' }))
    const from = screen.getByLabelText('С')
    await user.clear(from)
    await user.type(from, '2026-03-04')
    const to = screen.getByLabelText('По')
    await user.clear(to)
    await user.type(to, '2026-03-20')
    await user.click(screen.getByRole('tab', { name: 'Месяц' }))
    expect((await screen.findByTestId('period-label')).textContent).toMatch(/март\s+2026/)
  })

  it('draws the chart with a legend and shows numbers on hover and in a table', async () => {
    const user = userEvent.setup()
    renderStats()
    const chart = await screen.findByTestId('daily-chart')
    expect(screen.getByRole('list', { name: 'Категории на графике' }).textContent).toContain(
      'Работа',
    )
    await user.hover(chart.querySelector('[data-column="2026-10-12"]')!)
    expect(screen.getByTestId('chart-tooltip').textContent).toContain('Всего: 2 ч 30 мин')
    await user.unhover(chart.querySelector('[data-column="2026-10-12"]')!)

    await user.click(screen.getByRole('button', { name: 'Таблица' }))
    const table = screen.getByTestId('chart-table')
    expect(within(table).getAllByRole('row')).toHaveLength(3)
    expect(screen.queryByTestId('daily-chart')).toBeNull()
  })

  it('warns about timers that run for too long', async () => {
    current = report({ long_running_timers: 1 })
    renderStats()
    const note = await screen.findByTestId('long-timers')
    expect(within(note).getByRole('link', { name: 'К таймерам' }).getAttribute('href')).toBe(
      '/timers',
    )
  })

  it('says so when there is nothing in the period', async () => {
    current = report({
      actual_minutes: 0,
      planned_minutes: 0,
      unplanned_minutes: 0,
      unplanned_count: 0,
      uncategorized_minutes: 0,
      categories: [],
      tasks: [],
      days: [{ date: '2026-10-12', minutes: 0, by_category: [] }],
      deviations: [],
      plan_vs_fact: { ...report().plan_vs_fact, planned_count: 0, percent_done: null },
    })
    renderStats()
    expect(await screen.findByTestId('stats-empty')).toBeTruthy()
    expect(screen.queryByTestId('daily-chart')).toBeNull()
    expect(document.querySelector('[data-tile="percent-done"]')!.textContent).toContain('—')
  })
})
