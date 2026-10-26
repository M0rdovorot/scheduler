import type { FreeInterval } from '@/api/types'
import { addDays, type Day } from '@/features/calendar/dates'
import { formatMinutes } from '@/features/calendar/grid'
import { segmentOnDay } from '@/features/calendar/segments'

/** A free stretch of one local day, in minutes from its midnight. */
export interface DaySlot {
  startMin: number
  endMin: number
}

export interface DayFree {
  day: Day
  slots: DaySlot[]
}

export interface FreeFilter {
  /** Shortest stretch to show, in minutes. */
  minMinutes: number
  /** Only the part of the day between these minutes from midnight is counted. */
  fromMin: number
  toMin: number
}

/**
 * The free time cut into local days and cut to the hours the person is awake, without the
 * stretches that became too short. Days with nothing left are not listed. A stretch that
 * crosses midnight is listed in each of the days it touches.
 */
export function freeByDay(
  free: readonly FreeInterval[],
  days: readonly Day[],
  tz: string,
  filter: FreeFilter,
): DayFree[] {
  const out: DayFree[] = []
  for (const day of days) {
    const slots: DaySlot[] = []
    for (const f of free) {
      const seg = segmentOnDay(new Date(f.start), new Date(f.end), day, tz)
      if (!seg) continue
      const startMin = Math.max(seg.startMin, filter.fromMin)
      const endMin = Math.min(seg.endMin, filter.toMin)
      if (endMin - startMin >= filter.minMinutes && endMin > startMin) {
        slots.push({ startMin, endMin })
      }
    }
    if (slots.length > 0) out.push({ day, slots })
  }
  return out
}

/** The days from `first`, `count` of them. */
export function daysFrom(first: Day, count: number): Day[] {
  return Array.from({ length: count }, (_, i) => addDays(first, i))
}

/** "3 ч 30 мин", "45 мин", "2 ч". */
export function formatDuration(minutes: number): string {
  const total = Math.round(minutes)
  const h = Math.floor(total / 60)
  const m = total % 60
  if (h === 0) return `${m} мин`
  return m === 0 ? `${h} ч` : `${h} ч ${m} мин`
}

export function formatSlot(slot: DaySlot): string {
  return `${formatMinutes(slot.startMin)}–${formatMinutes(slot.endMin)}`
}

/** "09:00" → 540; null for anything else. */
export function parseTimeOfDay(text: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(text)
  return match ? Number(match[1]) * 60 + Number(match[2]) : null
}
