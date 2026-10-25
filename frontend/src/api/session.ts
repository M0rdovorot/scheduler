import { deviceTimeZone } from '@/lib/timezone'
import type { Platform, TelegramAuthData } from '@/platform'
import { useAuthStore } from './authStore'
import { api } from './client'
import type { Session, User } from './types'

/** Sign-in failed; the message is shown to the user. */
export class LoginError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LoginError'
  }
}

let inflight: Promise<Session> | null = null

/**
 * Signs in (Telegram init data in the Mini App, the dev endpoint in a plain
 * browser) and stores the token. Concurrent calls share one request.
 */
export function login(platform: Platform): Promise<Session> {
  inflight ??= doLogin(platform).finally(() => {
    inflight = null
  })
  return inflight
}

async function doLogin(platform: Platform): Promise<Session> {
  const timezone = deviceTimeZone()

  let result
  try {
    result = platform.initData
      ? await api.POST('/auth/telegram', { body: { init_data: platform.initData, timezone } })
      : await api.POST('/auth/dev', { body: { timezone } })
  } catch {
    throw new LoginError('Нет связи с сервером')
  }

  const { data, response } = result
  if (data) {
    useAuthStore.getState().setToken(data.token)
    return data
  }
  if (response.status === 404) {
    throw new LoginError(
      'Вход в браузере доступен только в режиме разработки. Откройте приложение в Telegram.',
    )
  }
  if (response.status === 401) {
    throw new LoginError('Telegram не подтвердил вход. Закройте приложение и откройте его снова.')
  }
  throw new LoginError('Не удалось войти')
}

/** Signs in on the web with the Login Widget data; the session goes to a cookie. */
export async function loginWithWidget(authData: TelegramAuthData): Promise<User> {
  let result
  try {
    result = await api.POST('/auth/telegram-widget', {
      body: { auth_data: authData, timezone: deviceTimeZone() },
    })
  } catch {
    throw new LoginError('Нет связи с сервером')
  }
  const { data, response } = result
  if (data) return data.user
  if (response.status === 401) {
    throw new LoginError('Telegram не подтвердил вход. Попробуйте ещё раз.')
  }
  throw new LoginError('Не удалось войти')
}

/** Ends the session on the server. */
export async function logout(): Promise<void> {
  const { response } = await api.POST('/auth/logout')
  // 401: the session is already gone, which is what we want.
  if (!response.ok && response.status !== 401) throw new Error('Не удалось выйти')
  useAuthStore.getState().setToken(null)
}
