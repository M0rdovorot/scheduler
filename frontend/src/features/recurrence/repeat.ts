import { addDays, dayStart, todayIn, weekdayIndex, type Day } from '@/features/calendar/dates'

export type Freq = 'daily' | 'weekly' | 'monthly' | 'yearly'

/** How a monthly repeat picks its day: the day of the month, the n-th weekday, or the last weekday. */
export type MonthlyMode = 'monthday' | 'nth' | 'last'

export type RepeatEnd =
  { kind: 'never' } | { kind: 'until'; day: Day } | { kind: 'count'; count: number }

/** The form model of a repeat rule (FR-4.1). "No repeat" is represented by null elsewhere. */
export interface Repeat {
  freq: Freq
  /** "Every N days/weeks/months/years". */
  interval: number
  /** Weekly only: 0 = Monday … 6 = Sunday, ascending. */
  weekdays: number[]
  /** Monthly only. */
  monthly: MonthlyMode
  end: RepeatEnd
}

export const maxInterval = 999
export const maxCount = 1000

const weekdayCodes = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const
const freqCodes: Record<Freq, string> = {
  daily: 'DAILY',
  weekly: 'WEEKLY',
  monthly: 'MONTHLY',
  yearly: 'YEARLY',
}

function dayOfMonth(day: Day): number {
  return Number(day.slice(8))
}

function daysInMonth(day: Day): number {
  return new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)), 0)).getUTCDate()
}

/** Which weekday of the month the start date is: 1 = first … 5 = fifth. */
export function nthWeekdayOfMonth(day: Day): number {
  return Math.ceil(dayOfMonth(day) / 7)
}

/** True if no later date of the month falls on the same weekday. */
export function isLastWeekdayOfMonth(day: Day): boolean {
  return dayOfMonth(day) + 7 > daysInMonth(day)
}

/**
 * The monthly modes that make sense for a start date. A fifth weekday is always
 * the last one, so it is offered as "last" only.
 */
export function monthlyModes(startDay: Day): MonthlyMode[] {
  const modes: MonthlyMode[] = ['monthday']
  if (nthWeekdayOfMonth(startDay) <= 4) modes.push('nth')
  if (isLastWeekdayOfMonth(startDay)) modes.push('last')
  return modes
}

/** A rule with defaults for the frequency, anchored to the start date. */
export function defaultRepeat(freq: Freq, startDay: Day): Repeat {
  return {
    freq,
    interval: 1,
    weekdays: freq === 'weekly' ? [weekdayIndex(startDay)] : [],
    monthly: 'monthday',
    end: { kind: 'never' },
  }
}

/** Switches the frequency, keeping the interval and the end and resetting what no longer applies. */
export function withFreq(repeat: Repeat, freq: Freq, startDay: Day): Repeat {
  const fresh = defaultRepeat(freq, startDay)
  return { ...fresh, interval: repeat.interval, end: repeat.end }
}

export type RepeatErrors = Partial<Record<'interval' | 'weekdays' | 'end', string>>

export function validateRepeat(repeat: Repeat, startDay: Day): RepeatErrors {
  const errors: RepeatErrors = {}
  if (!Number.isInteger(repeat.interval) || repeat.interval < 1 || repeat.interval > maxInterval) {
    errors.interval = `Число от 1 до ${maxInterval}`
  }
  if (repeat.freq === 'weekly' && repeat.weekdays.length === 0) {
    errors.weekdays = 'Выберите хотя бы один день недели'
  }
  const end = repeat.end
  if (
    end.kind === 'count' &&
    (!Number.isInteger(end.count) || end.count < 1 || end.count > maxCount)
  ) {
    errors.end = `Число повторов от 1 до ${maxCount}`
  }
  if (end.kind === 'until' && (!/^\d{4}-\d{2}-\d{2}$/.test(end.day) || end.day < startDay)) {
    errors.end = 'Дата окончания не может быть раньше начала'
  }
  return errors
}

const pad = (n: number) => String(n).padStart(2, '0')

/** "20261231T205959Z": the last moment of `day` in the zone, as UTC. */
export function untilFor(day: Day, tz: string): string {
  const last = new Date(dayStart(addDays(day, 1), tz).getTime() - 1000)
  return (
    `${last.getUTCFullYear()}${pad(last.getUTCMonth() + 1)}${pad(last.getUTCDate())}` +
    `T${pad(last.getUTCHours())}${pad(last.getUTCMinutes())}${pad(last.getUTCSeconds())}Z`
  )
}

function untilToDay(until: string, tz: string): Day | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(until)
  if (!m) return null
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ]
  return todayIn(tz, new Date(Date.UTC(y, mo - 1, d, h, mi, s)))
}

/** The RRULE value for a valid repeat that starts on `startDay` (a date in the zone). */
export function toRRule(repeat: Repeat, startDay: Day, tz: string): string {
  const parts = [`FREQ=${freqCodes[repeat.freq]}`]
  if (repeat.interval > 1) parts.push(`INTERVAL=${repeat.interval}`)

  if (repeat.freq === 'weekly') {
    const days = [...new Set(repeat.weekdays)].sort((a, b) => a - b)
    parts.push(`BYDAY=${days.map((d) => weekdayCodes[d]).join(',')}`)
  }
  if (repeat.freq === 'monthly') {
    const code = weekdayCodes[weekdayIndex(startDay)]
    if (repeat.monthly === 'monthday') parts.push(`BYMONTHDAY=${dayOfMonth(startDay)}`)
    else if (repeat.monthly === 'last') parts.push(`BYDAY=-1${code}`)
    else parts.push(`BYDAY=${nthWeekdayOfMonth(startDay)}${code}`)
  }

  if (repeat.end.kind === 'count') parts.push(`COUNT=${repeat.end.count}`)
  if (repeat.end.kind === 'until') parts.push(`UNTIL=${untilFor(repeat.end.day, tz)}`)
  return parts.join(';')
}

/**
 * Reads an RRULE back into the form model, or null if it is something the editor
 * cannot show (the rule is then displayed as is and left untouched).
 */
export function fromRRule(rrule: string, startDay: Day, tz: string): Repeat | null {
  const fields = new Map<string, string>()
  for (const part of rrule.split(';')) {
    const [key, value] = part.split('=')
    if (!key || !value || fields.has(key)) return null
    fields.set(key, value)
  }
  const freqEntry = Object.entries(freqCodes).find(([, code]) => code === fields.get('FREQ'))
  if (!freqEntry) return null
  const freq = freqEntry[0] as Freq

  const allowed = new Set(['FREQ', 'INTERVAL', 'BYDAY', 'BYMONTHDAY', 'COUNT', 'UNTIL'])
  if ([...fields.keys()].some((k) => !allowed.has(k))) return null

  const interval = fields.has('INTERVAL') ? Number(fields.get('INTERVAL')) : 1
  if (!Number.isInteger(interval) || interval < 1) return null

  const repeat = defaultRepeat(freq, startDay)
  repeat.interval = interval

  const byDay = fields.get('BYDAY')
  if (freq === 'weekly') {
    if (byDay) {
      const days = byDay
        .split(',')
        .map((c) => weekdayCodes.indexOf(c as (typeof weekdayCodes)[number]))
      if (days.some((d) => d < 0)) return null
      repeat.weekdays = [...new Set(days)].sort((a, b) => a - b)
    }
  } else if (freq === 'monthly') {
    if (byDay) {
      const m = /^(-1|[1-5])(MO|TU|WE|TH|FR|SA|SU)$/.exec(byDay)
      if (!m) return null
      repeat.monthly = m[1] === '-1' ? 'last' : 'nth'
    } else if (fields.has('BYMONTHDAY')) {
      repeat.monthly = 'monthday'
    }
  } else if (byDay) {
    return null
  }

  if (fields.has('COUNT')) {
    const count = Number(fields.get('COUNT'))
    if (!Number.isInteger(count)) return null
    repeat.end = { kind: 'count', count }
  }
  if (fields.has('UNTIL')) {
    const day = untilToDay(fields.get('UNTIL')!, tz)
    if (!day) return null
    repeat.end = { kind: 'until', day }
  }
  return repeat
}

/** True if the two rules describe the same RRULE for the start date. */
export function sameRepeat(a: Repeat | null, b: Repeat | null, startDay: Day, tz: string): boolean {
  if (a === null || b === null) return a === b
  return toRRule(a, startDay, tz) === toRRule(b, startDay, tz)
}

/** "день / дня / дней" for a number. */
export function plural(n: number, one: string, few: string, many: string): string {
  const mod100 = n % 100
  const mod10 = n % 10
  if (mod100 >= 11 && mod100 <= 14) return many
  if (mod10 === 1) return one
  if (mod10 >= 2 && mod10 <= 4) return few
  return many
}

const weekdayShort = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс']
export const weekdayShortNames: readonly string[] = weekdayShort

function endText(end: RepeatEnd): string {
  switch (end.kind) {
    case 'never':
      return ''
    case 'count':
      return `, ${end.count} ${plural(end.count, 'раз', 'раза', 'раз')}`
    case 'until': {
      const [y, m, d] = end.day.split('-')
      return `, до ${d}.${m}.${y}`
    }
  }
}

interface Unit {
  feminine?: boolean
  one: string
  few: string
  many: string
}

const units: Record<Freq, Unit> = {
  daily: { one: 'день', few: 'дня', many: 'дней' },
  weekly: { feminine: true, one: 'неделю', few: 'недели', many: 'недель' },
  monthly: { one: 'месяц', few: 'месяца', many: 'месяцев' },
  yearly: { one: 'год', few: 'года', many: 'лет' },
}

const everyOne: Record<Freq, string> = {
  daily: 'Ежедневно',
  weekly: 'Еженедельно',
  monthly: 'Ежемесячно',
  yearly: 'Ежегодно',
}

/** "Каждые 2 недели", "Каждую 21 неделю", "Каждый 5 дней"… (for 1 the single word: "Ежедневно"). */
function everyPhrase(freq: Freq, n: number): string {
  if (n === 1) return everyOne[freq]
  const unit = units[freq]
  if (n % 10 === 1 && n % 100 !== 11) {
    return `${unit.feminine ? 'Каждую' : 'Каждый'} ${n} ${unit.one}`
  }
  return `Каждые ${n} ${plural(n, unit.one, unit.few, unit.many)}`
}

/** A Russian summary such as "Каждые 2 недели: пн, ср, до 31.12.2026". */
export function describeRepeat(repeat: Repeat, startDay: Day): string {
  const head = everyPhrase(repeat.freq, repeat.interval)
  let text = head
  if (repeat.freq === 'weekly') {
    text = `${head}: ${repeat.weekdays.map((d) => weekdayShort[d]).join(', ')}`
  } else if (repeat.freq === 'monthly') {
    const weekday = weekdayShort[weekdayIndex(startDay)]
    if (repeat.monthly === 'monthday') text = `${head}, ${dayOfMonth(startDay)}-го числа`
    else if (repeat.monthly === 'last') text = `${head}, последний ${weekday}`
    else text = `${head}, ${nthWeekdayOfMonth(startDay)}-й ${weekday}`
  }
  return text + endText(repeat.end)
}
