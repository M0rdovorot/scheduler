/** IANA time zone of the current device. */
export function deviceTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}

/**
 * Returns the canonical spelling of an IANA time zone name, or null if the
 * runtime does not know it. Intl matches names case-insensitively while the
 * server does not, so callers must send the canonical form ("europe/moscow"
 * becomes "Europe/Moscow"). UTC offsets such as "+03:00" are accepted by Intl
 * but not by the server, so they are rejected.
 */
export function normalizeTimeZone(name: string): string | null {
  if (!name || /^[+-]/.test(name)) return null
  try {
    return new Intl.DateTimeFormat(undefined, { timeZone: name }).resolvedOptions().timeZone
  } catch {
    return null
  }
}

/** All time zones the runtime knows; empty if it cannot list them. */
export function listTimeZones(): string[] {
  return typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : []
}
