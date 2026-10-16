import type { Category, StatsDay } from '@/api/types'
import { addDays, weekStart, type Day } from '@/features/calendar/dates'

/** At most this many series get a color of their own; the rest is folded into "Other". */
export const maxSeries = 8

/** Past this many days the chart shows weeks instead of days. */
export const maxDayColumns = 62

export type SeriesKind = 'category' | 'uncategorized' | 'other'

export interface Series {
  id: string
  name: string
  /** The category's own color; neutral for "no category" and "other". */
  color: string
  kind: SeriesKind
  minutes: number
}

export interface Segment {
  seriesId: string
  minutes: number
}

export interface Column {
  /** The local date, or the Monday of a week when days are grouped. */
  date: Day
  /** The last day when the column is a week. */
  endDate?: Day
  total: number
  /** Busy time of the column with parallel tasks counted once. */
  busy: number
  segments: Segment[]
}

export const uncategorizedId = 'uncategorized'
export const otherId = 'other'

/** Neutral colors: tints of the hint color, so that they follow the theme. */
export const neutralColors = {
  uncategorized: 'color-mix(in srgb, var(--app-hint) 60%, var(--app-bg))',
  other: 'color-mix(in srgb, var(--app-hint) 32%, var(--app-bg))',
}

/** Sums of one week, for a long period: the days are grouped by their Monday. */
export function groupByWeek(days: readonly StatsDay[]): StatsDay[] {
  const weeks = new Map<Day, StatsDay>()
  for (const day of days) {
    const key = weekStart(day.date)
    let week = weeks.get(key)
    if (!week) {
      week = { date: key, minutes: 0, by_category: [] }
      weeks.set(key, week)
    }
    week.minutes += day.minutes
    for (const part of day.by_category) {
      const existing = week.by_category.find((c) => c.category_id === part.category_id)
      if (existing) existing.minutes += part.minutes
      else week.by_category.push({ ...part })
    }
  }
  return [...weeks.values()]
}

/**
 * Columns and series of the chart. Series are ranked by their time over the whole
 * period: the top `maxSeries` keep their own color (the category's), everything
 * after that is folded into one neutral "Other". A color follows its category, so
 * it does not depend on the rank. Tasks without a category are a series of their own.
 */
export function buildChart(
  days: readonly StatsDay[],
  categories: readonly Category[],
  labels: { uncategorized: string; other: string },
): { columns: Column[]; series: Series[] } {
  const byId = new Map(categories.map((c) => [c.id, c]))
  const grouped = days.length > maxDayColumns
  const source = grouped ? groupByWeek(days) : days

  const totals = new Map<string, number>()
  for (const day of source) {
    for (const part of day.by_category) {
      const id = part.category_id ?? uncategorizedId
      totals.set(id, (totals.get(id) ?? 0) + part.minutes)
    }
  }

  const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  const kept = new Set(ranked.slice(0, maxSeries).map(([id]) => id))
  const folded = ranked.length > maxSeries
  // With a tail, one slot goes to "Other": keep one fewer real series.
  if (folded) kept.delete(ranked[maxSeries - 1]![0])

  const series: Series[] = []
  let otherMinutes = 0
  for (const [id, minutes] of ranked) {
    if (!kept.has(id)) {
      otherMinutes += minutes
      continue
    }
    if (id === uncategorizedId) {
      series.push({
        id,
        name: labels.uncategorized,
        color: neutralColors.uncategorized,
        kind: 'uncategorized',
        minutes,
      })
      continue
    }
    const category = byId.get(id)
    series.push({
      id,
      name: category?.name ?? '—',
      color: category?.color ?? neutralColors.uncategorized,
      kind: 'category',
      minutes,
    })
  }
  if (otherMinutes > 0) {
    series.push({
      id: otherId,
      name: labels.other,
      color: neutralColors.other,
      kind: 'other',
      minutes: otherMinutes,
    })
  }

  const order = new Map(series.map((s, i) => [s.id, i]))
  const columns: Column[] = source.map((day) => {
    const segments = new Map<string, number>()
    for (const part of day.by_category) {
      const id = part.category_id ?? uncategorizedId
      const target = kept.has(id) ? id : otherId
      segments.set(target, (segments.get(target) ?? 0) + part.minutes)
    }
    const list = [...segments.entries()]
      .map(([seriesId, minutes]) => ({ seriesId, minutes }))
      .sort((a, b) => (order.get(a.seriesId) ?? 99) - (order.get(b.seriesId) ?? 99))
    return {
      date: day.date,
      endDate: grouped ? addDays(day.date, 6) : undefined,
      total: list.reduce((sum, s) => sum + s.minutes, 0),
      busy: day.minutes,
      segments: list,
    }
  })
  return { columns, series }
}

const steps = [15, 30, 60, 120, 180, 240, 360, 480, 720, 1440, 2880, 5760]

/** Round tick values for a minutes axis: the largest column fits under the top tick. */
export function niceTicks(maxMinutes: number): { ticks: number[]; max: number } {
  if (maxMinutes <= 0) return { ticks: [0, 60], max: 60 }
  const step = steps.find((s) => maxMinutes / s <= 4) ?? steps[steps.length - 1]!
  const top = Math.ceil(maxMinutes / step) * step
  const ticks: number[] = []
  for (let t = 0; t <= top; t += step) ticks.push(t)
  return { ticks, max: top }
}

/** A short label of an axis tick: "0", "30 мин", "1 ч", "2 ч". */
export function tickLabel(minutes: number): string {
  if (minutes === 0) return '0'
  if (minutes < 60) return `${minutes} мин`
  return `${minutes / 60} ч`
}
