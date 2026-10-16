import type { Instance, TrackingPatch } from '@/api/types'
import { fromLocalInput, toLocalInput } from '@/features/calendar/localTime'

export const maxCommentLength = 2000

/** The comment is edited on its own (see commentError), not with the fact. */
export function commentError(comment: string): string | null {
  return [...comment].length > maxCommentLength ? `Не длиннее ${maxCommentLength} символов` : null
}

/** Statuses the fact editor offers; "planned" is the separate "remove the mark" action. */
export type FactStatus = 'done' | 'partial' | 'not_done' | 'in_progress'

/** Form state of the manual fact edit. Times are datetime-local values in the user's zone. */
export interface FactDraft {
  status: FactStatus
  start: string
  end: string
}

export type FactErrors = Partial<Record<'start' | 'end', string>>

const finished = (s: FactStatus) => s === 'done' || s === 'partial'

/**
 * The editor starts from what is known: the fact if there is one, otherwise the
 * plan, so that marking a planned task as done is one tap on "save".
 */
export function draftFromInstance(instance: Instance, tz: string, now: Date): FactDraft {
  const status: FactStatus =
    instance.status === 'done' ||
    instance.status === 'partial' ||
    instance.status === 'not_done' ||
    instance.status === 'in_progress'
      ? instance.status
      : 'done'

  const startIso = instance.actual_start ?? instance.planned_start
  const endIso =
    instance.actual_end ?? (instance.status === 'in_progress' ? null : instance.planned_end)
  return {
    status,
    start: startIso ? toLocalInput(new Date(startIso), tz) : toLocalInput(now, tz),
    end: endIso ? toLocalInput(new Date(endIso), tz) : '',
  }
}

export function validateFactDraft(draft: FactDraft, tz: string): FactErrors {
  const errors: FactErrors = {}
  if (draft.status === 'not_done') return errors

  const start = fromLocalInput(draft.start, tz)
  if (!start) errors.start = 'Укажите дату и время начала'
  if (finished(draft.status)) {
    const end = fromLocalInput(draft.end, tz)
    if (!end) errors.end = 'Укажите дату и время окончания'
    else if (start && end.getTime() <= start.getTime())
      errors.end = 'Конец должен быть позже начала'
  }
  return errors
}

const sameInstant = (iso: string | null, date: Date | null) =>
  (iso === null) === (date === null) &&
  (iso === null || new Date(iso).getTime() === date!.getTime())

/**
 * Only what differs from the saved task. Choosing a status of a task that is
 * still planned always counts as a change (that is what marks it).
 */
export function buildTrackingPatch(
  instance: Instance,
  draft: FactDraft,
  tz: string,
): TrackingPatch {
  const patch: TrackingPatch = {}
  if (draft.status !== instance.status) patch.status = draft.status

  if (draft.status !== 'not_done') {
    const start = fromLocalInput(draft.start, tz)
    if (start && !sameInstant(instance.actual_start, start))
      patch.actual_start = start.toISOString()
    if (finished(draft.status)) {
      const end = fromLocalInput(draft.end, tz)
      if (end && !sameInstant(instance.actual_end, end)) patch.actual_end = end.toISOString()
    }
  }
  return patch
}
