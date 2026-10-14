import { createContext, useContext } from 'react'
import type { Platform } from './types'

export const PlatformContext = createContext<Platform | null>(null)

export function usePlatform(): Platform {
  const platform = useContext(PlatformContext)
  if (!platform) throw new Error('usePlatform must be used inside PlatformContext.Provider')
  return platform
}
