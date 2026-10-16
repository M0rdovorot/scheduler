import type {
  Habit,
  HabitFrequency,
  HabitInput,
  HabitKind,
  HabitPatch,
  HabitPlacement,
} from '@/api/types'

export const maxTitleLength = 200
export const maxUnitLength = 30
export const maxTarget = 100000

export interface HabitDraft {
  title: string
  kind: HabitKind
  target: string
  unit: string
  frequency: HabitFrequency
  /** ISO weekdays 1..7 */
  weekdays: number[]
  timesPerWeek: string
  color: string
  inGrid: boolean
  /** "HH:MM" */
  time: string
  /** Minutes, as typed. */
  duration: string
}

export function emptyDraft(color: string): HabitDraft {
  return {
    title: '',
    kind: 'boolean',
    target: '8',
    unit: '',
    frequency: 'daily',
    weekdays: [1, 2, 3, 4, 5],
    timesPerWeek: '3',
    color,
    inGrid: false,
    time: '09:00',
    duration: '30',
  }
}

export function draftFromHabit(habit: Habit): HabitDraft {
  return {
    title: habit.title,
    kind: habit.kind,
    target: String(habit.target_value),
    unit: habit.unit,
    frequency: habit.frequency,
    weekdays:
      habit.weekdays.length > 0 ? [...habit.weekdays].sort((a, b) => a - b) : [1, 2, 3, 4, 5],
    timesPerWeek: String(habit.times_per_week ?? 3),
    color: habit.color,
    inGrid: habit.placement !== null,
    time: habit.placement?.time ?? '09:00',
    duration: String(habit.placement?.duration_minutes ?? 30),
  }
}

const wholeNumber = /^\d{1,7}$/

export type DraftErrors = Partial<
  Record<'title' | 'target' | 'unit' | 'weekdays' | 'timesPerWeek' | 'time' | 'duration', string>
>

export function validateDraft(draft: HabitDraft): DraftErrors {
  const errors: DraftErrors = {}
  const title = draft.title.trim()
  if (title === '') errors.title = 'Введите название'
  else if (title.length > maxTitleLength) errors.title = `Не длиннее ${maxTitleLength} символов`

  if (draft.kind === 'quantity') {
    const target = wholeNumber.test(draft.target.trim()) ? Number(draft.target) : 0
    if (target < 1 || target > maxTarget) errors.target = `Цель — целое число от 1 до ${maxTarget}`
    if (draft.unit.trim().length > maxUnitLength)
      errors.unit = `Не длиннее ${maxUnitLength} символов`
  }

  if (draft.frequency === 'weekdays' && draft.weekdays.length === 0)
    errors.weekdays = 'Выберите хотя бы один день'
  if (draft.frequency === 'times_per_week') {
    const n = wholeNumber.test(draft.timesPerWeek.trim()) ? Number(draft.timesPerWeek) : 0
    if (n < 1 || n > 7) errors.timesPerWeek = 'От 1 до 7 раз в неделю'
  }

  if (draft.inGrid && draft.frequency !== 'times_per_week') {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(draft.time)) errors.time = 'Укажите время'
    const minutes = wholeNumber.test(draft.duration.trim()) ? Number(draft.duration) : 0
    if (minutes < 1 || minutes > 1440) errors.duration = 'Длительность — от 1 до 1440 минут'
  }
  return errors
}

/** A habit with a weekly goal has no fixed day, so it cannot sit in the grid. */
export function canBeInGrid(draft: Pick<HabitDraft, 'frequency'>): boolean {
  return draft.frequency !== 'times_per_week'
}

function schedule(draft: HabitDraft) {
  switch (draft.frequency) {
    case 'daily':
      return { frequency: draft.frequency }
    case 'weekdays':
      return { frequency: draft.frequency, weekdays: [...draft.weekdays].sort((a, b) => a - b) }
    case 'times_per_week':
      return { frequency: draft.frequency, times_per_week: Number(draft.timesPerWeek) }
  }
}

function placementOf(draft: HabitDraft): HabitPlacement | null {
  return draft.inGrid && canBeInGrid(draft)
    ? { time: draft.time, duration_minutes: Number(draft.duration) }
    : null
}

export function toInput(draft: HabitDraft): HabitInput {
  const placement = placementOf(draft)
  return {
    title: draft.title.trim(),
    kind: draft.kind,
    ...(draft.kind === 'quantity'
      ? { target_value: Number(draft.target), unit: draft.unit.trim() }
      : {}),
    ...schedule(draft),
    color: draft.color,
    ...(placement ? { placement } : {}),
  } as HabitInput
}

const sameDays = (a: readonly number[], b: readonly number[]) =>
  a.length === b.length && [...a].sort().every((d, i) => d === [...b].sort()[i])

/** Only the fields that differ from the saved habit. The grid is changed apart, see `placementChange`. */
export function toPatch(habit: Habit, draft: HabitDraft): HabitPatch {
  const patch: HabitPatch = {}
  const title = draft.title.trim()
  if (title !== habit.title) patch.title = title
  if (draft.color !== habit.color) patch.color = draft.color
  if (habit.kind === 'quantity') {
    if (Number(draft.target) !== habit.target_value) patch.target_value = Number(draft.target)
    if (draft.unit.trim() !== habit.unit) patch.unit = draft.unit.trim()
  }
  const scheduleChanged =
    draft.frequency !== habit.frequency ||
    (draft.frequency === 'weekdays' && !sameDays(draft.weekdays, habit.weekdays)) ||
    (draft.frequency === 'times_per_week' && Number(draft.timesPerWeek) !== habit.times_per_week)
  if (scheduleChanged) Object.assign(patch, schedule(draft))
  return patch
}

export type PlacementChange = { kind: 'set'; placement: HabitPlacement } | { kind: 'clear' } | null

/** What to do with the place in the grid so that it matches the draft. */
export function placementChange(habit: Habit, draft: HabitDraft): PlacementChange {
  const want = placementOf(draft)
  const have = habit.placement
  if (!want) return have ? { kind: 'clear' } : null
  if (have && have.time === want.time && have.duration_minutes === want.duration_minutes)
    return null
  return { kind: 'set', placement: want }
}

export function hasChanges(habit: Habit, draft: HabitDraft): boolean {
  return Object.keys(toPatch(habit, draft)).length > 0 || placementChange(habit, draft) !== null
}
