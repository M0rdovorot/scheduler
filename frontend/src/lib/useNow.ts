import { useEffect, useState } from 'react'

/** The current time, refreshed every `everyMs` milliseconds. */
export function useNow(everyMs = 30_000): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), everyMs)
    return () => window.clearInterval(id)
  }, [everyMs])
  return now
}
