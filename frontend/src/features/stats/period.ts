import { addDays, dayRange, weekStart, type Day } from '@/features/calendar/dates'

export type PeriodKind = 'day' | 'week' | 'month' | 'custom'

export interface Period {
  kind: PeriodKind
  /** Any date inside the period; the period is the day, week or month around it. */
  anchor: Day
  /** The first and last day (both included) of a custom period. */
  customFrom: Day
  customTo: Day
}

/** The longest period the server reports. */
export const maxPeriodDays = 366

export function newPeriod(kind: PeriodKind, anchor: Day): Period {
  return { kind, anchor, customFrom: anchor, customTo: anchor }
}

const pad = (n: number) => String(n).padStart(2, '0')

function daysInMonth(day: Day): number {
  return new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)), 0)).getUTCDate()
}

/** The first and the last day of the period, both included. */
export function periodDays(period: Period): { first: Day; last: Day } {
  switch (period.kind) {
    case 'day':
      return { first: period.anchor, last: period.anchor }
    case 'week': {
      const first = weekStart(period.anchor)
      return { first, last: addDays(first, 6) }
    }
    case 'month': {
      const first = `${period.anchor.slice(0, 7)}-01`
      return { first, last: `${period.anchor.slice(0, 7)}-${pad(daysInMonth(period.anchor))}` }
    }
    case 'custom':
      return { first: period.customFrom, last: period.customTo }
  }
}

/** [from, to) as instants, from the local midnight of the first day to that of the day after the last. */
export function periodRange(period: Period, tz: string): { from: Date; to: Date } {
  const { first, last } = periodDays(period)
  return dayRange([first, last], tz)
}

/** The previous (-1) or next (+1) day, week or month; a custom period moves by its own length. */
export function shiftPeriod(period: Period, direction: -1 | 1): Period {
  switch (period.kind) {
    case 'day':
      return { ...period, anchor: addDays(period.anchor, direction) }
    case 'week':
      return { ...period, anchor: addDays(period.anchor, 7 * direction) }
    case 'month': {
      const year = Number(period.anchor.slice(0, 4))
      const month = Number(period.anchor.slice(5, 7)) - 1 + direction
      const date = new Date(Date.UTC(year, month, 1))
      return {
        ...period,
        anchor: `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-01`,
      }
    }
    case 'custom': {
      const length = customLength(period.customFrom, period.customTo)
      return {
        ...period,
        customFrom: addDays(period.customFrom, length * direction),
        customTo: addDays(period.customTo, length * direction),
      }
    }
  }
}

/** Number of days from `from` to `to`, both included. */
export function customLength(from: Day, to: Day): number {
  const ms =
    Date.UTC(Number(to.slice(0, 4)), Number(to.slice(5, 7)) - 1, Number(to.slice(8))) -
    Date.UTC(Number(from.slice(0, 4)), Number(from.slice(5, 7)) - 1, Number(from.slice(8)))
  return Math.round(ms / 86_400_000) + 1
}

/** A message when a custom period cannot be reported, or null. */
export function customError(from: Day, to: Day): string | null {
  const ok = /^\d{4}-\d{2}-\d{2}$/
  if (!ok.test(from) || !ok.test(to)) return 'Укажите обе даты'
  if (to < from) return 'Конец периода раньше начала'
  if (customLength(from, to) > maxPeriodDays) return `Период не длиннее ${maxPeriodDays} дней`
  return null
}

const monthFormat = new Intl.DateTimeFormat('ru', {
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
})
const dayFormat = new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'long', timeZone: 'UTC' })
const dayYearFormat = new Intl.DateTimeFormat('ru', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
})

const utc = (day: Day) =>
  new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8))))

/** Title of the period: "14 октября", "12 – 18 окт.", "октябрь 2026", "01.10 – 20.10". */
export function periodLabel(period: Period, currentYear: number): string {
  const { first, last } = periodDays(period)
  if (period.kind === 'month') return monthFormat.format(utc(first))
  if (first === last) {
    return Number(first.slice(0, 4)) === currentYear
      ? dayFormat.format(utc(first))
      : dayYearFormat.format(utc(first))
  }
  const sameYear = first.slice(0, 4) === last.slice(0, 4)
  const num = (d: Day) =>
    `${d.slice(8)}.${d.slice(5, 7)}${sameYear && Number(d.slice(0, 4)) === currentYear ? '' : `.${d.slice(2, 4)}`}`
  if (first.slice(0, 7) === last.slice(0, 7) && Number(first.slice(0, 4)) === currentYear) {
    return `${Number(first.slice(8))} – ${dayFormat.format(utc(last))}`
  }
  return `${num(first)} – ${num(last)}`
}
