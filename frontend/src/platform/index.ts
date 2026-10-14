import { createBrowserPlatform } from './browser'
import { createTelegramPlatform } from './telegram'
import type { Platform } from './types'

export type { Platform, PlatformTheme } from './types'

export function detectPlatform(): Platform {
  return createTelegramPlatform() ?? createBrowserPlatform()
}
