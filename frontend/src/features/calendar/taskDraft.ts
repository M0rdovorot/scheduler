import type { CreateTaskRequest, Instance, SlotMinutes, UpdateInstanceRequest } from '@/api/types'
import { addDays, type Day } from './dates'
import { fromLocalInput, toLocalInput } from './localTime'
import { minutesPerDay, wallMinutes } from './segments'

export const maxTitleLength = 200
export const maxDescriptionLength = 5000

/** Form state. Times are datetime-local values in the user's time zone. */
export interface TaskDraft {
  title: string
  description: string
  start: string
  end: string
  categoryIds: string[]
}

export type TaskDraftErrors = Partial<Record<'title' | 'description' | 'start' | 'end', string>>

const pad = (n: number) => String(n).padStart(2, '0')

/** A datetime-local value for `minutes` after the local midnight of `day`; may run into later days. */
export function localAt(day: Day, minutes: number): string {
  const date = addDays(day, Math.floor(minutes / minutesPerDay))
  const rest = ((minutes % minutesPerDay) + minutesPerDay) % minutesPerDay
  return `${date}T${pad(Math.floor(rest / 60))}:${pad(rest % 60)}`
}

export function draftFromInstance(instance: Instance, tz: string): TaskDraft {
  return {
    title: instance.title,
    description: instance.description,
    start: toLocalInput(new Date(instance.planned_start), tz),
    end: toLocalInput(new Date(instance.planned_end), tz),
    categoryIds: [...instance.category_ids],
  }
}

/** A new task over the slots selected in the grid. */
export function draftForSelection(day: Day, startMin: number, endMin: number): TaskDraft {
  return {
    title: '',
    description: '',
    start: localAt(day, startMin),
    end: localAt(day, endMin),
    categoryIds: [],
  }
}

/** A new task for the "+" button: the next slot boundary, one hour long. */
export function draftStartingNow(now: Date, today: Day, slot: SlotMinutes, tz: string): TaskDraft {
  const minutes = Math.ceil(wallMinutes(now, today, tz) / slot) * slot
  return draftForSelection(today, minutes, minutes + 60)
}

export function validateTaskDraft(draft: TaskDraft, tz: string): TaskDraftErrors {
  const errors: TaskDraftErrors = {}
  const title = [...draft.title.trim()].length
  if (title < 1) errors.title = 'Введите название'
  else if (title > maxTitleLength) errors.title = `Не длиннее ${maxTitleLength} символов`
  if ([...draft.description].length > maxDescriptionLength) {
    errors.description = `Не длиннее ${maxDescriptionLength} символов`
  }

  const start = fromLocalInput(draft.start, tz)
  const end = fromLocalInput(draft.end, tz)
  if (!start) errors.start = 'Укажите дату и время начала'
  if (!end) errors.end = 'Укажите дату и время окончания'
  else if (start && end.getTime() <= start.getTime()) errors.end = 'Конец должен быть позже начала'
  return errors
}

/** Request body for a valid draft. */
export function toCreateRequest(draft: TaskDraft, tz: string): CreateTaskRequest {
  const start = fromLocalInput(draft.start, tz)
  const end = fromLocalInput(draft.end, tz)
  if (!start || !end) throw new Error('toCreateRequest needs a valid draft')
  return {
    title: draft.title.trim(),
    description: draft.description,
    planned_start: start.toISOString(),
    planned_end: end.toISOString(),
    category_ids: draft.categoryIds,
  }
}

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x) => b.includes(x))

/** Only the fields of a valid draft that differ from the saved task. */
export function toUpdateRequest(
  original: Instance,
  draft: TaskDraft,
  tz: string,
): UpdateInstanceRequest {
  const patch: UpdateInstanceRequest = {}
  const title = draft.title.trim()
  if (title !== original.title) patch.title = title
  if (draft.description !== original.description) patch.description = draft.description

  // Compare instants, not strings: the same minute may be written differently.
  const start = fromLocalInput(draft.start, tz)
  const end = fromLocalInput(draft.end, tz)
  if (start && start.getTime() !== new Date(original.planned_start).getTime()) {
    patch.planned_start = start.toISOString()
  }
  if (end && end.getTime() !== new Date(original.planned_end).getTime()) {
    patch.planned_end = end.toISOString()
  }
  if (!sameSet(draft.categoryIds, original.category_ids)) patch.category_ids = draft.categoryIds
  return patch
}
