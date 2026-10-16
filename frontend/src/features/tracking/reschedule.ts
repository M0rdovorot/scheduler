import type { Instance } from '@/api/types'
import { addDays } from '@/features/calendar/dates'
import { fromLocalInput, toLocalInput } from '@/features/calendar/localTime'

export const maxReasonLength = 2000

/** Form state of a reschedule: datetime-local values in the user's zone and the reason. */
export interface RescheduleDraft {
  start: string
  end: string
  comment: string
}

export type RescheduleErrors = Partial<Record<'start' | 'end' | 'comment', string>>

/** The suggested new time: the same time the next day, the same length. */
export function defaultReschedule(instance: Instance, tz: string): RescheduleDraft {
  const startIso = instance.planned_start ?? instance.actual_start
  const endIso = instance.planned_end ?? instance.actual_end ?? startIso
  if (!startIso || !endIso) throw new Error('a task to reschedule has a time')

  const nextDay = (iso: string) => {
    const local = toLocalInput(new Date(iso), tz)
    return `${addDays(local.slice(0, 10), 1)}${local.slice(10)}`
  }
  return { start: nextDay(startIso), end: nextDay(endIso), comment: '' }
}

export function validateReschedule(draft: RescheduleDraft, tz: string): RescheduleErrors {
  const errors: RescheduleErrors = {}
  const start = fromLocalInput(draft.start, tz)
  const end = fromLocalInput(draft.end, tz)
  if (!start) errors.start = 'Укажите новое начало'
  if (!end) errors.end = 'Укажите новый конец'
  else if (start && end.getTime() <= start.getTime()) errors.end = 'Конец должен быть позже начала'
  if ([...draft.comment].length > maxReasonLength) {
    errors.comment = `Не длиннее ${maxReasonLength} символов`
  }
  return errors
}

/** The request body for a valid draft. */
export function toRescheduleRequest(draft: RescheduleDraft, tz: string) {
  const start = fromLocalInput(draft.start, tz)
  const end = fromLocalInput(draft.end, tz)
  if (!start || !end) throw new Error('toRescheduleRequest needs a valid draft')
  const comment = draft.comment.trim()
  return {
    planned_start: start.toISOString(),
    planned_end: end.toISOString(),
    ...(comment ? { comment } : {}),
  }
}
