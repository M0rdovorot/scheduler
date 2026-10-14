import type { PlatformTheme } from './types'

const cssVars = {
  bg: '--app-bg',
  fg: '--app-fg',
  hint: '--app-hint',
  link: '--app-link',
  accent: '--app-accent',
  accentFg: '--app-accent-fg',
  surface: '--app-surface',
  separator: '--app-separator',
  danger: '--app-danger',
} as const satisfies Record<Exclude<keyof PlatformTheme, 'colorScheme'>, string>

/**
 * Writes the platform theme to CSS variables on the element. Colors the
 * platform does not provide are removed, so the defaults from index.css apply.
 */
export function applyTheme(theme: PlatformTheme, el: HTMLElement = document.documentElement) {
  el.dataset.theme = theme.colorScheme
  for (const [key, cssVar] of Object.entries(cssVars)) {
    const value = theme[key as keyof typeof cssVars]
    if (value) el.style.setProperty(cssVar, value)
    else el.style.removeProperty(cssVar)
  }
}
