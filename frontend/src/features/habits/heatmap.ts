import type { HabitDay } from '@/api/types'
import { addDays, weekStart, weekdayIndex, type Day } from '@/features/calendar/dates'

/** Weeks shown in the heat map of a habit. */
export const heatmapWeeks = 18

/** From the Monday `weeks` weeks ago to the Sunday of the current week. */
export function heatmapRange(today: Day, weeks = heatmapWeeks): { from: Day; to: Day } {
  const monday = weekStart(today)
  return { from: addDays(monday, -7 * (weeks - 1)), to: addDays(monday, 6) }
}

export interface HeatCell {
  date: Day
  value: number
  done: boolean
  /** 0 = nothing, 1..3 = part of the goal, 4 = done. */
  level: 0 | 1 | 2 | 3 | 4
  /** The day is not in the schedule of the habit. */
  off: boolean
  /** The day has not come yet. */
  future: boolean
}

export interface Heatmap {
  /** Columns are weeks, from the oldest; each has seven rows, Monday first. */
  weeks: (HeatCell | null)[][]
  /** A label above the first week of every month, by the month of the Monday of the week. */
  monthStarts: { week: number; month: number }[]
}

function levelOf(day: HabitDay, target: number): HeatCell['level'] {
  if (day.done) return 4
  if (day.value <= 0) return 0
  const ratio = day.value / Math.max(target, 1)
  return ratio < 1 / 3 ? 1 : ratio < 2 / 3 ? 2 : 3
}

/**
 * Lays the days out as weeks. A habit with a weekly goal has no planned days, so none is "off".
 */
export function buildHeatmap(
  days: readonly HabitDay[],
  target: number,
  today: Day,
  weekly: boolean,
): Heatmap {
  const weeks: (HeatCell | null)[][] = []
  const monthStarts: Heatmap['monthStarts'] = []

  for (const day of days) {
    const row = weekdayIndex(day.date)
    if (weeks.length === 0 || row === 0) weeks.push(Array<HeatCell | null>(7).fill(null))
    const column = weeks.length - 1
    weeks[column]![row] = {
      date: day.date,
      value: day.value,
      done: day.done,
      level: levelOf(day, target),
      off: !weekly && !day.planned && day.value === 0,
      future: day.date > today,
    }
  }

  let lastMonth = -1
  weeks.forEach((cells, week) => {
    const first = cells.find((c) => c !== null)
    if (!first) return
    // The month of the column is the one of its first day; a month that only has its tail in
    // the first column is labelled by the next column instead.
    const monday = cells[0]?.date ?? first.date
    const month = Number(monday.slice(5, 7))
    if (month !== lastMonth) {
      monthStarts.push({ week, month })
      lastMonth = month
    }
  })
  return { weeks, monthStarts }
}

export const monthNames = [
  'янв',
  'фев',
  'мар',
  'апр',
  'май',
  'июн',
  'июл',
  'авг',
  'сен',
  'окт',
  'ноя',
  'дек',
] as const
