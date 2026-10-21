// @vitest-environment jsdom
import { json, net, noContent, type StubRequest } from '@/test/fetchStub'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAuthStore } from '@/api/authStore'
import { setupApi } from '@/api/setup'
import type { Category, Instance, Series, User } from '@/api/types'
import { App } from '@/app/App'
import { createBrowserPlatform } from '@/platform/browser'
import { PlatformContext } from '@/platform/context'
import { useCalendarStore } from './calendarStore'

// Wednesday 2026-10-14, 12:00 in Moscow.
const NOW = new Date('2026-10-14T09:00:00Z')

let user: User
let instances: Instance[]
let categories: Category[]
let nextId: number
let series: Record<string, Series>

const task = (
  id: string,
  title: string,
  start: string,
  end: string,
  categoryIds: string[] = [],
  seriesId: string | null = null,
): Instance => ({
  id,
  title,
  description: '',
  planned_start: start,
  planned_end: end,
  actual_start: null,
  actual_end: null,
  status: 'planned',
  comment: '',
  category_ids: categoryIds,
  series_id: seriesId,
  habit_id: null,
  rescheduled_from: null,
  rescheduled_to: null,
  deviations: [],
})

const category = (id: string, name: string, color: string): Category => ({
  id,
  name,
  color,
  parent_id: null,
  archived_at: null,
})

function server(req: StubRequest): Response {
  if (req.path === '/auth/dev') {
    return json(200, { token: 't', expires_at: '2030-01-01T00:00:00Z', user })
  }
  const body = (req.body ?? {}) as Partial<Instance>
  if (req.method === 'POST' && req.path === '/instances/unplanned') {
    const b = req.body as {
      title: string
      category_ids?: string[]
      actual_start?: string
      actual_end?: string
    }
    const created = {
      ...task(`u${nextId++}`, b.title, '', ''),
      planned_start: null,
      planned_end: null,
      actual_start: b.actual_start ?? NOW.toISOString(),
      actual_end: b.actual_end ?? null,
      status: b.actual_end ? ('done' as const) : ('in_progress' as const),
      category_ids: b.category_ids ?? [],
    }
    instances.push(created)
    return json(201, created)
  }
  const trackingMatch = /^\/instances\/([^/]+)\/(complete|start|stop|tracking|reschedule)$/.exec(
    req.path,
  )
  if (trackingMatch) {
    const target = instances.find((i) => i.id === trackingMatch[1])
    if (!target) return json(404, { code: 'not_found', message: 'nf' })
    switch (trackingMatch[2]) {
      case 'complete':
        Object.assign(target, {
          status: 'done',
          actual_start: target.planned_start,
          actual_end: target.planned_end,
        })
        return json(200, target)
      case 'start':
        Object.assign(target, {
          status: 'in_progress',
          actual_start: NOW.toISOString(),
          actual_end: null,
        })
        return json(200, target)
      case 'stop':
        Object.assign(target, { status: 'done', actual_end: NOW.toISOString() })
        return json(200, target)
      case 'tracking': {
        const patch = req.body as Partial<Instance>
        if (patch.status === 'planned')
          Object.assign(target, { status: 'planned', actual_start: null, actual_end: null })
        else Object.assign(target, patch)
        return json(200, target)
      }
      case 'reschedule': {
        const b = req.body as { planned_start: string; planned_end: string; comment?: string }
        const moved = {
          ...task(`m${nextId++}`, target.title, b.planned_start, b.planned_end),
          rescheduled_from: {
            id: target.id,
            planned_start: target.planned_start!,
            planned_end: target.planned_end!,
          },
        }
        Object.assign(target, {
          status: 'rescheduled',
          comment: b.comment ?? '',
          rescheduled_to: {
            id: moved.id,
            planned_start: b.planned_start,
            planned_end: b.planned_end,
          },
        })
        instances.push(moved)
        return json(201, moved)
      }
    }
  }
  const seriesMatch = /^\/series\/([^/]+)$/.exec(req.path)
  if (req.method === 'GET' && seriesMatch) {
    const found = series[seriesMatch[1]!]
    return found ? json(200, found) : json(404, { code: 'not_found', message: 'nf' })
  }
  const match = /^\/instances\/([^/]+)$/.exec(req.path)
  const target = match ? instances.find((i) => i.id === match[1]) : undefined

  if (req.method === 'GET' && req.path === '/categories') return json(200, categories)
  if (req.method === 'GET' && req.path === '/instances') {
    const from = new Date(req.query.get('from')!).getTime()
    const to = new Date(req.query.get('to')!).getTime()
    return json(
      200,
      instances.filter((i) => {
        // Like the server: the plan or the fact (a running timer lasts until now) overlaps the window.
        const plan = i.planned_start
          ? new Date(i.planned_start).getTime() < to && new Date(i.planned_end!).getTime() > from
          : false
        const fact = i.actual_start
          ? new Date(i.actual_start).getTime() < to &&
            (i.actual_end ? new Date(i.actual_end) : NOW).getTime() > from
          : false
        return plan || fact
      }),
    )
  }
  if (req.method === 'POST' && req.path === '/tasks') {
    const created = { ...task(`n${nextId++}`, '', '', ''), ...body, status: 'planned' as const }
    created.category_ids ??= []
    instances.push(created as Instance)
    return json(201, created)
  }
  if (!match || !target) return json(404, { code: 'not_found', message: 'not found' })
  if (req.method === 'PATCH') {
    const scope = req.query.get('scope') ?? 'this'
    if (scope !== 'this') return new Response(null, { status: 204 })
    return json(200, Object.assign(target, body))
  }
  if (req.method === 'DELETE') {
    instances = instances.filter((i) => i !== target)
    return noContent()
  }
  return json(404, { code: 'not_found', message: 'not found' })
}

const platform = createBrowserPlatform()

function renderCalendar() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <PlatformContext.Provider value={platform}>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/']}>
          <App />
        </MemoryRouter>
      </QueryClientProvider>
    </PlatformContext.Provider>,
  )
}

const instanceRequests = () =>
  net.calls.filter((c) => c.method === 'GET' && c.path === '/instances')
const lastRange = () => {
  const q = instanceRequests().at(-1)!.query
  return [q.get('from'), q.get('to')]
}
const mutations = () => net.calls.filter((c) => c.method !== 'GET' && c.path !== '/auth/dev')
const column = (day: string) => document.querySelector(`[data-day="${day}"]`) as HTMLElement
const dialog = () => screen.findByRole('dialog')

beforeAll(() => {
  window.matchMedia = (() => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia
  setupApi(platform)
})

beforeEach(() => {
  // Freeze only Date, so that testing-library's polling keeps working.
  vi.useFakeTimers({ toFake: ['Date'], now: NOW })
  user = {
    id: 'u1',
    display_name: 'Ann',
    timezone: 'Europe/Moscow',
    slot_minutes: 30,
    default_view: 'day',
    deviation_threshold_minutes: 10,
  }
  instances = []
  categories = []
  nextId = 1
  series = {}
  net.calls.length = 0
  net.handler = server
  useAuthStore.getState().setToken(null)
  useCalendarStore.setState({ view: null, anchor: null, mode: 'both' })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('calendar', () => {
  it('asks for the visible day in the user time zone', async () => {
    renderCalendar()
    await screen.findByRole('radio', { name: 'День' })
    await vi.waitFor(() => expect(instanceRequests()).toHaveLength(1))
    // Moscow midnight is 21:00 UTC of the day before.
    expect(lastRange()).toEqual(['2026-10-13T21:00:00.000Z', '2026-10-14T21:00:00.000Z'])
    expect(column('2026-10-14')).toBeTruthy()
  })

  it('shows a task in its day column with the category color', async () => {
    categories = [category('c1', 'Спорт', '#ef4444')]
    instances = [task('t1', 'Бег', '2026-10-14T07:00:00Z', '2026-10-14T08:00:00Z', ['c1'])]
    renderCalendar()

    const block = await screen.findByRole('button', { name: 'Бег, 10:00–11:00' })
    expect(column('2026-10-14').contains(block)).toBe(true)
    await vi.waitFor(() => expect(block.style.borderLeft).toContain('rgb(239, 68, 68)'))
    // 10:00 with 28px per 30-minute slot.
    expect(block.style.top).toBe(`${(600 * 28) / 30}px`)
  })

  it('switches between day, three-day and week views', async () => {
    const ui = userEvent.setup()
    renderCalendar()
    await screen.findByRole('radio', { name: 'День' })

    await ui.click(screen.getByRole('radio', { name: '3 дня' }))
    expect(document.querySelectorAll('[data-day]')).toHaveLength(3)
    expect(
      [...document.querySelectorAll('[data-day]')].map((c) => c.getAttribute('data-day')),
    ).toEqual(['2026-10-13', '2026-10-14', '2026-10-15'])

    await ui.click(screen.getByRole('radio', { name: 'Неделя' }))
    const days = [...document.querySelectorAll('[data-day]')].map((c) => c.getAttribute('data-day'))
    expect(days).toEqual([
      '2026-10-12',
      '2026-10-13',
      '2026-10-14',
      '2026-10-15',
      '2026-10-16',
      '2026-10-17',
      '2026-10-18',
    ])
    await vi.waitFor(() =>
      expect(lastRange()).toEqual(['2026-10-11T21:00:00.000Z', '2026-10-18T21:00:00.000Z']),
    )
  })

  it('starts in the default view from the settings', async () => {
    user.default_view = 'week'
    renderCalendar()
    expect(await screen.findByRole('radio', { name: 'Неделя' })).toBeTruthy()
    await vi.waitFor(() => expect(document.querySelectorAll('[data-day]')).toHaveLength(7))
  })

  it('navigates by the length of the view and returns to today', async () => {
    const ui = userEvent.setup()
    renderCalendar()
    await screen.findByRole('radio', { name: 'День' })

    await ui.click(screen.getByRole('button', { name: 'Вперёд' }))
    expect(column('2026-10-15')).toBeTruthy()
    await ui.click(screen.getByRole('button', { name: 'Назад' }))
    await ui.click(screen.getByRole('button', { name: 'Назад' }))
    expect(column('2026-10-13')).toBeTruthy()

    await ui.click(screen.getByRole('button', { name: 'Сегодня' }))
    expect(column('2026-10-14')).toBeTruthy()

    await ui.click(screen.getByRole('radio', { name: 'Неделя' }))
    await ui.click(screen.getByRole('button', { name: 'Вперёд' }))
    expect(column('2026-10-19')).toBeTruthy()
  })

  it('opens a single day from a column header', async () => {
    const ui = userEvent.setup()
    renderCalendar()
    await ui.click(await screen.findByRole('radio', { name: 'Неделя' }))
    await ui.click(screen.getByRole('button', { name: 'Открыть день 2026-10-16' }))

    expect(document.querySelectorAll('[data-day]')).toHaveLength(1)
    expect(column('2026-10-16')).toBeTruthy()
    expect(screen.getByRole('radio', { name: 'День' }).getAttribute('aria-checked')).toBe('true')
  })

  it('draws the current time only in today’s column', async () => {
    const ui = userEvent.setup()
    renderCalendar()
    await ui.click(await screen.findByRole('radio', { name: 'Неделя' }))

    const lines = document.querySelectorAll('[data-now-line]')
    expect(lines).toHaveLength(1)
    expect(column('2026-10-14').contains(lines[0]!)).toBe(true)
    // 12:00 → 720 minutes.
    expect((lines[0] as HTMLElement).style.top).toBe(`${(720 * 28) / 30}px`)

    await ui.click(screen.getByRole('button', { name: 'Вперёд' }))
    expect(document.querySelectorAll('[data-now-line]')).toHaveLength(0)
  })

  it('shows a task across midnight on both days, joined at the edge', async () => {
    const ui = userEvent.setup()
    instances = [task('t1', 'Ночная смена', '2026-10-14T19:00:00Z', '2026-10-15T03:00:00Z')] // 22:00–06:00 Moscow
    renderCalendar()
    await ui.click(await screen.findByRole('radio', { name: '3 дня' }))

    const first = await within(column('2026-10-14')).findByRole('button', { name: /Ночная смена/ })
    const second = await within(column('2026-10-15')).findByRole('button', { name: /Ночная смена/ })
    expect(first.getAttribute('aria-label')).toBe('Ночная смена, 22:00–24:00')
    expect(second.getAttribute('aria-label')).toBe('Ночная смена, 00:00–06:00')
    // Square corners where the task continues.
    expect(first.style.borderBottomLeftRadius).toBe('0px')
    expect(second.style.borderTopLeftRadius).toBe('0px')
    expect(within(column('2026-10-13')).queryByRole('button')).toBeNull()
  })

  it('places overlapping tasks side by side and gives each a share of the width', async () => {
    instances = [
      task('a', 'Первое', '2026-10-14T07:00:00Z', '2026-10-14T09:00:00Z'),
      task('b', 'Второе', '2026-10-14T08:00:00Z', '2026-10-14T10:00:00Z'),
      task('c', 'Третье', '2026-10-14T11:00:00Z', '2026-10-14T12:00:00Z'),
    ]
    renderCalendar()

    const a = await screen.findByRole('button', { name: /Первое/ })
    const b = screen.getByRole('button', { name: /Второе/ })
    const c = screen.getByRole('button', { name: /Третье/ })
    expect(a.style.width).toContain('50%')
    expect(b.style.width).toContain('50%')
    expect(a.style.left).toContain('0%')
    expect(b.style.left).toContain('50%')
    expect(c.style.width).toContain('100%')
  })

  it('adds a fact, not a plan, with the "+" button when the grid shows the fact', async () => {
    useCalendarStore.setState({ view: null, anchor: null, mode: 'fact' })
    const ui = userEvent.setup()
    renderCalendar()
    await ui.click(await screen.findByRole('button', { name: 'Новое дело в факте' }))
    const form = within(await dialog())
    expect(screen.getByRole('dialog', { name: 'Дело вне плана' })).toBeTruthy()
    expect(form.getByText(/попадёт в факт/)).toBeTruthy()
    // Back-dated from the start: the last half hour is ready.
    expect((form.getByLabelText('Началось') as HTMLInputElement).value).toBe('2026-10-14T11:30')
    expect((form.getByLabelText('Закончилось') as HTMLInputElement).value).toBe('2026-10-14T12:00')
  })

  it('keeps the plan form for the "+" button when the grid shows the plan', async () => {
    const ui = userEvent.setup()
    renderCalendar()
    await ui.click(await screen.findByRole('button', { name: 'Новое дело' }))
    expect(screen.getByRole('dialog', { name: 'Новое дело' })).toBeTruthy()
  })

  it('closes a sheet with its own button', async () => {
    const ui = userEvent.setup()
    renderCalendar()
    await ui.click(await screen.findByRole('button', { name: 'Новое дело' }))
    await ui.click(within(await dialog()).getByRole('button', { name: 'Закрыть' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('creates a task with the "+" button, converting the time to UTC', async () => {
    const ui = userEvent.setup()
    renderCalendar()
    await ui.click(await screen.findByRole('button', { name: 'Новое дело' }))

    const form = within(await dialog())
    // Now is 12:00 → the next 30-minute boundary is 12:00 itself, one hour long.
    expect((form.getByLabelText('Начало') as HTMLInputElement).value).toBe('2026-10-14T12:00')
    expect((form.getByLabelText('Конец') as HTMLInputElement).value).toBe('2026-10-14T13:00')

    const save = form.getByRole('button', { name: 'Создать' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    await ui.type(form.getByLabelText('Название'), '  Обед ')
    await ui.click(save)

    expect(await screen.findByRole('button', { name: 'Обед, 12:00–13:00' })).toBeTruthy()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(mutations()).toMatchObject([
      {
        method: 'POST',
        path: '/tasks',
        body: {
          title: 'Обед',
          planned_start: '2026-10-14T09:00:00.000Z',
          planned_end: '2026-10-14T10:00:00.000Z',
          category_ids: [],
        },
      },
    ])
  })

  it('refuses an end before the start', async () => {
    const ui = userEvent.setup()
    renderCalendar()
    await ui.click(await screen.findByRole('button', { name: 'Новое дело' }))
    const form = within(await dialog())

    await ui.type(form.getByLabelText('Название'), 'X')
    const end = form.getByLabelText('Конец')
    await ui.clear(end)
    await ui.type(end, '2026-10-14T11:00')

    expect(form.getByText('Конец должен быть позже начала')).toBeTruthy()
    expect((form.getByRole('button', { name: 'Создать' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('picks categories from the tree in the full form', async () => {
    categories = [category('c1', 'Спорт', '#ef4444'), category('c2', 'Работа', '#3b82f6')]
    const ui = userEvent.setup()
    renderCalendar()
    await ui.click(await screen.findByRole('button', { name: 'Новое дело' }))
    const form = within(await dialog())

    await ui.type(form.getByLabelText('Название'), 'Зал')
    await ui.click(await form.findByRole('checkbox', { name: /Спорт/ }))
    await ui.click(form.getByRole('button', { name: 'Создать' }))

    await screen.findByRole('button', { name: /Зал/ })
    expect(mutations()[0]?.body).toMatchObject({ title: 'Зал', category_ids: ['c1'] })
  })

  it('edits only the changed fields', async () => {
    instances = [task('t1', 'Бег', '2026-10-14T07:00:00Z', '2026-10-14T08:00:00Z')]
    const ui = userEvent.setup()
    renderCalendar()

    await ui.click(await screen.findByRole('button', { name: /Бег/ }))
    const form = within(await dialog())
    expect((form.getByLabelText('Начало') as HTMLInputElement).value).toBe('2026-10-14T10:00')
    const save = form.getByRole('button', { name: 'Сохранить' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)

    await ui.clear(form.getByLabelText('Название'))
    await ui.type(form.getByLabelText('Название'), 'Пробежка')
    await ui.click(save)

    await screen.findByRole('button', { name: /Пробежка/ })
    expect(mutations()).toMatchObject([
      { method: 'PATCH', path: '/instances/t1', body: { title: 'Пробежка' } },
    ])
    expect(Object.keys(mutations()[0]!.body as object)).toEqual(['title'])
  })

  it('deletes only after confirmation', async () => {
    instances = [task('t1', 'Бег', '2026-10-14T07:00:00Z', '2026-10-14T08:00:00Z')]
    const ui = userEvent.setup()
    renderCalendar()

    await ui.click(await screen.findByRole('button', { name: /Бег/ }))
    await ui.click(within(await dialog()).getByRole('button', { name: 'Удалить' }))

    const confirm = within(await screen.findByRole('dialog', { name: 'Удалить дело?' }))
    expect(confirm.getByText(/Дело «Бег» будет удалено/)).toBeTruthy()
    expect(mutations()).toEqual([])

    await ui.click(confirm.getByRole('button', { name: 'Отмена' }))
    expect(mutations()).toEqual([])
    expect(screen.getByRole('dialog', { name: 'Дело' })).toBeTruthy()

    await ui.click(
      within(screen.getByRole('dialog', { name: 'Дело' })).getByRole('button', { name: 'Удалить' }),
    )
    await ui.click(
      within(await screen.findByRole('dialog', { name: 'Удалить дело?' })).getByRole('button', {
        name: 'Удалить',
      }),
    )

    await vi.waitFor(() => expect(screen.queryByRole('button', { name: /Бег/ })).toBeNull())
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(mutations()).toMatchObject([{ method: 'DELETE', path: '/instances/t1' }])
  })

  it('closes the edit dialog when the task is deleted elsewhere', async () => {
    instances = [task('t1', 'Бег', '2026-10-14T07:00:00Z', '2026-10-14T08:00:00Z')]
    const ui = userEvent.setup()
    renderCalendar()
    await ui.click(await screen.findByRole('button', { name: /Бег/ }))
    await dialog()

    instances = []
    await ui.click(screen.getByRole('radio', { name: '3 дня' })) // forces a new request
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('shows an error with a retry when the tasks cannot be loaded', async () => {
    net.handler = (req) => (req.path === '/instances' ? json(500, {}) : server(req))
    renderCalendar()
    expect((await screen.findByRole('alert')).textContent).toMatch(/Не удалось загрузить дела/)
    expect(screen.getByRole('button', { name: 'Повторить' })).toBeTruthy()
  })

  it('jumps to a picked date, keeping the view', async () => {
    const ui = userEvent.setup()
    renderCalendar()
    await ui.click(await screen.findByRole('radio', { name: 'Неделя' }))

    const picker = screen.getByLabelText('Выбрать дату') as HTMLInputElement
    expect(picker.value).toBe('2026-10-14')
    fireEvent.change(picker, { target: { value: '2027-02-10' } })

    expect(column('2027-02-08')).toBeTruthy() // Monday of that week
    expect(column('2027-02-14')).toBeTruthy()
    expect(document.querySelectorAll('[data-day]')).toHaveLength(7)
    // A date in another year shows the year in the title.
    expect(screen.getByRole('heading', { level: 1 }).textContent).toMatch(/2027/)
    await vi.waitFor(() =>
      expect(lastRange()).toEqual(['2027-02-07T21:00:00.000Z', '2027-02-14T21:00:00.000Z']),
    )
  })

  it('ignores a cleared date', async () => {
    renderCalendar()
    const picker = (await screen.findByLabelText('Выбрать дату')) as HTMLInputElement
    fireEvent.change(picker, { target: { value: '' } })
    expect(column('2026-10-14')).toBeTruthy()
  })

  it('closes the menu on Escape and on a tap elsewhere', async () => {
    const ui = userEvent.setup()
    renderCalendar()
    const menu = await screen.findByRole('button', { name: 'Меню' })

    await ui.click(menu)
    expect(screen.getByRole('link', { name: 'Настройки' })).toBeTruthy()
    await ui.keyboard('{Escape}')
    expect(screen.queryByRole('link', { name: 'Настройки' })).toBeNull()

    await ui.click(menu)
    expect(screen.getByRole('link', { name: 'Категории' })).toBeTruthy()
    await ui.click(screen.getByRole('heading', { level: 1 }))
    expect(screen.queryByRole('link', { name: 'Категории' })).toBeNull()
  })

  it('tells why the create button is disabled when the title is missing', async () => {
    const ui = userEvent.setup()
    renderCalendar()
    await ui.click(await screen.findByRole('button', { name: 'Новое дело' }))
    const form = within(await dialog())

    expect(form.getByText('Введите название')).toBeTruthy()
    await ui.type(form.getByLabelText('Название'), 'x')
    expect(form.queryByText('Введите название')).toBeNull()
  })

  it('refuses a mistyped year', async () => {
    const ui = userEvent.setup()
    renderCalendar()
    await ui.click(await screen.findByRole('button', { name: 'Новое дело' }))
    const form = within(await dialog())

    await ui.type(form.getByLabelText('Название'), 'x')
    fireEvent.change(form.getByLabelText('Начало'), { target: { value: '0026-10-14T12:00' } })
    // Browsers hand over "0026-…"; jsdom blanks such a value. Either way the form refuses it
    // (the year check itself is covered in taskDraft.test.ts).
    expect(form.getByText(/Проверьте год|Укажите дату и время начала/)).toBeTruthy()
    expect((form.getByRole('button', { name: 'Создать' }) as HTMLButtonElement).disabled).toBe(true)
  })

  describe('regular tasks', () => {
    const weeklySeries: Series = {
      id: 's1',
      title: 'Планёрка',
      description: '',
      rrule: 'FREQ=WEEKLY;BYDAY=WE',
      start_local: '2026-10-14T09:00',
      timezone: 'Europe/Moscow',
      duration_minutes: 60,
      category_ids: [],
    }
    const occurrence = () =>
      task('t1', 'Планёрка', '2026-10-14T06:00:00Z', '2026-10-14T07:00:00Z', [], 's1')

    beforeEach(() => {
      series = { s1: { ...weeklySeries } }
      instances = [occurrence()]
    })

    it('marks occurrences of a series in the grid', async () => {
      instances.push(task('t2', 'Разовое', '2026-10-14T10:00:00Z', '2026-10-14T11:00:00Z'))
      renderCalendar()
      const repeated = await screen.findByRole('button', { name: /Планёрка/ })
      expect(repeated.querySelector('[data-repeat]')).toBeTruthy()
      expect(
        screen.getByRole('button', { name: /Разовое/ }).querySelector('[data-repeat]'),
      ).toBeNull()
    })

    it('creates a weekly task with the repeat editor', async () => {
      const ui = userEvent.setup()
      renderCalendar()
      await ui.click(await screen.findByRole('button', { name: 'Новое дело' }))
      const form = within(await dialog())

      await ui.type(form.getByLabelText('Название'), 'Зал')
      await ui.selectOptions(form.getByLabelText('Повтор'), 'weekly')
      // The weekday of the start date (Wednesday) is selected for a start.
      expect(form.getByRole('button', { name: 'ср' }).getAttribute('aria-pressed')).toBe('true')
      await ui.click(form.getByRole('button', { name: 'пн' }))
      expect(form.getByTestId('repeat-summary').textContent).toBe('Еженедельно: пн, ср')
      await ui.click(form.getByRole('button', { name: 'Создать' }))

      await vi.waitFor(() => expect(mutations()).toHaveLength(1))
      expect(mutations()[0]).toMatchObject({
        method: 'POST',
        path: '/tasks',
        body: { title: 'Зал', recurrence: { rrule: 'FREQ=WEEKLY;BYDAY=MO,WE' } },
      })
    })

    it('asks what to apply an edit to, and sends the chosen scope', async () => {
      const ui = userEvent.setup()
      renderCalendar()
      await ui.click(await screen.findByRole('button', { name: /Планёрка/ }))
      const form = within(await dialog())
      // The rule of the series is shown in the editor.
      expect(((await form.findByLabelText('Повтор')) as HTMLSelectElement).value).toBe('weekly')

      await ui.clear(form.getByLabelText('Название'))
      await ui.type(form.getByLabelText('Название'), 'Стендап')
      await ui.click(form.getByRole('button', { name: 'Сохранить' }))

      const scope = within(await screen.findByRole('dialog', { name: 'Применить изменения' }))
      expect(mutations()).toEqual([])
      await ui.click(scope.getByRole('button', { name: 'Все дела серии' }))

      await vi.waitFor(() => expect(mutations()).toHaveLength(1))
      expect(mutations()[0]).toMatchObject({
        method: 'PATCH',
        path: '/instances/t1',
        body: { title: 'Стендап' },
      })
      expect(mutations()[0]?.query.get('scope')).toBe('all')
      await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    })

    it.each([
      ['Только это дело', 'this'],
      ['Это и следующие', 'following'],
    ])('sends scope %s as %s', async (label, want) => {
      const ui = userEvent.setup()
      renderCalendar()
      await ui.click(await screen.findByRole('button', { name: /Планёрка/ }))
      const form = within(await dialog())
      await form.findByLabelText('Повтор')
      await ui.clear(form.getByLabelText('Название'))
      await ui.type(form.getByLabelText('Название'), 'Стендап')
      await ui.click(form.getByRole('button', { name: 'Сохранить' }))
      await ui.click(
        within(await screen.findByRole('dialog', { name: 'Применить изменения' })).getByRole(
          'button',
          { name: label },
        ),
      )

      await vi.waitFor(() => expect(mutations()).toHaveLength(1))
      expect(mutations()[0]?.query.get('scope')).toBe(want)
    })

    it('does not allow changing the rule for one occurrence only', async () => {
      const ui = userEvent.setup()
      renderCalendar()
      await ui.click(await screen.findByRole('button', { name: /Планёрка/ }))
      const form = within(await dialog())
      await ui.selectOptions(await form.findByLabelText('Повтор'), 'daily')
      await ui.click(form.getByRole('button', { name: 'Сохранить' }))

      const scope = within(await screen.findByRole('dialog', { name: 'Применить изменения' }))
      expect(
        (scope.getByRole('button', { name: 'Только это дело' }) as HTMLButtonElement).disabled,
      ).toBe(true)
      await ui.click(scope.getByRole('button', { name: 'Это и следующие' }))

      await vi.waitFor(() => expect(mutations()).toHaveLength(1))
      expect(mutations()[0]).toMatchObject({ body: { recurrence: { rrule: 'FREQ=DAILY' } } })
      expect(mutations()[0]?.query.get('scope')).toBe('following')
    })

    it('does not allow moving the date for the series', async () => {
      const ui = userEvent.setup()
      renderCalendar()
      await ui.click(await screen.findByRole('button', { name: /Планёрка/ }))
      const form = within(await dialog())
      await form.findByLabelText('Повтор')
      // End first: while the end is before the start its label also holds an error message.
      fireEvent.change(form.getByLabelText('Конец'), { target: { value: '2026-10-15T10:00' } })
      fireEvent.change(form.getByLabelText('Начало'), { target: { value: '2026-10-15T09:00' } })
      await ui.click(form.getByRole('button', { name: 'Сохранить' }))

      const scope = within(await screen.findByRole('dialog', { name: 'Применить изменения' }))
      expect(
        (scope.getByRole('button', { name: 'Это и следующие' }) as HTMLButtonElement).disabled,
      ).toBe(true)
      expect(
        (scope.getByRole('button', { name: 'Все дела серии' }) as HTMLButtonElement).disabled,
      ).toBe(true)
      expect(
        (scope.getByRole('button', { name: 'Только это дело' }) as HTMLButtonElement).disabled,
      ).toBe(false)
    })

    it('refuses to change the date and the rule together, saying why', async () => {
      const ui = userEvent.setup()
      renderCalendar()
      await ui.click(await screen.findByRole('button', { name: /Планёрка/ }))
      const form = within(await dialog())
      await ui.selectOptions(await form.findByLabelText('Повтор'), 'daily')
      fireEvent.change(form.getByLabelText('Конец'), { target: { value: '2026-10-15T10:00' } })
      fireEvent.change(form.getByLabelText('Начало'), { target: { value: '2026-10-15T09:00' } })

      expect(form.getByText(/Нельзя менять дату и правило повтора одновременно/)).toBeTruthy()
      expect((form.getByRole('button', { name: 'Сохранить' }) as HTMLButtonElement).disabled).toBe(
        true,
      )
    })

    it('shows the server explanation when a series edit is refused', async () => {
      const ui = userEvent.setup()
      renderCalendar()
      await ui.click(await screen.findByRole('button', { name: /Планёрка/ }))
      const form = within(await dialog())
      await form.findByLabelText('Повтор')
      await ui.clear(form.getByLabelText('Название'))
      await ui.type(form.getByLabelText('Название'), 'Стендап')
      await ui.click(form.getByRole('button', { name: 'Сохранить' }))
      net.handler = (req) =>
        req.method === 'PATCH'
          ? json(400, { code: 'no_occurrences', message: 'x', field: 'recurrence' })
          : server(req)
      await ui.click(
        within(await screen.findByRole('dialog', { name: 'Применить изменения' })).getByRole(
          'button',
          { name: 'Все дела серии' },
        ),
      )

      expect((await screen.findByRole('alert')).textContent).toMatch(/нет ни одного повтора/)
      expect(screen.getByRole('dialog', { name: 'Применить изменения' })).toBeTruthy()
    })

    it('asks the scope when deleting an occurrence', async () => {
      const ui = userEvent.setup()
      renderCalendar()
      await ui.click(await screen.findByRole('button', { name: /Планёрка/ }))
      await ui.click(within(await dialog()).getByRole('button', { name: 'Удалить' }))

      const scope = within(
        await screen.findByRole('dialog', { name: 'Удалить повторяющееся дело' }),
      )
      expect(mutations()).toEqual([])
      await ui.click(scope.getByRole('button', { name: 'Это и следующие' }))

      await vi.waitFor(() => expect(mutations()).toHaveLength(1))
      expect(mutations()[0]).toMatchObject({ method: 'DELETE', path: '/instances/t1' })
      expect(mutations()[0]?.query.get('scope')).toBe('following')
    })

    it('keeps the plain confirmation for a one-off task and has no repeat editor there', async () => {
      instances = [task('t9', 'Разовое', '2026-10-14T10:00:00Z', '2026-10-14T11:00:00Z')]
      const ui = userEvent.setup()
      renderCalendar()
      await ui.click(await screen.findByRole('button', { name: /Разовое/ }))
      const form = within(await dialog())
      expect(form.queryByLabelText('Повтор')).toBeNull()

      await ui.click(form.getByRole('button', { name: 'Удалить' }))
      expect(await screen.findByRole('dialog', { name: 'Удалить дело?' })).toBeTruthy()
      expect(screen.queryByRole('dialog', { name: 'Удалить повторяющееся дело' })).toBeNull()
    })

    it('closes the dialog when the occurrence disappears after the series was rewritten', async () => {
      const ui = userEvent.setup()
      renderCalendar()
      await ui.click(await screen.findByRole('button', { name: /Планёрка/ }))
      await dialog()

      // Another device rewrote the series: the occurrence is re-created with a new id.
      instances = [{ ...occurrence(), id: 'new-id' }]
      await ui.click(screen.getByRole('radio', { name: '3 дня' }))
      await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    })
  })

  describe('tracking', () => {
    // 12:00 in Moscow. The plan below (09:00-10:00) is in the past.
    const past = (id: string, over: Partial<Instance> = {}): Instance => ({
      ...task(id, 'Спорт', '2026-10-14T06:00:00Z', '2026-10-14T07:00:00Z'),
      ...over,
    })
    const doneLate = (id: string): Instance =>
      past(id, {
        status: 'done',
        actual_start: '2026-10-14T06:20:00Z',
        actual_end: '2026-10-14T07:30:00Z',
        deviations: [
          { kind: 'started_late', minutes: 20 },
          { kind: 'finished_late', minutes: 30 },
        ],
      })
    const unplanned = (): Instance => ({
      ...task('free', 'Звонок', '', ''),
      planned_start: null,
      planned_end: null,
      status: 'done',
      actual_start: '2026-10-14T05:00:00Z',
      actual_end: '2026-10-14T05:30:00Z',
    })
    const blocksOf = (kind?: string) =>
      [...document.querySelectorAll('[data-task]')].filter(
        (b) => !kind || b.getAttribute('data-kind') === kind,
      )

    it('offers plan, fact and both for a day, and the plan and fact only for a week', async () => {
      const ui = userEvent.setup()
      renderCalendar()
      const modes = async () =>
        within(await screen.findByRole('radiogroup', { name: 'Что показывать' }))
          .getAllByRole('radio')
          .map((r) => r.textContent)
      expect(await modes()).toEqual(['План', 'Факт', 'Оба'])
      await ui.click(screen.getByRole('radio', { name: '3 дня' }))
      expect(await modes()).toEqual(['План', 'Факт', 'Оба'])
      await ui.click(screen.getByRole('radio', { name: 'Неделя' }))
      expect(await modes()).toEqual(['План', 'Факт'])
    })

    it('falls back to the plan in a week and remembers "both" for the other views', async () => {
      const ui = userEvent.setup()
      renderCalendar()
      const group = async () =>
        within(await screen.findByRole('radiogroup', { name: 'Что показывать' }))
      expect((await group()).getByRole('radio', { name: 'Оба' }).getAttribute('aria-checked')).toBe(
        'true',
      )

      await ui.click(screen.getByRole('radio', { name: 'Неделя' }))
      expect(
        (await group()).getByRole('radio', { name: 'План' }).getAttribute('aria-checked'),
      ).toBe('true')

      await ui.click(screen.getByRole('radio', { name: 'День' }))
      expect((await group()).getByRole('radio', { name: 'Оба' }).getAttribute('aria-checked')).toBe(
        'true',
      )
    })

    it('draws the plan with the fact as a stripe in "both", by default', async () => {
      instances = [doneLate('t1'), unplanned()]
      renderCalendar()
      await screen.findByRole('button', { name: /Спорт/ })

      const plan = blocksOf('plan')
      expect(plan).toHaveLength(1)
      expect(document.querySelector('[data-fact-stripe="t1"]')).toBeTruthy()
      // The task outside the plan is drawn by its fact, hatched.
      expect(blocksOf('unplanned')).toHaveLength(1)
      expect((blocksOf('unplanned')[0] as HTMLElement).style.background).toContain(
        'repeating-linear-gradient',
      )
    })

    it('"Plan" hides the fact and the unplanned tasks; "Fact" draws by the fact', async () => {
      const ui = userEvent.setup()
      instances = [doneLate('t1'), unplanned()]
      renderCalendar()
      await screen.findByRole('button', { name: /Спорт/ })

      await ui.click(screen.getByRole('radio', { name: 'План' }))
      expect(blocksOf().map((b) => b.getAttribute('data-kind'))).toEqual(['plan'])
      expect(document.querySelector('[data-fact-stripe]')).toBeNull()

      await ui.click(screen.getByRole('radio', { name: 'Факт' }))
      expect(
        blocksOf()
          .map((b) => b.getAttribute('data-kind'))
          .sort(),
      ).toEqual(['fact', 'unplanned'])
      expect(document.querySelector('[data-fact-stripe]')).toBeNull()
      // The fact block starts at 09:20 (06:20 UTC), not at the planned 09:00.
      const factBlock = blocksOf('fact')[0] as HTMLElement
      expect(factBlock.style.top).toBe(`${(560 * 28) / 30}px`)
      expect(factBlock.getAttribute('aria-label')).toContain('09:20–10:30')
    })

    it('marks statuses, a rescheduled original and a past task nobody marked', async () => {
      instances = [
        doneLate('d'),
        past('n', {
          title: 'Забыл',
          planned_start: '2026-10-14T03:00:00Z',
          planned_end: '2026-10-14T04:00:00Z',
        }),
        past('r', {
          title: 'Перенёс',
          status: 'rescheduled',
          planned_start: '2026-10-14T00:00:00Z',
          planned_end: '2026-10-14T01:00:00Z',
        }),
        task('f', 'Позже', '2026-10-14T15:00:00Z', '2026-10-14T16:00:00Z'),
      ]
      renderCalendar()
      await screen.findByRole('button', { name: /Забыл/ })

      const find = (title: string) => screen.getByRole('button', { name: new RegExp(title) })
      expect(find('Спорт').querySelector('[data-mark]')?.textContent).toBe('✓')
      expect(find('Забыл').getAttribute('data-unmarked')).toBe('true')
      expect(find('Забыл').querySelector('[data-unmarked-mark]')).toBeTruthy()
      expect(find('Перенёс').getAttribute('data-status')).toBe('rescheduled')
      expect(find('Перенёс').className).toContain('opacity-50')
      // A task that is still ahead is not "unmarked".
      expect(find('Позже').getAttribute('data-unmarked')).toBeNull()
    })

    it('marks a task done with one tap and closes the card', async () => {
      const ui = userEvent.setup()
      instances = [past('t1')]
      renderCalendar()
      await ui.click(await screen.findByRole('button', { name: /Спорт/ }))
      const card = within(await dialog())
      expect(card.getByTestId('status').textContent).toMatch(/Запланировано/)
      expect(card.getByText('не отмечено')).toBeTruthy()

      await ui.click(card.getByRole('button', { name: 'Выполнено' }))
      await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      expect(mutations()).toMatchObject([{ method: 'POST', path: '/instances/t1/complete' }])
      expect(await screen.findByRole('button', { name: /Спорт.*Выполнено/ })).toBeTruthy()
    })

    it('starts and stops a timer', async () => {
      const ui = userEvent.setup()
      instances = [past('t1')]
      renderCalendar()
      await ui.click(await screen.findByRole('button', { name: /Спорт/ }))
      await ui.click(within(await dialog()).getByRole('button', { name: 'Старт' }))
      await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

      await ui.click(await screen.findByRole('button', { name: /Спорт.*В процессе/ }))
      const card = within(await dialog())
      expect(card.getByTestId('fact').textContent).toMatch(/с 12:00, идёт/)
      expect(card.queryByRole('button', { name: 'Старт' })).toBeNull()
      await ui.click(card.getByRole('button', { name: 'Стоп' }))

      await vi.waitFor(() =>
        expect(mutations().map((m) => m.path)).toEqual([
          '/instances/t1/start',
          '/instances/t1/stop',
        ]),
      )
    })

    it('shows the plan, the fact and the deviations of a finished task', async () => {
      const ui = userEvent.setup()
      instances = [doneLate('t1')]
      renderCalendar()
      await ui.click(await screen.findByRole('button', { name: /Спорт/ }))
      const card = within(await dialog())

      expect(card.getByTestId('fact').textContent).toBe('09:20–10:30')
      expect(card.getByRole('list', { name: 'Отклонения' }).textContent).toContain(
        'Начали позже на 20 мин',
      )
      expect(card.getByRole('list', { name: 'Отклонения' }).textContent).toContain(
        'Закончили позже на 30 мин (затянулось)',
      )
      // A marked task cannot be completed again, but its mark can be removed.
      expect(card.queryByRole('button', { name: 'Выполнено' })).toBeNull()
      await ui.click(card.getByRole('button', { name: 'Снять отметку' }))
      await vi.waitFor(() => expect(mutations()).toHaveLength(1))
      expect(mutations()[0]).toMatchObject({
        method: 'PATCH',
        path: '/instances/t1/tracking',
        body: { status: 'planned' },
      })
    })

    it('edits the fact by hand, sending only what changed', async () => {
      const ui = userEvent.setup()
      instances = [doneLate('t1')]
      renderCalendar()
      await ui.click(await screen.findByRole('button', { name: /Спорт/ }))
      const card = within(await dialog())

      await ui.click(card.getByRole('button', { name: 'Править факт' }))
      expect((card.getByLabelText('Начало факта') as HTMLInputElement).value).toBe(
        '2026-10-14T09:20',
      )
      fireEvent.change(card.getByLabelText('Конец факта'), {
        target: { value: '2026-10-14T10:45' },
      })
      await ui.selectOptions(card.getByLabelText('Статус'), 'partial')
      await ui.click(card.getByRole('button', { name: 'Сохранить факт' }))

      await vi.waitFor(() => expect(mutations()).toHaveLength(1))
      expect(mutations()[0]?.body).toEqual({
        status: 'partial',
        actual_end: '2026-10-14T07:45:00.000Z',
      })
    })

    it('refuses a fact that ends before it starts', async () => {
      const ui = userEvent.setup()
      instances = [doneLate('t1')]
      renderCalendar()
      await ui.click(await screen.findByRole('button', { name: /Спорт/ }))
      const card = within(await dialog())
      await ui.click(card.getByRole('button', { name: 'Править факт' }))
      fireEvent.change(card.getByLabelText('Конец факта'), {
        target: { value: '2026-10-14T09:00' },
      })

      expect(card.getByText('Конец должен быть позже начала')).toBeTruthy()
      expect(
        (card.getByRole('button', { name: 'Сохранить факт' }) as HTMLButtonElement).disabled,
      ).toBe(true)
    })

    it('saves a comment on its own, without marking the task', async () => {
      const ui = userEvent.setup()
      instances = [past('t1')]
      renderCalendar()
      await ui.click(await screen.findByRole('button', { name: /Спорт/ }))
      const card = within(await dialog())

      const save = card.getByRole('button', { name: 'Сохранить комментарий' }) as HTMLButtonElement
      expect(save.disabled).toBe(true)
      await ui.type(card.getByLabelText(/Комментарий/), 'заболел')
      await ui.click(save)

      await vi.waitFor(() => expect(mutations()).toHaveLength(1))
      expect(mutations()[0]?.body).toEqual({ comment: 'заболел' })
    })

    it('reschedules with a suggested time and a reason, leaving a trail', async () => {
      const ui = userEvent.setup()
      instances = [past('t1')]
      renderCalendar()
      await ui.click(await screen.findByRole('button', { name: /Спорт/ }))
      await ui.click(within(await dialog()).getByRole('button', { name: 'Перенести' }))

      const form = within(await screen.findByRole('dialog', { name: 'Перенести дело' }))
      // The same time the next day.
      expect((form.getByLabelText('Новое начало') as HTMLInputElement).value).toBe(
        '2026-10-15T09:00',
      )
      expect((form.getByLabelText('Новый конец') as HTMLInputElement).value).toBe(
        '2026-10-15T10:00',
      )
      await ui.type(form.getByLabelText('Причина'), 'совещание')
      await ui.click(form.getByRole('button', { name: 'Перенести' }))

      await vi.waitFor(() => expect(mutations()).toHaveLength(1))
      expect(mutations()[0]).toMatchObject({
        method: 'POST',
        path: '/instances/t1/reschedule',
        body: {
          planned_start: '2026-10-15T06:00:00.000Z',
          planned_end: '2026-10-15T07:00:00.000Z',
          comment: 'совещание',
        },
      })
      await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      // The original stays, muted, with the status "rescheduled".
      expect(
        (await screen.findByRole('button', { name: /Спорт.*Перенесено/ })).getAttribute(
          'data-status',
        ),
      ).toBe('rescheduled')
    })

    it('links a rescheduled task to where it went and jumps there', async () => {
      const ui = userEvent.setup()
      instances = [
        past('t1', {
          status: 'rescheduled',
          rescheduled_to: {
            id: 'n1',
            planned_start: '2026-10-16T06:00:00Z',
            planned_end: '2026-10-16T07:00:00Z',
          },
        }),
      ]
      renderCalendar()
      await ui.click(await screen.findByRole('button', { name: /Спорт/ }))
      const card = within(await dialog())

      expect(card.getByText(/Перенесено на/)).toBeTruthy()
      // Nothing can be done with a rescheduled task but read it (and delete it).
      for (const name of ['Выполнено', 'Старт', 'Перенести', 'Снять отметку', 'Править факт']) {
        expect(card.queryByRole('button', { name })).toBeNull()
      }
      expect(card.queryByLabelText('Название')).toBeNull()
      expect(card.queryByRole('button', { name: 'Сохранить' })).toBeNull()
      expect(card.getByRole('button', { name: 'Удалить' })).toBeTruthy()
      await ui.click(card.getByRole('button', { name: 'Перейти' }))
      await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      expect(column('2026-10-16')).toBeTruthy()
    })

    it('lets the mark of a rescheduled task be removed when the new task is gone', async () => {
      const ui = userEvent.setup()
      instances = [past('t1', { status: 'rescheduled', comment: 'совещание' })]
      renderCalendar()
      await ui.click(await screen.findByRole('button', { name: /Спорт/ }))
      const card = within(await dialog())

      expect(card.queryByText(/Перенесено на/)).toBeNull()
      await ui.click(card.getByRole('button', { name: 'Снять отметку' }))
      await vi.waitFor(() => expect(mutations()).toHaveLength(1))
      expect(mutations()[0]).toMatchObject({
        path: '/instances/t1/tracking',
        body: { status: 'planned' },
      })
    })

    it('warns that deleting a marked task drops its fact, and asks before deleting', async () => {
      const ui = userEvent.setup()
      instances = [doneLate('t1')]
      renderCalendar()
      await ui.click(await screen.findByRole('button', { name: /Спорт/ }))
      await ui.click(within(await dialog()).getByRole('button', { name: 'Удалить' }))

      const confirm = within(await screen.findByRole('dialog', { name: 'Удалить дело?' }))
      expect(confirm.getByTestId('marked-warning').textContent).toMatch(
        /вместе с фактом.*статистики/,
      )
      expect(mutations()).toEqual([])
      await ui.click(confirm.getByRole('button', { name: 'Удалить' }))
      await vi.waitFor(() =>
        expect(mutations()).toMatchObject([{ method: 'DELETE', path: '/instances/t1' }]),
      )
    })

    it('gives no such warning for a task that was not marked', async () => {
      const ui = userEvent.setup()
      instances = [past('t1')]
      renderCalendar()
      await ui.click(await screen.findByRole('button', { name: /Спорт/ }))
      await ui.click(within(await dialog()).getByRole('button', { name: 'Удалить' }))
      const confirm = within(await screen.findByRole('dialog', { name: 'Удалить дело?' }))
      expect(confirm.queryByTestId('marked-warning')).toBeNull()
    })

    it('starts a timer for a task outside the plan from the menu', async () => {
      const ui = userEvent.setup()
      renderCalendar()
      await ui.click(await screen.findByRole('button', { name: 'Меню' }))
      await ui.click(screen.getByRole('button', { name: 'Дело вне плана' }))

      const form = within(await dialog())
      expect(form.queryByLabelText('Началось')).toBeNull()
      expect((form.getByRole('button', { name: 'Запустить' }) as HTMLButtonElement).disabled).toBe(
        true,
      )
      await ui.type(form.getByLabelText('Название'), 'Вдруг')
      await ui.click(form.getByRole('button', { name: 'Запустить' }))

      await vi.waitFor(() => expect(mutations()).toHaveLength(1))
      expect(mutations()[0]).toMatchObject({
        method: 'POST',
        path: '/instances/unplanned',
        body: { title: 'Вдруг', category_ids: [] },
      })
      expect(Object.keys(mutations()[0]!.body as object)).not.toContain('actual_start')
      await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      expect(await screen.findByRole('button', { name: /Вдруг/ })).toBeTruthy()
    })

    it('adds a task outside the plan back-dated, with its fact', async () => {
      const ui = userEvent.setup()
      renderCalendar()
      await ui.click(await screen.findByRole('button', { name: 'Меню' }))
      await ui.click(screen.getByRole('button', { name: 'Дело вне плана' }))
      const form = within(await dialog())

      await ui.type(form.getByLabelText('Название'), 'Звонок маме')
      await ui.click(form.getByLabelText('Добавить задним числом'))
      expect((form.getByLabelText('Началось') as HTMLInputElement).value).toBe('2026-10-14T11:30')
      expect((form.getByLabelText('Закончилось') as HTMLInputElement).value).toBe(
        '2026-10-14T12:00',
      )
      await ui.click(form.getByRole('button', { name: 'Добавить' }))

      await vi.waitFor(() => expect(mutations()).toHaveLength(1))
      expect(mutations()[0]?.body).toEqual({
        title: 'Звонок маме',
        category_ids: [],
        actual_start: '2026-10-14T08:30:00.000Z',
        actual_end: '2026-10-14T09:00:00.000Z',
      })
    })

    it('edits a task outside the plan without planned times', async () => {
      const ui = userEvent.setup()
      instances = [unplanned()]
      renderCalendar()
      await ui.click(await screen.findByRole('button', { name: /Звонок/ }))
      const card = within(await dialog())

      expect(card.getByText('вне плана')).toBeTruthy()
      expect(card.queryByLabelText('Начало')).toBeNull()
      expect(card.queryByRole('button', { name: 'Выполнено' })).toBeNull()
      expect(card.queryByRole('button', { name: 'Перенести' })).toBeNull()
      expect(card.queryByRole('button', { name: 'Снять отметку' })).toBeNull()
      await ui.clear(card.getByLabelText('Название'))
      await ui.type(card.getByLabelText('Название'), 'Звонок маме')
      await ui.click(card.getByRole('button', { name: 'Сохранить' }))
      await vi.waitFor(() => expect(mutations()).toHaveLength(1))
      expect(mutations()[0]?.body).toEqual({ title: 'Звонок маме' })
    })
  })
})
