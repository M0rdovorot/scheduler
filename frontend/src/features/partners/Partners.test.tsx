// @vitest-environment jsdom
import { json, net, noContent, type StubRequest } from '@/test/fetchStub'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAuthStore } from '@/api/authStore'
import { setupApi } from '@/api/setup'
import type { BusyBlock, FreeInterval, Partner, User } from '@/api/types'
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
  default_visibility: 'private',
}

const partner = (over: Partial<Partner> & Pick<Partner, 'id' | 'display_name'>): Partner => ({
  created_at: '2026-10-01T00:00:00Z',
  tasks_shared: false,
  habits_shared: false,
  ...over,
})

let partners: Partner[]
let busy: BusyBlock[]
let free: FreeInterval[]
/** What the next accept answers with. */
let acceptAnswer: () => Response

function server(req: StubRequest): Response {
  if (req.path === '/auth/dev')
    return json(200, { token: 't', expires_at: '2030-01-01T00:00:00Z', user })
  if (req.method === 'GET' && req.path === '/me') return json(200, user)
  if (req.path === '/categories') return json(200, [])
  if (req.path === '/habits') return json(200, [])
  if (req.path.startsWith('/instances')) return json(200, [])
  if (req.method === 'GET' && req.path === '/partners') return json(200, partners)
  if (req.method === 'POST' && req.path === '/partners/invites')
    return json(201, { token: 'tok-123', expires_at: '2026-10-21T09:00:00Z' })
  if (req.method === 'POST' && req.path === '/partners/invites/accept') return acceptAnswer()
  const access = /^\/partners\/([^/]+)\/access$/.exec(req.path)
  if (req.method === 'PUT' && access) {
    const p = partners.find((x) => x.id === access[1])!
    const body = req.body as { tasks?: boolean; habits?: boolean }
    if (body.tasks !== undefined) p.tasks_shared = body.tasks
    if (body.habits !== undefined) p.habits_shared = body.habits
    return json(200, p)
  }
  const busyOf = /^\/partners\/([^/]+)\/busy$/.exec(req.path)
  if (req.method === 'GET' && busyOf) return json(200, busy)
  const one = /^\/partners\/([^/]+)$/.exec(req.path)
  if (req.method === 'DELETE' && one) {
    partners = partners.filter((p) => p.id !== one[1])
    return noContent()
  }
  if (req.method === 'GET' && req.path === '/free-time') return json(200, free)
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
  partners = [
    partner({ id: 'p1', display_name: 'Борис' }),
    partner({ id: 'p2', display_name: 'Клара', tasks_shared: true }),
  ]
  busy = []
  free = []
  acceptAnswer = () => json(200, partner({ id: 'p3', display_name: 'Дмитрий' }))
  net.calls.length = 0
  net.handler = server
  useAuthStore.getState().setToken(null)
  history.replaceState(null, '', '/')
  sessionStorage.clear()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('the list of partners', () => {
  it('shows each partner with the access given to them', async () => {
    renderAt('/partners')
    const boris = (await screen.findByRole('heading', { name: 'Борис' })).closest('li')!
    const clara = screen.getByRole('heading', { name: 'Клара' }).closest('li')!
    expect(
      (within(boris).getByLabelText(/Видит названия моих дел/) as HTMLInputElement).checked,
    ).toBe(false)
    expect(
      (within(clara).getByLabelText(/Видит названия моих дел/) as HTMLInputElement).checked,
    ).toBe(true)
    expect((within(clara).getByLabelText(/Видит мои привычки/) as HTMLInputElement).checked).toBe(
      false,
    )
  })

  it('gives access to tasks and to habits separately', async () => {
    const ui = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    renderAt('/partners')
    const boris = (await screen.findByRole('heading', { name: 'Борис' })).closest('li')!
    await ui.click(within(boris).getByLabelText(/Видит мои привычки/))
    await waitFor(() => expect(calls('PUT', /\/access$/)).toHaveLength(1))
    expect(calls('PUT', /\/partners\/p1\/access$/)[0]?.body).toEqual({ habits: true })
    await waitFor(() =>
      expect((within(boris).getByLabelText(/Видит мои привычки/) as HTMLInputElement).checked).toBe(
        true,
      ),
    )
    expect(
      (within(boris).getByLabelText(/Видит названия моих дел/) as HTMLInputElement).checked,
    ).toBe(false)
  })

  it('asks before breaking the link, and then breaks it', async () => {
    const ui = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    renderAt('/partners')
    const boris = (await screen.findByRole('heading', { name: 'Борис' })).closest('li')!
    await ui.click(within(boris).getByRole('button', { name: 'Разорвать связь' }))
    expect(calls('DELETE', /\/partners\//)).toHaveLength(0)

    const dialog = await screen.findByRole('dialog', { name: 'Разорвать связь?' })
    await ui.click(within(dialog).getByRole('button', { name: 'Разорвать' }))
    await waitFor(() => expect(calls('DELETE', /\/partners\/p1$/)).toHaveLength(1))
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Борис' })).toBeNull())
    expect(screen.getByRole('heading', { name: 'Клара' })).toBeTruthy()
  })

  it('offers the invite link for the site, with the token in it', async () => {
    const ui = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    renderAt('/partners')
    await ui.click(await screen.findByRole('button', { name: 'Пригласить партнёра' }))
    const link = await screen.findByLabelText('Ссылка-приглашение')
    expect((link as HTMLInputElement).value).toBe(`${location.origin}/?invite=tok-123`)
    expect(screen.getByRole('button', { name: 'Новая ссылка' })).toBeTruthy()
  })

  it('invites the first partner when there are none', async () => {
    partners = []
    renderAt('/partners')
    expect(await screen.findByText(/Партнёров пока нет/)).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'Свободное время' })).toBeNull()
  })
})

describe('accepting an invite', () => {
  it('accepts the token from the address once, and clears it', async () => {
    history.replaceState(null, '', '/?invite=abc')
    renderAt('/')
    const dialog = await screen.findByRole('dialog', { name: 'Приглашение' })
    expect((await within(dialog).findByRole('status')).textContent).toMatch(/Дмитрий/)
    expect(calls('POST', /invites\/accept$/)).toHaveLength(1)
    expect(calls('POST', /invites\/accept$/)[0]?.body).toEqual({ token: 'abc' })
    expect(location.search).toBe('')
    expect(sessionStorage.getItem('pendingInvite')).toBeNull()
  })

  it('accepts a token kept from before the sign-in', async () => {
    sessionStorage.setItem('pendingInvite', 'kept')
    renderAt('/')
    await screen.findByRole('dialog', { name: 'Приглашение' })
    await waitFor(() => expect(calls('POST', /invites\/accept$/)).toHaveLength(1))
    expect(calls('POST', /invites\/accept$/)[0]?.body).toEqual({ token: 'kept' })
  })

  it('does nothing without a token', async () => {
    renderAt('/partners')
    await screen.findByRole('heading', { name: 'Борис' })
    expect(calls('POST', /invites\/accept$/)).toHaveLength(0)
    expect(screen.queryByRole('dialog', { name: 'Приглашение' })).toBeNull()
  })

  it('explains an invite that no longer works', async () => {
    acceptAnswer = () => json(404, { code: 'invite_invalid', message: 'x' })
    history.replaceState(null, '', '/?invite=old')
    renderAt('/')
    const dialog = await screen.findByRole('dialog', { name: 'Приглашение' })
    expect((await within(dialog).findByRole('alert')).textContent).toMatch(/просрочено/)
    // A failed token is not tried again after a reload.
    expect(location.search).toBe('')
    expect(sessionStorage.getItem('pendingInvite')).toBeNull()
  })

  it('goes to the partners after a success', async () => {
    const ui = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    history.replaceState(null, '', '/?invite=abc')
    renderAt('/')
    await ui.click(await screen.findByRole('button', { name: 'К партнёрам' }))
    expect(await screen.findByRole('heading', { name: 'Партнёры' })).toBeTruthy()
  })
})

describe("a partner's calendar", () => {
  it('shows busy blocks, with a title only where there is one', async () => {
    busy = [
      { start: '2026-10-14T07:00:00Z', end: '2026-10-14T08:00:00Z', title: 'Стоматолог' },
      { start: '2026-10-14T09:00:00Z', end: '2026-10-14T10:30:00Z', title: null },
    ]
    renderAt('/partners/p1')
    expect(await screen.findByRole('button', { name: /^Стоматолог, 10:00–11:00/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Занят, 12:00–13:30/ })).toBeTruthy()
    const request = calls('GET', /\/partners\/p1\/busy$/)[0]
    expect(request?.query.get('from')).toBe('2026-10-13T21:00:00.000Z')
    expect(request?.query.get('to')).toBe('2026-10-14T21:00:00.000Z')
  })

  it('says so when the partner is gone', async () => {
    net.handler = (req) =>
      /\/busy$/.test(req.path) ? json(404, { code: 'not_found', message: 'nf' }) : server(req)
    renderAt('/partners/p9')
    expect((await screen.findByRole('alert')).textContent).toMatch(/Партнёр не найден/)
  })
})

describe('free time', () => {
  it('asks for no search until somebody is chosen', async () => {
    renderAt('/free-time')
    await screen.findByLabelText('Борис')
    expect(screen.getByText(/Выберите, с кем искать время/)).toBeTruthy()
    expect(calls('GET', /\/free-time$/)).toHaveLength(0)
  })

  it('lists the shared free time by day, in the hours the person is awake', async () => {
    const ui = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    // Moscow: 03:00–10:00 and 12:00–15:30 on the 14th.
    free = [
      { start: '2026-10-14T00:00:00Z', end: '2026-10-14T07:00:00Z' },
      { start: '2026-10-14T09:00:00Z', end: '2026-10-14T12:30:00Z' },
    ]
    renderAt('/free-time')
    await ui.click(await screen.findByLabelText('Борис'))
    await ui.click(screen.getByLabelText('Клара'))

    expect(await screen.findByText('09:00–10:00')).toBeTruthy()
    expect(screen.getByText('12:00–15:30')).toBeTruthy()
    expect(screen.getByText('3 ч 30 мин')).toBeTruthy()
    // The night part is cut off.
    expect(screen.queryByText(/03:00/)).toBeNull()

    const request = calls('GET', /\/free-time$/).at(-1)
    expect(request?.query.getAll('with').sort()).toEqual(['p1', 'p2'])
    expect(request?.query.get('min_minutes')).toBe('60')
  })

  it('says when there is nothing in common', async () => {
    const ui = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    renderAt('/free-time')
    await ui.click(await screen.findByLabelText('Борис'))
    expect(await screen.findByText(/общего свободного времени нет/)).toBeTruthy()
  })
})
