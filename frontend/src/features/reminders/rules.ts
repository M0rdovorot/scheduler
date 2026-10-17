import type { QuietHours, ReminderKind, ReminderRule, ReminderScope } from '@/api/types'
import { plural } from '@/features/habits/format'

export const maxRules = 20
export const maxOffsetMinutes = 10080

export type Unit = 'minute' | 'hour' | 'day'

const unitMinutes: Record<Unit, number> = { minute: 1, hour: 60, day: 1440 }

/** One reminder as the user edits it: typed amounts, not minutes. */
export interface RuleDraft {
  kind: ReminderKind
  amount: string
  unit: Unit
  /** "HH:MM", for habit_time */
  time: string
}

export const taskKinds: { kind: ReminderKind; label: string }[] = [
  { kind: 'before_start', label: 'До начала' },
  { kind: 'after_end', label: 'После окончания' },
  { kind: 'not_started', label: 'Не начато' },
  { kind: 'overrun', label: 'Затянулось' },
]

/** The kinds a level offers: a habit has times of day, everything else the four of a task. */
export function kindsFor(scope: ReminderScope | 'global'): ReminderKind[] {
  return scope === 'habit' ? ['habit_time'] : taskKinds.map((k) => k.kind)
}

export function newDraft(scope: ReminderScope | 'global'): RuleDraft {
  const kind = kindsFor(scope)[0]!
  return kind === 'habit_time'
    ? { kind, amount: '', unit: 'minute', time: '21:00' }
    : { kind, amount: '10', unit: 'minute', time: '' }
}

/** The largest unit that divides the minutes exactly. */
export function draftFromRule(rule: ReminderRule): RuleDraft {
  if (rule.kind === 'habit_time') {
    return { kind: rule.kind, amount: '', unit: 'minute', time: rule.time_of_day ?? '21:00' }
  }
  const minutes = rule.offset_minutes ?? 0
  const unit: Unit =
    minutes > 0 && minutes % 1440 === 0
      ? 'day'
      : minutes > 0 && minutes % 60 === 0
        ? 'hour'
        : 'minute'
  return { kind: rule.kind, amount: String(minutes / unitMinutes[unit]), unit, time: '' }
}

const whole = /^\d{1,6}$/

/** The offset of a draft in minutes, or null when it is not a whole number in range. */
export function draftMinutes(draft: RuleDraft): number | null {
  if (!whole.test(draft.amount.trim())) return null
  const minutes = Number(draft.amount) * unitMinutes[draft.unit]
  return minutes <= maxOffsetMinutes ? minutes : null
}

export function ruleFromDraft(draft: RuleDraft): ReminderRule | null {
  if (draft.kind === 'habit_time') {
    return /^([01]\d|2[0-3]):[0-5]\d$/.test(draft.time)
      ? { kind: draft.kind, offset_minutes: null, time_of_day: draft.time }
      : null
  }
  const minutes = draftMinutes(draft)
  return minutes === null ? null : { kind: draft.kind, offset_minutes: minutes, time_of_day: null }
}

/** A message per draft that cannot be saved (by index); an empty list is fine. */
export function validateDrafts(drafts: readonly RuleDraft[]): Record<number, string> {
  const errors: Record<number, string> = {}
  drafts.forEach((d, i) => {
    if (ruleFromDraft(d) === null) {
      errors[i] =
        d.kind === 'habit_time' ? 'Укажите время' : 'Укажите целое число, не больше недели'
    }
  })
  return errors
}

/** The rules to send: valid ones, the same rule once. */
export function rulesFromDrafts(drafts: readonly RuleDraft[]): ReminderRule[] {
  const seen = new Set<string>()
  const out: ReminderRule[] = []
  for (const d of drafts) {
    const rule = ruleFromDraft(d)
    if (!rule) continue
    const key = `${rule.kind}:${rule.offset_minutes}:${rule.time_of_day}`
    if (!seen.has(key)) {
      seen.add(key)
      out.push(rule)
    }
  }
  return out
}

/** "10 минут", "1 час", "2 дня", "0 минут". */
export function amountLabel(minutes: number): string {
  if (minutes > 0 && minutes % 1440 === 0) {
    const n = minutes / 1440
    return `${n} ${plural(n, ['день', 'дня', 'дней'])}`
  }
  if (minutes > 0 && minutes % 60 === 0) {
    const n = minutes / 60
    return `${n} ${plural(n, ['час', 'часа', 'часов'])}`
  }
  return `${minutes} ${plural(minutes, ['минута', 'минуты', 'минут'])}`
}

/** A reminder in words: "За 10 минут до начала", "Сразу после окончания". */
export function ruleLabel(rule: ReminderRule): string {
  const minutes = rule.offset_minutes ?? 0
  switch (rule.kind) {
    case 'before_start':
      return minutes === 0 ? 'В момент начала' : `За ${amountLabel(minutes)} до начала`
    case 'after_end':
      return minutes === 0
        ? 'Сразу после окончания'
        : `Через ${amountLabel(minutes)} после окончания`
    case 'not_started':
      return minutes === 0
        ? 'В момент начала, если не начато'
        : `Через ${amountLabel(minutes)} после начала, если не начато`
    case 'overrun':
      return minutes === 0
        ? 'Сразу после окончания, если таймер идёт'
        : `Через ${amountLabel(minutes)} после окончания, если таймер идёт`
    case 'habit_time':
      return `В ${rule.time_of_day}`
  }
}

export const sourceLabels: Record<'global' | 'category' | 'series' | 'instance' | 'habit', string> =
  {
    global: 'общие настройки',
    category: 'настройки категории',
    series: 'настройки серии',
    instance: 'настройки этого дела',
    habit: 'настройки привычки',
  }

/** What the user edits for the quiet hours. */
export interface QuietDraft {
  on: boolean
  start: string
  end: string
}

export function quietDraft(quiet: QuietHours | null): QuietDraft {
  return quiet ? { on: true, ...quiet } : { on: false, start: '23:00', end: '08:00' }
}

export function quietError(d: QuietDraft): string | null {
  if (!d.on) return null
  const ok = /^([01]\d|2[0-3]):[0-5]\d$/
  if (!ok.test(d.start) || !ok.test(d.end)) return 'Укажите время начала и конца'
  if (d.start === d.end) return 'Начало и конец не должны совпадать'
  return null
}

export function quietFromDraft(d: QuietDraft): QuietHours | null {
  return d.on ? { start: d.start, end: d.end } : null
}
