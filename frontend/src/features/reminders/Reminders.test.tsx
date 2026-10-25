// @vitest-environment jsdom
import { json, net, type StubRequest } from '@/test/fetchStub'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAuthStore } from '@/api/authStore'
import { setupApi } from '@/api/setup'
import type { GlobalReminders as Global, Instance, ReminderLevel, User } from '@/api/types'
import { SettingsPage } from '@/features/settings/SettingsPage'
import { createBrowserPlatform } from '@/platform/browser'
import { PlatformContext } from '@/platform/context'
import type { Platform } from '@/platform/types'
import { ReminderDialog } from './LevelEditor'
import { TaskReminders } from './TaskReminders'

const user: User = {
  id: 'u1',
  display_name: 'Ann',
  timezone: 'Europe/Moscow',
  slot_minutes: 30,
  default_view: 'day',
  deviation_threshold_minutes: 10,
  default_visibility: 'private',
}

const rule = (kind: string, offset: number | null, time: string | null = null) => ({
  kind,
  offset_minutes: offset,
  time_of_day: time,
})

let global: Global
let levels: Record<string, ReminderLevel>

function server(req: StubRequest): Response {
  if (req.path === '/auth/dev')
    return json(200, { token: 't', expires_at: '2030-01-01T00:00:00Z', user })
  if (req.path === '/me') return json(200, user)
  if (req.path === '/reminders/global') {
    if (req.method === 'PUT') global = req.body as Global
    return json(200, global)
  }
  const level = /^\/reminders\/([^/]+)\/([^/]+)$/.exec(req.path)
  if (level) {
    const key = `${level[1]}/${level[2]}`
    // A habit has no levels above it: with nothing of its own it has no reminders.
    const inherited =
      level[1] === 'habit'
        ? { source: 'habit' as const, rules: [] }
        : { source: 'global' as const, rules: global.rules }
    const cur = levels[key] ?? { override: null, effective: inherited }
    if (req.method === 'PUT') {
      const body = req.body as { enabled: boolean; rules: ReminderLevel['effective']['rules'] }
      levels[key] = {
        override: body,
        effective: {
          source: level[1] as 'category',
          rules: body.enabled ? body.rules : [],
        },
      }
      return json(200, levels[key])
    }
    if (req.method === 'DELETE') {
      delete levels[key]
      return json(200, { override: null, effective: inherited })
    }
    return json(200, cur)
  }
  return json(404, { code: 'not_found', message: 'nf' })
}

function platformWith(over: Partial<Platform> = {}): Platform {
  return { ...createBrowserPlatform(), ...over }
}

function wrap(platform: Platform, ui: React.ReactNode) {
  return render(
    <PlatformContext.Provider value={platform}>
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <MemoryRouter>{ui}</MemoryRouter>
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
  setupApi(createBrowserPlatform())
})

beforeEach(() => {
  global = {
    enabled: true,
    quiet_hours: null,
    rules: [rule('before_start', 10), rule('after_end', 0)] as Global['rules'],
  }
  levels = {}
  net.calls.length = 0
  net.handler = server
  useAuthStore.getState().setToken(null)
})

afterEach(() => cleanup())

/** The section of the global settings once its data has come. */
async function globalSection() {
  const section = await screen.findByRole('region', { name: 'Напоминания' })
  await within(section).findByRole('checkbox', { name: 'Присылать напоминания' })
  return section
}

describe('the global settings', () => {
  it('shows the default reminders and the switch', async () => {
    wrap(platformWith(), <SettingsPage />)
    const section = await globalSection()
    expect(
      (within(section).getByRole('checkbox', { name: 'Присылать напоминания' }) as HTMLInputElement)
        .checked,
    ).toBe(true)
    const rules = within(section).getByTestId('rules')
    expect(within(rules).getAllByRole('listitem')).toHaveLength(2)
    expect(
      (within(rules).getAllByRole('combobox', { name: 'Вид напоминания' })[0] as HTMLSelectElement)
        .value,
    ).toBe('before_start')
    expect(
      (within(rules).getAllByRole('textbox', { name: 'Сколько' })[0] as HTMLInputElement).value,
    ).toBe('10')
  })

  it('saves changed rules and quiet hours', async () => {
    const user = userEvent.setup()
    wrap(platformWith(), <SettingsPage />)
    const section = await globalSection()

    await user.click(within(section).getByRole('checkbox', { name: 'Тихие часы' }))
    await user.click(within(section).getByRole('button', { name: '+ Напоминание' }))
    const rules = within(section).getByTestId('rules')
    const items = within(rules).getAllByRole('listitem')
    expect(items).toHaveLength(3)
    const added = items[2]!
    await user.selectOptions(
      within(added).getByRole('combobox', { name: 'Вид напоминания' }),
      'not_started',
    )
    const amount = within(added).getByRole('textbox', { name: 'Сколько' })
    await user.clear(amount)
    await user.type(amount, '2')
    await user.selectOptions(within(added).getByRole('combobox', { name: 'Единица' }), 'hour')
    // The first one goes.
    await user.click(within(items[0]!).getByRole('button', { name: 'Убрать напоминание' }))

    await user.click(within(section).getByRole('button', { name: 'Сохранить напоминания' }))
    await waitFor(() => expect(calls('PUT', /global/)).toHaveLength(1))
    expect(calls('PUT', /global/)[0]!.body).toEqual({
      enabled: true,
      quiet_hours: { start: '23:00', end: '08:00' },
      rules: [rule('after_end', 0), rule('not_started', 120)],
    })
    expect(await within(section).findByText('Сохранено')).toBeTruthy()
  })

  it('does not save quiet hours that begin and end together, nor a bad amount', async () => {
    const user = userEvent.setup()
    wrap(platformWith(), <SettingsPage />)
    const section = await globalSection()
    const save = within(section).getByRole('button', {
      name: 'Сохранить напоминания',
    }) as HTMLButtonElement
    await user.click(within(section).getByRole('checkbox', { name: 'Тихие часы' }))
    const end = within(section).getByLabelText('Тихие часы до') as HTMLInputElement
    await user.clear(end)
    await user.type(end, '23:00')
    expect(await within(section).findByText(/не должны совпадать/)).toBeTruthy()
    expect(save.disabled).toBe(true)
    await user.clear(end)
    await user.type(end, '07:00')
    expect(save.disabled).toBe(false)

    const amount = within(section).getAllByRole('textbox', { name: 'Сколько' })[0]!
    await user.clear(amount)
    await user.type(amount, 'abc')
    expect(save.disabled).toBe(true)
    expect(within(section).getByText(/Укажите целое число/)).toBeTruthy()
  })

  it('asks Telegram for the right to write when the switch is turned on', async () => {
    global.enabled = false
    const requestWriteAccess = vi.fn(() => Promise.resolve(true))
    const user = userEvent.setup()
    wrap(platformWith({ kind: 'telegram', requestWriteAccess }), <SettingsPage />)
    const section = await globalSection()
    const box = within(section).getByRole('checkbox', { name: 'Присылать напоминания' })
    expect((box as HTMLInputElement).checked).toBe(false)
    await user.click(box)
    expect(requestWriteAccess).toHaveBeenCalledTimes(1)
    expect(within(section).queryByRole('status')).toBeNull()
  })

  it('explains what to do when Telegram refuses', async () => {
    global.enabled = false
    const user = userEvent.setup()
    wrap(
      platformWith({ kind: 'telegram', requestWriteAccess: () => Promise.resolve(false) }),
      <SettingsPage />,
    )
    const section = await globalSection()
    await user.click(within(section).getByRole('checkbox', { name: 'Присылать напоминания' }))
    expect((await within(section).findByRole('status')).textContent).toMatch(/нажмите «Старт»/)
  })

  it('does not ask a browser, and does not ask when it is turned off', async () => {
    const requestWriteAccess = vi.fn(() => Promise.resolve(false))
    const user = userEvent.setup()
    wrap(platformWith({ requestWriteAccess }), <SettingsPage />)
    const section = await globalSection()
    await user.click(within(section).getByRole('checkbox', { name: 'Присылать напоминания' })) // off
    expect(requestWriteAccess).not.toHaveBeenCalled()
    await user.click(within(section).getByRole('checkbox', { name: 'Присылать напоминания' })) // on
    expect(requestWriteAccess).toHaveBeenCalledTimes(1)
    // A browser has no Telegram chat to write to: no scary note.
    expect(within(section).queryByRole('status')).toBeNull()
  })

  it('switches everything off in one save', async () => {
    const user = userEvent.setup()
    wrap(platformWith(), <SettingsPage />)
    const section = await globalSection()
    await user.click(within(section).getByRole('checkbox', { name: 'Присылать напоминания' }))
    await user.click(within(section).getByRole('button', { name: 'Сохранить напоминания' }))
    await waitFor(() => expect(calls('PUT', /global/)).toHaveLength(1))
    expect((calls('PUT', /global/)[0]!.body as Global).enabled).toBe(false)
  })
})

describe('the reminders of a level', () => {
  const open = (scope: 'category' | 'habit' | 'instance' | 'series', onClose = vi.fn()) => {
    wrap(
      platformWith(),
      <ReminderDialog scope={scope} id="x1" subject="Работа" onClose={onClose} />,
    )
    return onClose
  }

  it('shows what applies now when the level inherits', async () => {
    open('category')
    const dialog = await screen.findByRole('dialog', { name: 'Напоминания: Работа' })
    const effective = await within(dialog).findByTestId('effective')
    expect(effective.textContent).toContain('Сейчас действуют общие настройки')
    expect(effective.textContent).toContain('За 10 минут до начала')
    expect(effective.textContent).toContain('Сразу после окончания')
    expect(
      (within(dialog).getByRole('radio', { name: 'Как обычно' }) as HTMLInputElement).checked,
    ).toBe(true)
  })

  it('starts a set of its own from what applies and saves it', async () => {
    const user = userEvent.setup()
    const onClose = open('category')
    const dialog = await screen.findByRole('dialog')
    await user.click(await within(dialog).findByRole('radio', { name: 'Свои напоминания' }))
    const rules = within(dialog).getByTestId('rules')
    expect(within(rules).getAllByRole('listitem')).toHaveLength(2) // copied from the global ones
    const amount = within(rules).getAllByRole('textbox', { name: 'Сколько' })[0]!
    await user.clear(amount)
    await user.type(amount, '1')
    await user.selectOptions(within(rules).getAllByRole('combobox', { name: 'Единица' })[0]!, 'day')
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }))

    await waitFor(() => expect(calls('PUT', /reminders\/category\/x1/)).toHaveLength(1))
    expect(calls('PUT', /reminders\/category\/x1/)[0]!.body).toEqual({
      enabled: true,
      rules: [rule('before_start', 1440), rule('after_end', 0)],
    })
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('switches a level off', async () => {
    const user = userEvent.setup()
    open('category')
    const dialog = await screen.findByRole('dialog')
    await user.click(await within(dialog).findByRole('radio', { name: 'Без напоминаний' }))
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }))
    await waitFor(() => expect(calls('PUT', /reminders\/category\/x1/)).toHaveLength(1))
    expect(calls('PUT', /reminders\/category\/x1/)[0]!.body).toEqual({ enabled: false, rules: [] })
  })

  it('goes back to inheriting by deleting the level settings', async () => {
    levels['category/x1'] = {
      override: {
        enabled: true,
        rules: [rule('overrun', 5)] as ReminderLevel['effective']['rules'],
      },
      effective: {
        source: 'category',
        rules: [rule('overrun', 5)] as ReminderLevel['effective']['rules'],
      },
    }
    const user = userEvent.setup()
    open('category')
    const dialog = await screen.findByRole('dialog')
    expect(
      ((await within(dialog).findByRole('radio', { name: 'Свои напоминания' })) as HTMLInputElement)
        .checked,
    ).toBe(true)
    await user.click(within(dialog).getByRole('radio', { name: 'Как обычно' }))
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }))
    await waitFor(() => expect(calls('DELETE', /reminders\/category\/x1/)).toHaveLength(1))
    expect(calls('PUT', /reminders\/category\/x1/)).toHaveLength(0)
  })

  it('does nothing on save when it was inheriting and still is', async () => {
    const user = userEvent.setup()
    const onClose = open('category')
    const dialog = await screen.findByRole('dialog')
    await within(dialog).findByTestId('effective')
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(net.calls.filter((c) => c.method !== 'GET' && c.path !== '/auth/dev')).toHaveLength(0)
  })

  it('gives a habit times of day and no other choices', async () => {
    const user = userEvent.setup()
    open('habit')
    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByRole('radio', { name: 'Не напоминать' })).toBeTruthy()
    expect(within(dialog).queryByRole('radio', { name: 'Без напоминаний' })).toBeNull()
    await user.click(within(dialog).getByRole('radio', { name: 'Напоминать в заданное время' }))
    await user.click(within(dialog).getByRole('button', { name: '+ Напоминание' }))
    const time = within(dialog).getByLabelText('Время напоминания') as HTMLInputElement
    expect(time.value).toBe('21:00')
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }))
    await waitFor(() => expect(calls('PUT', /reminders\/habit\/x1/)).toHaveLength(1))
    expect(calls('PUT', /reminders\/habit\/x1/)[0]!.body).toEqual({
      enabled: true,
      rules: [rule('habit_time', null, '21:00')],
    })
  })

  it('opens a habit that was switched off through the API as "do not remind", not as an empty form', async () => {
    levels['habit/x1'] = {
      override: { enabled: false, rules: [] },
      effective: { source: 'habit', rules: [] },
    }
    open('habit')
    const dialog = await screen.findByRole('dialog')
    const none = (await within(dialog).findByRole('radio', {
      name: 'Не напоминать',
    })) as HTMLInputElement
    expect(none.checked).toBe(true)
  })

  it('shows an error from the server and stays open', async () => {
    net.handler = (req) =>
      req.method === 'PUT' && req.path.startsWith('/reminders/category')
        ? json(400, { code: 'validation_failed', field: 'rules', message: 'x' })
        : server(req)
    const user = userEvent.setup()
    const onClose = open('category')
    const dialog = await screen.findByRole('dialog')
    await user.click(await within(dialog).findByRole('radio', { name: 'Без напоминаний' }))
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }))
    expect((await within(dialog).findByRole('alert')).textContent).toMatch(/неверно/)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('says so when the level cannot be loaded', async () => {
    net.handler = (req) =>
      req.path.startsWith('/reminders/')
        ? json(404, { code: 'not_found', message: 'x' })
        : server(req)
    open('category')
    expect((await screen.findByRole('alert')).textContent).toMatch(/Не удалось загрузить/)
  })
})

describe('the reminders of a task', () => {
  const instance = (series: string | null): Instance => ({
    id: 'i1',
    title: 'Планёрка',
    description: '',
    planned_start: '2026-10-14T06:00:00Z',
    planned_end: '2026-10-14T07:00:00Z',
    actual_start: null,
    actual_end: null,
    status: 'planned',
    comment: '',
    category_ids: [],
    series_id: series,
    habit_id: null,
    rescheduled_from: null,
    rescheduled_to: null,
    deviations: [],
    visibility: 'private',
  })

  it('goes straight to the task for a one-off task', async () => {
    wrap(platformWith(), <TaskReminders instance={instance(null)} onClose={() => {}} />)
    await screen.findByRole('dialog', { name: 'Напоминания: Планёрка' })
    await waitFor(() =>
      expect(net.calls.some((c) => c.path === '/reminders/instance/i1')).toBe(true),
    )
  })

  it('asks whether it is for this one or the whole series', async () => {
    const user = userEvent.setup()
    wrap(platformWith(), <TaskReminders instance={instance('s1')} onClose={() => {}} />)
    const ask = await screen.findByRole('dialog', { name: 'Напоминания' })
    expect(net.calls.some((c) => c.path.startsWith('/reminders/'))).toBe(false)
    await user.click(within(ask).getByRole('button', { name: 'Для всех дел серии' }))
    await screen.findByRole('dialog', { name: 'Напоминания: Планёрка' })
    await waitFor(() => expect(net.calls.some((c) => c.path === '/reminders/series/s1')).toBe(true))
  })

  it('can be for this occurrence only', async () => {
    const user = userEvent.setup()
    wrap(platformWith(), <TaskReminders instance={instance('s1')} onClose={() => {}} />)
    await user.click(await screen.findByRole('button', { name: 'Только для этого дела' }))
    await waitFor(() =>
      expect(net.calls.some((c) => c.path === '/reminders/instance/i1')).toBe(true),
    )
  })
})
