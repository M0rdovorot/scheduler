import type { Platform } from '@/platform'
import { createAuthMiddleware } from './authMiddleware'
import { useAuthStore } from './authStore'
import { api, publicPaths } from './client'
import { login } from './session'

/** Attaches session handling to the shared API client. Call once at startup. */
export function setupApi(platform: Platform) {
  api.use(
    createAuthMiddleware({
      getToken: () => useAuthStore.getState().token,
      refreshToken: () =>
        login(platform).then(
          (session) => session.token,
          () => {
            // Outside Telegram (and without dev auth) only the user can sign in again.
            if (!platform.initData) useAuthStore.getState().setSignedOut(true)
            return null
          },
        ),
      publicPaths,
    }),
  )
}
