// @vitest-environment jsdom
import { json, net, type StubRequest } from '@/test/fetchStub'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { User } from '@/api/types'
import { useAuthStore } from '@/api/authStore'
import { App } from './App'
import { setupApi } from '@/api/setup'
import { createBrowserPlatform } from '@/platform/browser'
import { PlatformContext } from '@/platform/context'
import { clearTelegramAuthResult } from '@/platform'

let user: User
/** Whether the browser holds a session cookie (the web version). */
let cookie: boolean

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
      return useAuthStore.getState().token || cookie ? json(200, user) : json(401, {})
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
  useAuthStore.setState({ token: null, signedOut: false })
  cookie = false
  clearTelegramAuthResult()
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
    // No cookie session yet: /me gets 401, dev mode signs in and repeats it.
    expect(net.calls.slice(0, 3).map((c) => `${c.method} ${c.path} ${c.auth}`)).toEqual([
      'GET /me null',
      'POST /auth/dev null',
      'GET /me Bearer t1',
    ])
    expect((net.calls[1]?.body as { timezone: string }).timezone).toBeTruthy()
  })

  it('uses the cookie session of the web version without signing in', async () => {
    cookie = true
    net.handler = (req) => (req.path === '/auth/dev' ? json(404, {}) : apiServer(req))
    renderApp('/')

    expect(await screen.findByRole('radio', { name: 'День' })).toBeTruthy()
    expect(net.calls.some((c) => c.path.startsWith('/auth'))).toBe(false)
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

  it('shows the sign-in page when there is no session and dev auth is off', async () => {
    net.handler = (req) => {
      if (req.path === '/auth/dev') return json(404, { code: 'not_found', message: 'not found' })
      if (req.path === '/auth/config') return json(200, { telegram_bot_id: 123456 })
      return apiServer(req)
    }
    renderApp('/')

    expect(await screen.findByRole('button', { name: 'Войти через Telegram' })).toBeTruthy()
  })

  it('explains when the server has no Telegram sign-in', async () => {
    net.handler = (req) => {
      if (req.path === '/auth/dev') return json(404, {})
      if (req.path === '/auth/config') return json(200, { telegram_bot_id: 0 })
      return apiServer(req)
    }
    renderApp('/')

    expect((await screen.findByRole('alert')).textContent).toMatch(/не настроен/)
    expect(screen.queryByRole('button', { name: 'Войти через Telegram' })).toBeNull()
  })

  it('finishes signing in when Telegram brings the user back', async () => {
    const fields = { id: 42, first_name: 'Аня', auth_date: 1, hash: 'h' }
    const encoded = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(fields))))
    window.location.hash = '#tgAuthResult=' + encoded.replace(/\+/g, '-').replace(/\//g, '_')
    net.handler = (req) => {
      if (req.path === '/auth/dev') return json(404, {})
      if (req.path === '/auth/config') return json(200, { telegram_bot_id: 123456 })
      if (req.path === '/auth/telegram-widget') {
        cookie = true
        return json(200, { expires_at: '2030-01-01T00:00:00Z', user })
      }
      return apiServer(req)
    }
    renderApp('/')

    expect(await screen.findByRole('radio', { name: 'День' })).toBeTruthy()
    const logins = net.calls.filter((c) => c.path === '/auth/telegram-widget')
    expect(logins).toHaveLength(1)
    expect(logins[0]?.body).toMatchObject({
      auth_data: { id: '42', first_name: 'Аня', auth_date: '1', hash: 'h' },
    })
    expect(window.location.hash).toBe('')
  })

  it('signs out from the settings page', async () => {
    const ui = userEvent.setup()
    cookie = true
    net.handler = (req) => {
      if (req.path === '/auth/logout') {
        cookie = false
        return new Response(null, { status: 204 })
      }
      if (req.path === '/auth/dev') return json(404, {})
      if (req.path === '/auth/config') return json(200, { telegram_bot_id: 123456 })
      return apiServer(req)
    }
    renderApp('/settings')

    await ui.click(await screen.findByRole('button', { name: 'Выйти' }))

    expect(await screen.findByRole('button', { name: 'Войти через Telegram' })).toBeTruthy()
  })
})
