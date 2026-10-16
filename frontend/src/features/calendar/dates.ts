import { TZDate } from '@date-fns/tz'
import type { ViewMode } from '@/api/types'

/** A calendar date in the user's time zone, "yyyy-MM-dd". */
export type Day = string

const pad = (n: number) => String(n).padStart(2, '0')

function parseDay(day: Day): { y: number; m: number; d: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  if (!match) throw new Error(`Invalid day: ${day}`)
  return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) }
}

export function formatDay(y: number, m: number, d: number): Day {
  return `${y}-${pad(m)}-${pad(d)}`
}

/** Today's date in the time zone. */
export function todayIn(tz: string, now: Date = new Date()): Day {
  const t = new TZDate(now.getTime(), tz)
  return formatDay(t.getFullYear(), t.getMonth() + 1, t.getDate())
}

/** The date `n` days after `day` (negative: before). Pure calendar arithmetic. */
export function addDays(day: Day, n: number): Day {
  const { y, m, d } = parseDay(day)
  const t = new Date(Date.UTC(y, m - 1, d + n))
  return formatDay(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate())
}

/** Day of the week: 0 = Monday … 6 = Sunday. */
export function weekdayIndex(day: Day): number {
  const { y, m, d } = parseDay(day)
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7
}

/** The Monday of the week that contains `day`. */
export function weekStart(day: Day): Day {
  return addDays(day, -weekdayIndex(day))
}

/** The instant of the local midnight that starts `day` in the time zone. */
export function dayStart(day: Day, tz: string): Date {
  const { y, m, d } = parseDay(day)
  return new Date(new TZDate(y, m - 1, d, tz).getTime())
}

/** Days shown for the view around the anchor date. */
export function visibleDays(view: ViewMode, anchor: Day): Day[] {
  switch (view) {
    case 'day':
      return [anchor]
    case 'three_days':
      return [addDays(anchor, -1), anchor, addDays(anchor, 1)]
    case 'week': {
      const monday = weekStart(anchor)
      return Array.from({ length: 7 }, (_, i) => addDays(monday, i))
    }
  }
}

/** Anchor date after pressing "previous" (-1) or "next" (+1). */
export function shiftAnchor(view: ViewMode, anchor: Day, direction: -1 | 1): Day {
  const step = view === 'day' ? 1 : view === 'three_days' ? 3 : 7
  return addDays(anchor, direction * step)
}

/** [from, to) covering all the days, as instants. */
export function dayRange(days: readonly Day[], tz: string): { from: Date; to: Date } {
  const first = days[0]
  const last = days[days.length - 1]
  if (!first || !last) throw new Error('dayRange needs at least one day')
  return { from: dayStart(first, tz), to: dayStart(addDays(last, 1), tz) }
}

const ruWeekday = new Intl.DateTimeFormat('ru', { weekday: 'short', timeZone: 'UTC' })
const ruDayMonth = new Intl.DateTimeFormat('ru', {
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
})
const ruDayMonthYear = new Intl.DateTimeFormat('ru', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
})
const ruFull = new Intl.DateTimeFormat('ru', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
})

function utcDate(day: Day): Date {
  const { y, m, d } = parseDay(day)
  return new Date(Date.UTC(y, m - 1, d))
}

export const weekdayLabel = (day: Day) => ruWeekday.format(utcDate(day))
export const dayMonthLabel = (day: Day) => ruDayMonth.format(utcDate(day))
export const fullDayLabel = (day: Day) => ruFull.format(utcDate(day))

/**
 * Title for the visible range, short enough for a phone header:
 * "14 окт." for a day, "13 – 15 окт." within a month, "26.10 – 01.11" across months.
 * The year is added when the range is not within `currentYear` ("14 окт. 2027",
 * "28.12.26 – 03.01.27"), so that paging to a distant date stays unambiguous.
 */
export function rangeLabel(days: readonly Day[], currentYear?: number): string {
  const first = days[0]
  const last = days[days.length - 1]
  if (!first || !last) return ''
  const otherYear =
    currentYear !== undefined &&
    (Number(first.slice(0, 4)) !== currentYear || Number(last.slice(0, 4)) !== currentYear)

  if (first === last)
    return otherYear ? ruDayMonthYear.format(utcDate(first)) : dayMonthLabel(first)
  if (first.slice(0, 7) === last.slice(0, 7)) {
    const tail = otherYear ? ruDayMonthYear.format(utcDate(last)) : dayMonthLabel(last)
    return `${Number(first.slice(8))} – ${tail}`
  }
  const numeric = (day: Day) =>
    `${day.slice(8)}.${day.slice(5, 7)}${otherYear ? `.${day.slice(2, 4)}` : ''}`
  return `${numeric(first)} – ${numeric(last)}`
}
