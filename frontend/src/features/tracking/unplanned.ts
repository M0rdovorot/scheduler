import type { Day } from '@/features/calendar/dates'
import { fromLocalInput, toLocalInput } from '@/features/calendar/localTime'
import { localAt } from '@/features/calendar/taskDraft'

export type UnplannedMode = 'timer' | 'past'

/** Form state of a task outside the plan (FR-5.7). */
export interface UnplannedDraft {
  title: string
  /** timer: start a timer now. past: add it back-dated with its fact. */
  mode: UnplannedMode
  start: string
  end: string
  categoryIds: string[]
}

export type UnplannedErrors = Partial<Record<'title' | 'start' | 'end', string>>

const minute = 60_000

/** A timer by default; for the back-dated case the last half hour is suggested. */
export function defaultUnplanned(now: Date, tz: string): UnplannedDraft {
  const rounded = new Date(Math.floor(now.getTime() / minute) * minute)
  return {
    title: '',
    mode: 'timer',
    start: toLocalInput(new Date(rounded.getTime() - 30 * minute), tz),
    end: toLocalInput(rounded, tz),
    categoryIds: [],
  }
}

/** A back-dated fact, with the last half hour ready. */
export function pastUnplanned(now: Date, tz: string): UnplannedDraft {
  return { ...defaultUnplanned(now, tz), mode: 'past' }
}

/**
 * A fact over the slots selected in the grid. A fact cannot lie in the future, so a selection
 * that reaches past `now` is cut at it; one that starts after it falls back to the last half hour.
 */
export function unplannedForSelection(
  day: Day,
  startMin: number,
  endMin: number,
  now: Date,
  tz: string,
): UnplannedDraft {
  const fallback = pastUnplanned(now, tz)
  const current = Math.floor(now.getTime() / minute) * minute
  const start = fromLocalInput(localAt(day, startMin), tz)
  const end = fromLocalInput(localAt(day, endMin), tz)
  if (!start || !end || start.getTime() >= current) return fallback
  const cut = end.getTime() > current ? new Date(current) : end
  return {
    ...fallback,
    mode: 'past',
    start: toLocalInput(start, tz),
    end: toLocalInput(cut, tz),
  }
}

export function validateUnplanned(draft: UnplannedDraft, tz: string): UnplannedErrors {
  const errors: UnplannedErrors = {}
  const length = [...draft.title.trim()].length
  if (length < 1) errors.title = 'Введите название'
  else if (length > 200) errors.title = 'Не длиннее 200 символов'

  if (draft.mode === 'past') {
    const start = fromLocalInput(draft.start, tz)
    const end = fromLocalInput(draft.end, tz)
    if (!start) errors.start = 'Укажите, когда началось'
    if (!end) errors.end = 'Укажите, когда закончилось'
    else if (start && end.getTime() <= start.getTime())
      errors.end = 'Конец должен быть позже начала'
  }
  return errors
}

/** The request body for a valid draft: a timer has no times, the server starts it now. */
export function toUnplannedRequest(draft: UnplannedDraft, tz: string) {
  const body: {
    title: string
    category_ids: string[]
    actual_start?: string
    actual_end?: string
  } = { title: draft.title.trim(), category_ids: draft.categoryIds }
  if (draft.mode === 'past') {
    const start = fromLocalInput(draft.start, tz)
    const end = fromLocalInput(draft.end, tz)
    if (!start || !end) throw new Error('toUnplannedRequest needs a valid draft')
    body.actual_start = start.toISOString()
    body.actual_end = end.toISOString()
  }
  return body
}
