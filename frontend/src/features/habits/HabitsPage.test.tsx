// @vitest-environment jsdom
import { json, net, noContent, type StubRequest } from '@/test/fetchStub'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAuthStore } from '@/api/authStore'
import { setupApi } from '@/api/setup'
import type { Habit, HabitDay, User } from '@/api/types'
import { App } from '@/app/App'
import { createBrowserPlatform } from '@/platform/browser'
import { PlatformContext } from '@/platform/context'

const NOW = new Date('2026-10-14T09:00:00Z') // Wednesday, 12:00 in Moscow
const TODAY = '2026-10-14'

const user: User = {
  id: 'u1',
  display_name: 'Ann',
  timezone: 'Europe/Moscow',
  slot_minutes: 30,
  default_view: 'day',
  deviation_threshold_minutes: 10,
}

const habit = (over: Partial<Habit> & Pick<Habit, 'id' | 'title'>): Habit => ({
  kind: 'boolean',
  target_value: 1,
  unit: '',
  frequency: 'daily',
  weekdays: [],
  times_per_week: null,
  color: '#3b82f6',
  archived_at: null,
  created_at: '2026-10-01T00:00:00Z',
  placement: null,
  ...over,
})

let habits: Habit[]
/** habit id → date → value */
let marks: Record<string, Record<string, number>>

function todayItems() {
  return habits
    .filter((h) => h.archived_at === null)
    .filter((h) => h.frequency !== 'weekdays' || h.weekdays.includes(3))
    .map((h) => {
      const value = marks[h.id]?.[TODAY] ?? 0
      return {
        habit: h,
        value,
        done: value >= h.target_value,
        week_done: h.frequency === 'times_per_week' ? 2 : 0,
        streaks: {
          current: h.id === 'run' ? 3 : 0,
          best: 5,
          unit: h.frequency === 'times_per_week' ? 'week' : 'day',
        },
      }
    })
}

function days(h: Habit, from: string, to: string): HabitDay[] {
  const out: HabitDay[] = []
  for (let t = Date.parse(from); t <= Date.parse(to); t += 864e5) {
    const date = new Date(t).toISOString().slice(0, 10)
    const value = marks[h.id]?.[date] ?? 0
    out.push({ date, value, done: value >= h.target_value, planned: true })
  }
  return out
}

function server(req: StubRequest): Response {
  if (req.path === '/auth/dev')
    return json(200, { token: 't', expires_at: '2030-01-01T00:00:00Z', user })
  if (req.path === '/categories') return json(200, [])
  if (req.path.startsWith('/instances')) return json(200, [])
  if (req.method === 'GET' && req.path === '/habits') return json(200, habits)
  if (req.method === 'GET' && req.path === '/habits/today')
    return json(200, { date: TODAY, items: todayItems() })
  if (req.method === 'POST' && req.path === '/habits') {
    const body = req.body as Partial<Habit>
    const created = habit({ id: 'new', title: body.title ?? '', ...body } as Habit)
    habits.push(created)
    return json(201, created)
  }
  const log = /^\/habits\/([^/]+)\/logs\/([^/]+)$/.exec(req.path)
  if (req.method === 'PUT' && log) {
    const value = (req.body as { value: number }).value
    marks[log[1]!] ??= {}
    if (value === 0) delete marks[log[1]!]![log[2]!]
    else marks[log[1]!]![log[2]!] = value
    return noContent()
  }
  const stats = /^\/habits\/([^/]+)\/stats$/.exec(req.path)
  if (req.method === 'GET' && stats) {
    const h = habits.find((x) => x.id === stats[1])
    if (!h) return json(404, { code: 'not_found', message: 'nf' })
    return json(200, {
      habit: h,
      today: TODAY,
      streaks: { current: 3, best: 7, unit: h.frequency === 'times_per_week' ? 'week' : 'day' },
      percent_all: 80,
      percent_30: 90,
      percent_90: null,
      days: days(h, req.query.get('from')!, req.query.get('to')!),
    })
  }
  const one = /^\/habits\/([^/]+)$/.exec(req.path)
  if (req.method === 'DELETE' && one) {
    habits = habits.filter((h) => h.id !== one[1])
    return noContent()
  }
  if (req.method === 'PATCH' && one) {
    const h = habits.find((x) => x.id === one[1])!
    Object.assign(h, req.body)
    return json(200, h)
  }
  const place = /^\/habits\/([^/]+)\/placement$/.exec(req.path)
  if (place && (req.method === 'PUT' || req.method === 'DELETE')) {
    const h = habits.find((x) => x.id === place[1])!
    h.placement =
      req.method === 'PUT' ? (req.body as { time: string; duration_minutes: number }) : null
    return json(200, h)
  }
  const arch = /^\/habits\/([^/]+)\/(archive|unarchive)$/.exec(req.path)
  if (req.method === 'POST' && arch) {
    const h = habits.find((x) => x.id === arch[1])!
    h.archived_at = arch[2] === 'archive' ? NOW.toISOString() : null
    return json(200, h)
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

const calls = (method: string, pathRe: RegExp) =>
  net.calls.filter((c) => c.method === method && pathRe.test(c.path))

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
  habits = [
    habit({ id: 'read', title: 'Читать' }),
    habit({
      id: 'water',
      title: 'Вода',
      kind: 'quantity',
      target_value: 8,
      unit: 'стаканов',
      color: '#06b6d4',
    }),
  ]
  marks = {}
  net.calls.length = 0
  net.handler = server
  useAuthStore.getState().setToken(null)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('the list of habits for today', () => {
  it('lists today habits with their schedule and streak', async () => {
    habits.push(
      habit({ id: 'run', title: 'Бег', frequency: 'weekdays', weekdays: [1, 3, 5] }),
      habit({ id: 'tue', title: 'По вторникам', frequency: 'weekdays', weekdays: [2] }),
    )
    renderAt('/habits')
    const list = await screen.findByTestId('habits-today')
    const rows = within(list).getAllByRole('listitem')
    expect(rows.map((r) => r.getAttribute('data-habit'))).toEqual(['read', 'water', 'run'])
    expect(rows[2]!.textContent).toContain('Пн, Ср, Пт')
    expect(rows[2]!.textContent).toContain('серия 3 дня')
    // Not for today: in its own section, with a link.
    const other = screen.getByRole('region', { name: 'Не на сегодня' })
    expect(
      within(other)
        .getByRole('link', { name: /По вторникам/ })
        .getAttribute('href'),
    ).toBe('/habits/tue')
  })

  it('marks a yes/no habit with one tap and takes the mark off with another', async () => {
    const user = userEvent.setup()
    renderAt('/habits')
    const button = await screen.findByRole('button', { name: 'Отметить: Читать' })
    expect(button.getAttribute('aria-pressed')).toBe('false')
    await user.click(button)

    await waitFor(() => expect(calls('PUT', /logs/)).toHaveLength(1))
    expect(calls('PUT', /logs/)[0]!.path).toBe(`/habits/read/logs/${TODAY}`)
    expect(calls('PUT', /logs/)[0]!.body).toEqual({ value: 1 })

    const marked = await screen.findByRole('button', { name: 'Снять отметку: Читать' })
    expect(marked.getAttribute('aria-pressed')).toBe('true')
    await user.click(marked)
    await waitFor(() => expect(calls('PUT', /logs/)).toHaveLength(2))
    expect(calls('PUT', /logs/)[1]!.body).toEqual({ value: 0 })
    await screen.findByRole('button', { name: 'Отметить: Читать' })
  })

  it('adds up a quantity with + and −', async () => {
    const user = userEvent.setup()
    renderAt('/habits')
    const plus = await screen.findByRole('button', { name: 'Больше: Вода' })
    const minus = screen.getByRole('button', { name: 'Меньше: Вода' })
    expect((minus as HTMLButtonElement).disabled).toBe(true)

    await user.click(plus)
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Значение: Вода' })).toHaveProperty('value', '1'),
    )
    await user.click(plus)
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Значение: Вода' })).toHaveProperty('value', '2'),
    )
    expect(calls('PUT', /logs/).map((c) => (c.body as { value: number }).value)).toEqual([1, 2])
    expect(screen.getByTestId('progress').textContent).toContain('2 из 8 стаканов')

    await user.click(screen.getByRole('button', { name: 'Меньше: Вода' }))
    await waitFor(() => expect(calls('PUT', /logs/)).toHaveLength(3))
    expect((calls('PUT', /logs/)[2]!.body as { value: number }).value).toBe(1)
  })

  it('shows a done quantity and keeps counting past the goal', async () => {
    marks.water = { [TODAY]: 8 }
    const user = userEvent.setup()
    renderAt('/habits')
    const row = (await screen.findByRole('textbox', { name: 'Значение: Вода' })).closest('li')!
    expect(row.getAttribute('data-done')).toBe('true')
    expect(row.textContent).toContain('8 из 8 стаканов ✓')
    await user.click(within(row).getByRole('button', { name: 'Больше: Вода' }))
    await waitFor(() => expect(calls('PUT', /logs/)[0]!.body).toEqual({ value: 9 }))
  })

  it('takes a typed value when the field is left, and ignores one that is not a number', async () => {
    const user = userEvent.setup()
    renderAt('/habits')
    const input = await screen.findByRole('textbox', { name: 'Значение: Вода' })
    await user.clear(input)
    await user.type(input, '12')
    await user.tab()
    await waitFor(() => expect(calls('PUT', /logs/)).toHaveLength(1))
    expect(calls('PUT', /logs/)[0]!.body).toEqual({ value: 12 })

    await user.clear(input)
    await user.type(input, 'abc')
    expect(input.getAttribute('aria-invalid')).toBe('true')
    await user.tab()
    expect(calls('PUT', /logs/)).toHaveLength(1)
    await waitFor(() => expect(input).toHaveProperty('value', '12'))
  })

  it('shows the weekly goal progress for a habit with a weekly goal', async () => {
    habits.push(habit({ id: 'gym', title: 'Зал', frequency: 'times_per_week', times_per_week: 3 }))
    renderAt('/habits')
    const row = (await screen.findByRole('link', { name: 'Зал' })).closest('li')!
    expect(row.textContent).toContain('На этой неделе: 2 из 3')
  })

  it('puts archived habits into the archive section only', async () => {
    habits.push(habit({ id: 'old', title: 'Старая', archived_at: '2026-09-01T00:00:00Z' }))
    renderAt('/habits')
    await screen.findByTestId('habits-today')
    expect(within(screen.getByTestId('habits-today')).queryByText('Старая')).toBeNull()
    expect(screen.getByText(/Архив \(1\)/)).toBeTruthy()
    expect(screen.getByRole('link', { name: /Старая/ }).getAttribute('href')).toBe('/habits/old')
  })

  it('says so when there are no habits', async () => {
    habits = []
    renderAt('/habits')
    expect(await screen.findByText(/Привычек пока нет/)).toBeTruthy()
  })
})

describe('creating a habit', () => {
  async function openForm() {
    const user = userEvent.setup()
    renderAt('/habits')
    await user.click(await screen.findByRole('button', { name: '+ Привычка' }))
    const dialog = await screen.findByRole('dialog', { name: 'Новая привычка' })
    return { user, dialog }
  }

  it('needs a title', async () => {
    const { user, dialog } = await openForm()
    const save = within(dialog).getByRole('button', { name: 'Сохранить' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    await user.type(within(dialog).getByRole('textbox', { name: /^Название/ }), 'Зарядка')
    expect(save.disabled).toBe(false)
  })

  it('creates a yes/no habit every day by default', async () => {
    const { user, dialog } = await openForm()
    await user.type(within(dialog).getByRole('textbox', { name: /^Название/ }), '  Зарядка ')
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }))
    await waitFor(() => expect(calls('POST', /^\/habits$/)).toHaveLength(1))
    expect(calls('POST', /^\/habits$/)[0]!.body).toEqual({
      title: 'Зарядка',
      kind: 'boolean',
      frequency: 'daily',
      color: '#3b82f6',
    })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('creates a quantity on chosen weekdays, placed in the calendar', async () => {
    const { user, dialog } = await openForm()
    await user.type(within(dialog).getByRole('textbox', { name: /^Название/ }), 'Вода')
    await user.click(within(dialog).getByRole('radio', { name: 'Количество' }))
    const goal = within(dialog).getByRole('textbox', { name: 'Цель в день' })
    await user.clear(goal)
    await user.type(goal, '8')
    await user.type(within(dialog).getByRole('textbox', { name: 'Единица' }), 'стаканов')
    await user.click(within(dialog).getByRole('radio', { name: 'По дням недели' }))
    await user.click(within(dialog).getByRole('button', { name: 'Вт' })) // Monday to Friday by default: Tuesday off
    await user.click(within(dialog).getByRole('checkbox', { name: 'Поставить в календарь' }))
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }))

    await waitFor(() => expect(calls('POST', /^\/habits$/)).toHaveLength(1))
    expect(calls('POST', /^\/habits$/)[0]!.body).toEqual({
      title: 'Вода',
      kind: 'quantity',
      target_value: 8,
      unit: 'стаканов',
      frequency: 'weekdays',
      weekdays: [1, 3, 4, 5],
      color: '#3b82f6',
      placement: { time: '09:00', duration_minutes: 30 },
    })
  })

  it('does not offer the calendar for a weekly goal', async () => {
    const { user, dialog } = await openForm()
    await user.click(within(dialog).getByRole('checkbox', { name: 'Поставить в календарь' }))
    expect(within(dialog).getByRole('textbox', { name: 'Минут' })).toBeTruthy()
    await user.click(within(dialog).getByRole('radio', { name: 'N раз в неделю' }))
    const box = within(dialog).getByRole('checkbox', {
      name: 'Поставить в календарь',
    }) as HTMLInputElement
    expect(box.disabled).toBe(true)
    expect(box.checked).toBe(false)
    expect(within(dialog).queryByRole('textbox', { name: 'Минут' })).toBeNull()

    await user.type(within(dialog).getByRole('textbox', { name: /^Название/ }), 'Зал')
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }))
    await waitFor(() => expect(calls('POST', /^\/habits$/)).toHaveLength(1))
    expect(calls('POST', /^\/habits$/)[0]!.body).toMatchObject({
      frequency: 'times_per_week',
      times_per_week: 3,
    })
    expect(calls('POST', /^\/habits$/)[0]!.body).not.toHaveProperty('placement')
  })

  it('shows what the server refused', async () => {
    net.handler = (req) =>
      req.method === 'POST' && req.path === '/habits'
        ? json(400, { code: 'validation_failed', field: 'title', message: 'bad' })
        : server(req)
    const { user, dialog } = await openForm()
    await user.type(within(dialog).getByRole('textbox', { name: /^Название/ }), 'Зарядка')
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/Название/)
    expect(screen.getByRole('dialog')).toBeTruthy()
  })
})

describe('the page of a habit', () => {
  it('shows the streaks, the percentages and the heat map of 18 weeks', async () => {
    renderAt('/habits/read')
    expect(await screen.findByRole('heading', { name: 'Читать' })).toBeTruthy()
    expect(document.querySelector('[data-tile="current"]')!.textContent).toContain('3 дня')
    expect(document.querySelector('[data-tile="best"]')!.textContent).toContain('7 дней')
    expect(document.querySelector('[data-tile="p30"]')!.textContent).toContain('90%')
    expect(document.querySelector('[data-tile="p90"]')!.textContent).toContain('—')
    expect(document.querySelectorAll('[data-cell]')).toHaveLength(18 * 7)
    const call = net.calls.find((c) => c.path === '/habits/read/stats')!
    expect(call.query.get('from')).toBe('2026-06-15')
    expect(call.query.get('to')).toBe('2026-10-18')
  })

  it('draws future days as not available', async () => {
    renderAt('/habits/read')
    await screen.findByTestId('heatmap')
    const future = document.querySelector('[data-cell="2026-10-15"]') as HTMLButtonElement
    expect(future.disabled).toBe(true)
    const today = document.querySelector(`[data-cell="${TODAY}"]`) as HTMLButtonElement
    expect(today.disabled).toBe(false)
  })

  it('fills the cells by the share of the goal', async () => {
    habits[0] = habit({ id: 'read', title: 'Вода', kind: 'quantity', target_value: 8, unit: 'ст.' })
    marks.read = { '2026-10-10': 8, '2026-10-11': 3, '2026-10-12': 0 }
    renderAt('/habits/read')
    await screen.findByTestId('heatmap')
    const level = (d: string) =>
      document.querySelector(`[data-cell="${d}"]`)!.getAttribute('data-level')
    expect(level('2026-10-10')).toBe('4')
    expect(level('2026-10-11')).toBe('2')
    expect(level('2026-10-12')).toBe('0')
  })

  it('sets a day of the past from the heat map', async () => {
    const user = userEvent.setup()
    renderAt('/habits/read')
    await screen.findByTestId('heatmap')
    await user.click(document.querySelector('[data-cell="2026-10-10"]')!)
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Выполнено' }))
    await waitFor(() => expect(calls('PUT', /logs/)).toHaveLength(1))
    expect(calls('PUT', /logs/)[0]!.path).toBe('/habits/read/logs/2026-10-10')
    expect(calls('PUT', /logs/)[0]!.body).toEqual({ value: 1 })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() =>
      expect(document.querySelector('[data-cell="2026-10-10"]')!.getAttribute('data-level')).toBe(
        '4',
      ),
    )
  })

  it('corrects the value of a quantity for a day', async () => {
    habits[0] = habit({ id: 'read', title: 'Вода', kind: 'quantity', target_value: 8, unit: 'ст.' })
    marks.read = { '2026-10-10': 8 }
    const user = userEvent.setup()
    renderAt('/habits/read')
    await screen.findByTestId('heatmap')
    await user.click(document.querySelector('[data-cell="2026-10-10"]')!)
    const dialog = await screen.findByRole('dialog')
    const input = within(dialog).getByRole('textbox')
    expect((input as HTMLInputElement).value).toBe('8')
    await user.clear(input)
    await user.type(input, '5')
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }))
    await waitFor(() => expect(calls('PUT', /logs/)[0]!.body).toEqual({ value: 5 }))
  })

  it('archives and brings back', async () => {
    const user = userEvent.setup()
    renderAt('/habits/read')
    await user.click(await screen.findByRole('button', { name: 'В архив' }))
    await waitFor(() => expect(calls('POST', /archive$/)).toHaveLength(1))
    expect(await screen.findByRole('button', { name: 'Вернуть из архива' })).toBeTruthy()
    expect(screen.getByText(/в архиве/)).toBeTruthy()
  })

  it('deletes after a confirmation, and goes back to the list', async () => {
    const user = userEvent.setup()
    renderAt('/habits/read')
    await user.click(await screen.findByRole('button', { name: 'Удалить' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain('«Читать» исчезнет вместе со всеми отметками')
    expect(calls('DELETE', /habits/)).toHaveLength(0)
    await user.click(within(dialog).getByRole('button', { name: 'Удалить' }))
    await waitFor(() => expect(calls('DELETE', /habits\/read$/)).toHaveLength(1))
    expect(await screen.findByRole('heading', { name: 'Привычки' })).toBeTruthy()
  })

  it('says so when the habit is not there', async () => {
    renderAt('/habits/gone')
    expect((await screen.findByRole('alert')).textContent).toMatch(/Не удалось загрузить привычку/)
  })
})

describe('editing a habit', () => {
  it('sends only what changed, and takes it out of the calendar before a weekly goal', async () => {
    habits[0] = habit({
      id: 'read',
      title: 'Читать',
      placement: { time: '07:30', duration_minutes: 20 },
    })
    const user = userEvent.setup()
    renderAt('/habits/read')
    await user.click(await screen.findByRole('button', { name: 'Изменить' }))
    const dialog = await screen.findByRole('dialog', { name: 'Привычка' })
    const save = within(dialog).getByRole('button', { name: 'Сохранить' }) as HTMLButtonElement
    expect(save.disabled).toBe(true) // nothing changed yet
    // The kind of a saved habit cannot change.
    expect(
      (within(dialog).getByRole('radio', { name: 'Количество' }) as HTMLButtonElement).disabled,
    ).toBe(true)

    await user.click(within(dialog).getByRole('radio', { name: 'N раз в неделю' }))
    await user.click(save)
    await waitFor(() => expect(calls('PATCH', /habits\/read$/)).toHaveLength(1))
    expect(calls('PATCH', /habits\/read$/)[0]!.body).toEqual({
      frequency: 'times_per_week',
      times_per_week: 3,
    })
    const order = net.calls
      .filter((c) => /placement|habits\/read$/.test(c.path) && c.method !== 'GET')
      .map((c) => `${c.method} ${c.path}`)
    expect(order).toEqual(['DELETE /habits/read/placement', 'PATCH /habits/read'])
  })

  it('moves the habit in the calendar', async () => {
    habits[0] = habit({
      id: 'read',
      title: 'Читать',
      placement: { time: '07:30', duration_minutes: 20 },
    })
    const user = userEvent.setup()
    renderAt('/habits/read')
    await user.click(await screen.findByRole('button', { name: 'Изменить' }))
    const dialog = await screen.findByRole('dialog', { name: 'Привычка' })
    const minutes = within(dialog).getByRole('textbox', { name: 'Минут' })
    await user.clear(minutes)
    await user.type(minutes, '45')
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }))
    await waitFor(() => expect(calls('PUT', /placement$/)).toHaveLength(1))
    expect(calls('PUT', /placement$/)[0]!.body).toEqual({ time: '07:30', duration_minutes: 45 })
    expect(calls('PATCH', /habits\/read$/)).toHaveLength(0)
  })
})
