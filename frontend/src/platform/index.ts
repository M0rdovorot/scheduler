import { createBrowserPlatform } from './browser'
import { createTelegramPlatform, loadTelegramWebApp } from './telegram'
import type { Platform } from './types'

export type { Platform, PlatformTheme } from './types'
export {
  clearTelegramAuthResult,
  startTelegramLogin,
  takeTelegramAuthResult,
  type TelegramAuthData,
} from './telegram'

export async function detectPlatform(): Promise<Platform> {
  await loadTelegramWebApp()
  return createTelegramPlatform() ?? createBrowserPlatform()
}
