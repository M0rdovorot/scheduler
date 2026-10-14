// Import this module before anything that imports '@/api/client': openapi-fetch
// captures fetch when the client is created.
import { vi } from 'vitest'

export interface StubRequest {
  method: string
  /** Path without the /api/v1 prefix, e.g. "/categories/abc". */
  path: string
  body: unknown
  auth: string | null
}

type Handler = (req: StubRequest) => Response | Promise<Response>

export const net: { handler: Handler; calls: StubRequest[] } = {
  handler: () => new Response(null, { status: 500 }),
  calls: [],
}

vi.stubGlobal('fetch', async (input: Request) => {
  const text = await input.clone().text()
  const call: StubRequest = {
    method: input.method,
    path: new URL(input.url).pathname.replace(/^\/api\/v1/, ''),
    body: text ? (JSON.parse(text) as unknown) : undefined,
    auth: input.headers.get('Authorization'),
  }
  net.calls.push(call)
  return net.handler(call)
})

export const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

export const noContent = () => new Response(null, { status: 204 })
