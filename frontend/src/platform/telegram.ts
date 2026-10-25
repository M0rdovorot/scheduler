// The only module allowed to touch window.Telegram (enforced by ESLint).
import type { HapticImpact, HapticNotification, Platform, PlatformTheme } from './types'

interface TelegramThemeParams {
  bg_color?: string
  text_color?: string
  hint_color?: string
  link_color?: string
  button_color?: string
  button_text_color?: string
  secondary_bg_color?: string
  section_separator_color?: string
  destructive_text_color?: string
}

interface TelegramWebApp {
  initData: string
  colorScheme: 'light' | 'dark'
  themeParams: TelegramThemeParams
  ready(): void
  expand(): void
  disableVerticalSwipes?(): void
  isVersionAtLeast(version: string): boolean
  onEvent(event: 'themeChanged', handler: () => void): void
  offEvent(event: 'themeChanged', handler: () => void): void
  requestWriteAccess?(callback: (allowed: boolean) => void): void
  BackButton: {
    show(): void
    hide(): void
    onClick(handler: () => void): void
    offClick(handler: () => void): void
  }
  HapticFeedback: {
    impactOccurred(style: HapticImpact): void
    notificationOccurred(type: HapticNotification): void
    selectionChanged(): void
  }
}

/** Fields Telegram's web sign-in returns: id, first_name, auth_date, hash, … */
export type TelegramAuthData = Record<string, string>

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp }
  }
}

/** Maps Telegram's palette to the platform-neutral theme. */
export function mapTelegramTheme(
  params: TelegramThemeParams,
  colorScheme: 'light' | 'dark',
): PlatformTheme {
  return {
    colorScheme,
    bg: params.bg_color,
    fg: params.text_color,
    hint: params.hint_color,
    link: params.link_color,
    accent: params.button_color,
    accentFg: params.button_text_color,
    surface: params.secondary_bg_color,
    separator: params.section_separator_color,
    danger: params.destructive_text_color,
  }
}

const webAppScript = 'https://telegram.org/js/telegram-web-app.js'

/**
 * Whether Telegram opened this page as a Mini App. Telegram passes the launch
 * parameters in the hash; after a reload inside Telegram the hash is gone, but
 * telegram-web-app.js has kept them in sessionStorage.
 */
export function isTelegramLaunch(hash: string, stored: string | null): boolean {
  if (new URLSearchParams(hash.replace(/^#/, '')).has('tgWebAppData')) return true
  try {
    const params = JSON.parse(stored ?? 'null') as { tgWebAppData?: unknown } | null
    return typeof params?.tgWebAppData === 'string' && params.tgWebAppData !== ''
  } catch {
    return false
  }
}

function storedLaunchParams(): string | null {
  try {
    return sessionStorage.getItem('__telegram__initParams')
  } catch {
    return null
  }
}

/**
 * Loads telegram-web-app.js, but only inside Telegram: in a plain browser the
 * script is not needed, and where telegram.org is blocked it would hold up the
 * page. Resolves when the script has loaded, failed, or timed out.
 */
export function loadTelegramWebApp(timeoutMs = 10_000): Promise<void> {
  if (!isTelegramLaunch(location.hash, storedLaunchParams())) return Promise.resolve()
  return new Promise((resolve) => {
    const script = document.createElement('script')
    script.src = webAppScript
    script.onload = script.onerror = () => resolve()
    setTimeout(resolve, timeoutMs)
    document.head.append(script)
  })
}

/**
 * Returns the Telegram platform when the app runs inside a Mini App, or null
 * otherwise (also when telegram-web-app.js did not load). Call it after
 * loadTelegramWebApp.
 */
export function createTelegramPlatform(): Platform | null {
  const app = window.Telegram?.WebApp
  if (!app?.initData) return null

  const supports = (version: string) => app.isVersionAtLeast(version)
  const theme = () => mapTelegramTheme(app.themeParams, app.colorScheme)

  return {
    kind: 'telegram',
    initData: app.initData,
    init() {
      app.ready()
      app.expand()
      // Without this, dragging the grid down closes the Mini App.
      if (supports('7.7')) app.disableVerticalSwipes?.()
    },
    getTheme: theme,
    onThemeChange(listener) {
      const handler = () => listener(theme())
      app.onEvent('themeChanged', handler)
      return () => app.offEvent('themeChanged', handler)
    },
    showBackButton(onClick) {
      if (!supports('6.1')) return () => {}
      app.BackButton.onClick(onClick)
      app.BackButton.show()
      return () => {
        app.BackButton.offClick(onClick)
        app.BackButton.hide()
      }
    },
    haptic: {
      impact(style) {
        if (supports('6.1')) app.HapticFeedback.impactOccurred(style)
      },
      notify(type) {
        if (supports('6.1')) app.HapticFeedback.notificationOccurred(type)
      },
      selection() {
        if (supports('6.1')) app.HapticFeedback.selectionChanged()
      },
    },
    requestWriteAccess() {
      const request = app.requestWriteAccess
      if (!supports('6.9') || !request) return Promise.resolve(false)
      return new Promise((resolve) => request.call(app, resolve))
    },
  }
}

const oauthOrigin = 'https://oauth.telegram.org'
const authResultParam = /[#?&]tgAuthResult=([A-Za-z0-9_=-]*)$/

/**
 * Leaves for Telegram's sign-in page in the same tab (no third-party script,
 * no popup to be blocked). Telegram comes back to this page with the signed
 * fields in the hash; takeTelegramAuthResult reads them. Also asks to let the
 * bot write to the user, so that reminders reach them.
 */
export function startTelegramLogin(botId: number): void {
  location.assign(telegramLoginUrl(botId, location.href))
}

/** Address of Telegram's sign-in page that comes back to returnTo. */
export function telegramLoginUrl(botId: number, returnTo: string): string {
  const back = new URL(returnTo)
  back.hash = ''
  const params = new URLSearchParams({
    bot_id: String(botId),
    origin: back.origin,
    request_access: 'write',
    lang: 'ru',
    return_to: back.href,
  })
  return `${oauthOrigin}/auth?${params}`
}

let authResult: TelegramAuthData | null | undefined

/**
 * The fields Telegram returned in the hash (#tgAuthResult=<base64url JSON>),
 * or null. The hash is removed on the first call; later calls return the
 * same value until clearTelegramAuthResult.
 */
export function takeTelegramAuthResult(): TelegramAuthData | null {
  if (authResult !== undefined) return authResult
  authResult = null
  const match = authResultParam.exec(location.hash)
  if (!match) return null
  history.replaceState(history.state, '', location.href.replace(/#.*$/, ''))
  try {
    let data = (match[1] ?? '').replace(/-/g, '+').replace(/_/g, '/')
    while (data.length % 4) data += '='
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0))
    const fields = JSON.parse(new TextDecoder().decode(bytes)) as
      Record<string, string | number> | false
    // The server checks the signature over the fields exactly as sent.
    if (fields) {
      authResult = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, String(v)]))
    }
  } catch {
    // Not something Telegram produced; ignore it.
  }
  return authResult
}

export function clearTelegramAuthResult(): void {
  authResult = undefined
}
