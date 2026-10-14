/** IANA time zone of the current device. */
export function deviceTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}

/**
 * True if the runtime recognises name as an IANA time zone. UTC offsets such
 * as "+03:00" are accepted by Intl but not by the server, so they are rejected.
 */
export function isValidTimeZone(name: string): boolean {
  if (!name || /^[+-]/.test(name)) return false
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: name })
    return true
  } catch {
    return false
  }
}

/** All time zones the runtime knows; empty if it cannot list them. */
export function listTimeZones(): string[] {
  return typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : []
}
