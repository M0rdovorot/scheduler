import { TZDate } from '@date-fns/tz'

const pad = (n: number) => String(n).padStart(2, '0')

/** An instant as the value of an <input type="datetime-local"> in the time zone. */
export function toLocalInput(instant: Date, tz: string): string {
  const t = new TZDate(instant.getTime(), tz)
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}T${pad(t.getHours())}:${pad(t.getMinutes())}`
}

/**
 * The instant for a datetime-local value read in the time zone, or null if the
 * text is not a valid date and time. A time that does not exist because the
 * clocks jump forward is moved ahead by the length of the jump.
 */
export function fromLocalInput(value: string, tz: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value)
  if (!match) return null
  const [y, mo, d, h, mi] = match.slice(1).map(Number) as [number, number, number, number, number]
  // Years below 1000 would be read as 19xx by Date; they are typos anyway.
  if (y < 1000 || mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null

  // Reject dates like February 30th instead of silently rolling them over.
  const check = new Date(Date.UTC(y, mo - 1, d))
  if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null

  return new Date(new TZDate(y, mo - 1, d, h, mi, 0, tz).getTime())
}

const timeFormat = (tz: string) =>
  new Intl.DateTimeFormat('ru', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: tz,
  })
const dateFormat = (tz: string) =>
  new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'short', timeZone: tz })

/** "10:00–11:30", with dates when the task spans several days. */
export function formatTimeRange(start: Date, end: Date, tz: string): string {
  const time = timeFormat(tz)
  const date = dateFormat(tz)
  if (date.format(start) === date.format(end)) {
    return `${time.format(start)}–${time.format(end)}`
  }
  return `${date.format(start)}, ${time.format(start)} – ${date.format(end)}, ${time.format(end)}`
}
