import type { Platform, PlatformTheme } from './types'

const darkQuery = '(prefers-color-scheme: dark)'

/** Platform for a regular browser: dev mode today, the web version later. */
export function createBrowserPlatform(): Platform {
  const theme = (): PlatformTheme => ({
    colorScheme: window.matchMedia(darkQuery).matches ? 'dark' : 'light',
  })

  return {
    kind: 'browser',
    initData: null,
    init() {},
    getTheme: theme,
    onThemeChange(listener) {
      const media = window.matchMedia(darkQuery)
      const handler = () => listener(theme())
      media.addEventListener('change', handler)
      return () => media.removeEventListener('change', handler)
    },
    showBackButton() {
      // The browser has its own back button.
      return () => {}
    },
    haptic: { impact() {}, notify() {}, selection() {} },
    requestWriteAccess: () => Promise.resolve(false),
  }
}
