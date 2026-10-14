import type { Middleware } from 'openapi-fetch'

export interface AuthMiddlewareOptions {
  getToken: () => string | null
  /** Signs in again and returns the new token, or null if that is impossible. */
  refreshToken: () => Promise<string | null>
  /** OpenAPI paths that need no session, e.g. '/auth/telegram'. */
  publicPaths: readonly string[]
}

/**
 * Adds the bearer token to requests. When the server answers 401 (the session
 * expired or was revoked) it signs in again and repeats the request once.
 */
export function createAuthMiddleware(opts: AuthMiddlewareOptions): Middleware {
  const isPublic = (schemaPath: string) => opts.publicPaths.includes(schemaPath)
  // A request body can be read only once, so keep a copy for the retry,
  // together with the token the request was sent with.
  const copies = new Map<string, { copy: Request; token: string | null }>()

  return {
    onRequest({ request, schemaPath, id }) {
      if (isPublic(schemaPath)) return
      const token = opts.getToken()
      if (token) request.headers.set('Authorization', `Bearer ${token}`)
      copies.set(id, { copy: request.clone(), token })
      return request
    },
    async onResponse({ response, schemaPath, id, options }) {
      const sent = copies.get(id)
      copies.delete(id)
      if (response.status !== 401 || !sent || isPublic(schemaPath)) return

      // If another request already signed in while this one was in flight,
      // reuse that session instead of creating one more.
      const current = opts.getToken()
      const token = current && current !== sent.token ? current : await opts.refreshToken()
      if (!token) return
      const { copy } = sent
      copy.headers.set('Authorization', `Bearer ${token}`)
      return (options.fetch ?? globalThis.fetch)(copy)
    },
    onError({ id }) {
      copies.delete(id)
    },
  }
}
