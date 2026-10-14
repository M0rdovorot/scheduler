import createClient from 'openapi-fetch'
import { describe, expect, it, vi } from 'vitest'
import { createAuthMiddleware } from './authMiddleware'
import type { paths } from './schema.gen'

function setup(handler: (req: Request) => Response | Promise<Response>) {
  const calls: Request[] = []
  const fetchMock = vi.fn(async (input: Request) => {
    calls.push(input.clone())
    return handler(input)
  })
  let token: string | null = 'old'
  const refreshToken = vi.fn(async (): Promise<string | null> => {
    token = 'new'
    return token
  })
  const client = createClient<paths>({
    baseUrl: 'http://test/api/v1',
    fetch: fetchMock as unknown as typeof fetch,
  })
  client.use(
    createAuthMiddleware({
      getToken: () => token,
      refreshToken,
      publicPaths: ['/auth/telegram', '/auth/dev', '/healthz'],
    }),
  )
  return { client, calls, refreshToken }
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const user = {
  id: 'u',
  display_name: 'Ann',
  timezone: 'UTC',
  slot_minutes: 30,
  default_view: 'day',
  deviation_threshold_minutes: 10,
}

describe('auth middleware', () => {
  it('sends the bearer token on protected requests', async () => {
    const { client, calls } = setup(() => json(200, user))
    await client.GET('/me')
    expect(calls[0]?.headers.get('Authorization')).toBe('Bearer old')
  })

  it('does not send the token to public endpoints', async () => {
    const { client, calls } = setup(() => json(200, { status: 'ok' }))
    await client.GET('/healthz')
    expect(calls[0]?.headers.has('Authorization')).toBe(false)
  })

  it('signs in again on 401 and repeats the request, body included', async () => {
    const { client, calls, refreshToken } = setup((req) =>
      req.headers.get('Authorization') === 'Bearer new' ? json(200, user) : json(401, {}),
    )

    const { data, response } = await client.PATCH('/me/settings', { body: { slot_minutes: 15 } })

    expect(response.status).toBe(200)
    expect(data?.display_name).toBe('Ann')
    expect(refreshToken).toHaveBeenCalledTimes(1)
    expect(calls).toHaveLength(2)
    expect(await calls[1]?.text()).toBe(JSON.stringify({ slot_minutes: 15 }))
  })

  it('retries only once', async () => {
    const { client, calls, refreshToken } = setup(() => json(401, {}))
    const { response } = await client.GET('/me')
    expect(response.status).toBe(401)
    expect(refreshToken).toHaveBeenCalledTimes(1)
    expect(calls).toHaveLength(2)
  })

  it('returns the 401 when signing in again is impossible', async () => {
    const { client, calls, refreshToken } = setup(() => json(401, {}))
    refreshToken.mockResolvedValueOnce(null)
    const { response } = await client.GET('/me')
    expect(response.status).toBe(401)
    expect(calls).toHaveLength(1)
  })

  it('does not sign in again when a login request itself gets 401', async () => {
    const { client, refreshToken } = setup(() => json(401, { code: 'invalid_init_data' }))
    await client.POST('/auth/telegram', { body: { init_data: 'x', timezone: 'UTC' } })
    expect(refreshToken).not.toHaveBeenCalled()
  })
})
