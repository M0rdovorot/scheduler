// @vitest-environment jsdom
import { json, net, type StubRequest } from '@/test/fetchStub'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { User } from '@/api/types'
import { useAuthStore } from '@/api/authStore'
import { App } from './App'
import { setupApi } from '@/api/setup'
import { createBrowserPlatform } from '@/platform/browser'
import { PlatformContext } from '@/platform/context'

let user: User

function apiServer(req: StubRequest): Response {
  switch (`${req.method} ${req.path}`) {
    case 'POST /auth/dev':
      return json(200, { token: 't1', expires_at: '2030-01-01T00:00:00Z', user })
    case 'PATCH /me/settings':
      user = { ...user, ...(req.body as Partial<User>) }
      return json(200, user)
    case 'GET /instances':
    case 'GET /categories':
      return json(200, [])
    case 'GET /me':
      return json(200, user)
    case 'GET /reminders/global':
      return json(200, { enabled: true, quiet_hours: null, rules: [] })
    default:
      return json(404, { code: 'not_found', message: 'not found' })
  }
}

const platform = createBrowserPlatform()

function renderApp(path: string) {
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
  // jsdom does not implement matchMedia, which the browser platform uses.
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia
  setupApi(platform)
})

beforeEach(() => {
  user = {
    id: 'u1',
    display_name: 'Ann',
    timezone: 'Europe/Moscow',
    slot_minutes: 30,
    default_view: 'day',
    deviation_threshold_minutes: 10,
  }
  useAuthStore.getState().setToken(null)
  net.calls.length = 0
  net.handler = apiServer
})

afterEach(() => {
  cleanup()
})

describe('app', () => {
  it('signs in, then opens the calendar in the default view', async () => {
    renderApp('/')

    const day = await screen.findByRole('radio', { name: 'День' })
    expect(day.getAttribute('aria-checked')).toBe('true')
    expect(net.calls[0]).toMatchObject({ method: 'POST', path: '/auth/dev' })
    expect((net.calls[0]?.body as { timezone: string }).timezone).toBeTruthy()
    // The user from the login response is reused: no extra /me request.
    expect(net.calls.some((c) => c.path === '/me')).toBe(false)
  })

  it('saves only the changed settings, sending the session token', async () => {
    const ui = userEvent.setup()
    renderApp('/settings')

    const save = await screen.findByRole('button', { name: 'Сохранить' })
    expect((save as HTMLButtonElement).disabled).toBe(true)

    await ui.selectOptions(screen.getByLabelText('Размер слота'), '15')
    expect((save as HTMLButtonElement).disabled).toBe(false)
    await ui.click(save)

    expect(await screen.findByText('Сохранено')).toBeTruthy()
    const patch = net.calls.find((c) => c.method === 'PATCH')
    expect(patch?.body).toEqual({ slot_minutes: 15 })
    expect(patch?.auth).toBe('Bearer t1')
    expect((save as HTMLButtonElement).disabled).toBe(true)
  })

  it('blocks saving an invalid time zone', async () => {
    const ui = userEvent.setup()
    renderApp('/settings')

    const zone = await screen.findByLabelText('Часовой пояс')
    await ui.clear(zone)
    await ui.type(zone, 'Mars/Olympus')

    expect(screen.getByText(/Укажите часовой пояс/)).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Сохранить' }) as HTMLButtonElement).disabled).toBe(
      true,
    )
  })

  it('shows the server message when saving fails', async () => {
    const ui = userEvent.setup()
    renderApp('/settings')
    await screen.findByLabelText('Размер слота')
    net.handler = (req) =>
      req.method === 'PATCH'
        ? json(400, { code: 'validation_failed', message: 'slot_minutes: nope' })
        : apiServer(req)

    await ui.selectOptions(await screen.findByLabelText('Размер слота'), '5')
    await ui.click(screen.getByRole('button', { name: 'Сохранить' }))

    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toBe('slot_minutes: nope')
  })

  it('signs in again after the session expires and repeats the request', async () => {
    const ui = userEvent.setup()
    renderApp('/settings')
    const slot = await screen.findByLabelText('Размер слота')
    let logins = 0
    net.handler = (req) => {
      if (req.path === '/auth/dev') {
        logins++
        return json(200, { token: 't2', expires_at: '2030-01-01T00:00:00Z', user })
      }
      if (req.method === 'PATCH' && net.calls.at(-1)?.auth !== 'Bearer t2') return json(401, {})
      return apiServer(req)
    }

    await ui.selectOptions(slot, '60')
    await ui.click(screen.getByRole('button', { name: 'Сохранить' }))

    expect(await screen.findByText('Сохранено')).toBeTruthy()
    expect(logins).toBe(1)
    expect(net.calls.filter((c) => c.method === 'PATCH')).toHaveLength(2)
  })

  it('explains that browser sign-in is unavailable when dev auth is off', async () => {
    net.handler = () => json(404, { code: 'not_found', message: 'not found' })
    renderApp('/')

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toMatch(/только в режиме разработки/),
    )
    expect(screen.getByRole('button', { name: 'Повторить' })).toBeTruthy()
  })
})
