// @vitest-environment jsdom
import { json, net, noContent, type StubRequest } from '@/test/fetchStub'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAuthStore } from '@/api/authStore'
import { setupApi } from '@/api/setup'
import type { Category, Instance, User } from '@/api/types'
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

const task = (
  id: string,
  title: string,
  start: string,
  end: string,
  categoryIds: string[] = [],
): Instance => ({
  id,
  title,
  description: '',
  planned_start: start,
  planned_end: end,
  status: 'planned',
  category_ids: categoryIds,
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
  const match = /^\/instances\/([^/]+)$/.exec(req.path)
  const target = match ? instances.find((i) => i.id === match[1]) : undefined

  if (req.method === 'GET' && req.path === '/categories') return json(200, categories)
  if (req.method === 'GET' && req.path === '/instances') {
    const from = new Date(req.query.get('from')!).getTime()
    const to = new Date(req.query.get('to')!).getTime()
    return json(
      200,
      instances.filter(
        (i) => new Date(i.planned_start).getTime() < to && new Date(i.planned_end).getTime() > from,
      ),
    )
  }
  if (req.method === 'POST' && req.path === '/tasks') {
    const created = { ...task(`n${nextId++}`, '', '', ''), ...body, status: 'planned' as const }
    created.category_ids ??= []
    instances.push(created as Instance)
    return json(201, created)
  }
  if (!match || !target) return json(404, { code: 'not_found', message: 'not found' })
  if (req.method === 'PATCH') return json(200, Object.assign(target, body))
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
  net.calls.length = 0
  net.handler = server
  useAuthStore.getState().setToken(null)
  useCalendarStore.setState({ view: null, anchor: null })
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
})
