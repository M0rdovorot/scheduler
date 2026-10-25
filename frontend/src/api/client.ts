import createClient from 'openapi-fetch'
import type { paths } from './schema.gen'

// An absolute URL, because Request (and so fetch) outside a browser rejects relative ones.
const baseUrl = typeof location === 'undefined' ? '/api/v1' : `${location.origin}/api/v1`

export const api = createClient<paths>({ baseUrl })

/** Endpoints that need no session; keep in sync with `security: []` in openapi.yaml. */
export const publicPaths = [
  '/healthz',
  '/auth/config',
  '/auth/telegram',
  '/auth/telegram-widget',
  '/auth/dev',
] as const
