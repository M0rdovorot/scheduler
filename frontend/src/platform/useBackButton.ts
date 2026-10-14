import { useEffect } from 'react'
import { usePlatform } from './context'

/** Shows the host's back button while `active` is true. */
export function useBackButton(active: boolean, onClick: () => void) {
  const platform = usePlatform()
  useEffect(() => {
    if (!active) return
    return platform.showBackButton(onClick)
  }, [platform, active, onClick])
}
