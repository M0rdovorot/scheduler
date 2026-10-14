/** Normalised theme colors; each platform maps its own palette to these. */
export interface PlatformTheme {
  colorScheme: 'light' | 'dark'
  bg?: string
  fg?: string
  hint?: string
  link?: string
  accent?: string
  accentFg?: string
  surface?: string
  separator?: string
  danger?: string
}

export type HapticImpact = 'light' | 'medium' | 'heavy' | 'rigid' | 'soft'
export type HapticNotification = 'error' | 'success' | 'warning'

/**
 * Everything the app needs from the host (Telegram Mini App today, the
 * browser tomorrow). Feature code depends on this interface only.
 */
export interface Platform {
  readonly kind: 'telegram' | 'browser'
  /** Raw signed init data for server-side auth; null outside Telegram. */
  readonly initData: string | null
  /** Called once at startup: signals readiness, expands the view, etc. */
  init(): void
  getTheme(): PlatformTheme
  /** Subscribes to theme changes; returns an unsubscribe function. */
  onThemeChange(listener: (theme: PlatformTheme) => void): () => void
  /** Shows the host's back button; returns a function that hides it again. */
  showBackButton(onClick: () => void): () => void
  haptic: {
    impact(style: HapticImpact): void
    notify(type: HapticNotification): void
    selection(): void
  }
  /** Asks the user to let the bot write to them; resolves to the answer. */
  requestWriteAccess(): Promise<boolean>
}
