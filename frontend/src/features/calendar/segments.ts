import { TZDate } from '@date-fns/tz'
import { differenceInCalendarDays } from 'date-fns'
import { dayStart, type Day } from './dates'

export const minutesPerDay = 24 * 60

/** The part of a task that falls on one day. Minutes count from local midnight. */
export interface Segment {
  startMin: number
  endMin: number
  /** The task began on an earlier day. */
  continuesBefore: boolean
  /** The task ends on a later day. */
  continuesAfter: boolean
}

/**
 * Minutes from the local midnight of `day` to the instant, by the wall clock of
 * the time zone (so 10:00 is always 600, also on days when the clocks change).
 * Instants on earlier or later days give negative values or more than 1440.
 */
export function wallMinutes(instant: Date, day: Day, tz: string): number {
  const wall = new TZDate(instant.getTime(), tz)
  const midnight = new TZDate(dayStart(day, tz).getTime(), tz)
  const days = differenceInCalendarDays(wall, midnight)
  return days * minutesPerDay + wall.getHours() * 60 + wall.getMinutes() + wall.getSeconds() / 60
}

/** The slice of [start, end) that lies on `day`, or null if it does not touch it. */
export function segmentOnDay(start: Date, end: Date, day: Day, tz: string): Segment | null {
  const from = wallMinutes(start, day, tz)
  const to = wallMinutes(end, day, tz)
  if (to <= 0 || from >= minutesPerDay) return null
  return {
    startMin: Math.max(0, from),
    endMin: Math.min(minutesPerDay, to),
    continuesBefore: from < 0,
    continuesAfter: to > minutesPerDay,
  }
}
