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

/**
 * Returns the Telegram platform when the app runs inside a Mini App, or null
 * otherwise. The telegram-web-app.js script defines window.Telegram.WebApp in
 * any browser, so the presence of signed initData is what tells them apart.
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
