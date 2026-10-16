import type { Deviation, Instance, InstanceStatus } from '@/api/types'

export interface Interval {
  start: Date
  end: Date
}

/** The planned interval, or null for a task that was never planned. */
export function planInterval(instance: Instance): Interval | null {
  if (!instance.planned_start || !instance.planned_end) return null
  return { start: new Date(instance.planned_start), end: new Date(instance.planned_end) }
}

/**
 * The factual interval, or null before the task is started or marked. While a
 * timer runs the fact lasts until `now`.
 */
export function factInterval(instance: Instance, now: Date): Interval | null {
  if (!instance.actual_start) return null
  const start = new Date(instance.actual_start)
  const end = instance.actual_end ? new Date(instance.actual_end) : now
  // A clock that is a little behind must not draw a task that ends before it starts.
  return { start, end: end < start ? start : end }
}

export const isUnplanned = (instance: Instance) => instance.planned_start === null

export const isRunning = (instance: Instance) => instance.status === 'in_progress'

/** A planned task whose time has passed and that nobody marked (FR-5.9). */
export function isUnmarked(instance: Instance, now: Date): boolean {
  return (
    instance.status === 'planned' &&
    instance.planned_end !== null &&
    new Date(instance.planned_end) < now
  )
}

export const statusLabels: Record<InstanceStatus, string> = {
  planned: 'Запланировано',
  in_progress: 'В процессе',
  done: 'Выполнено',
  partial: 'Частично',
  not_done: 'Не выполнено',
  rescheduled: 'Перенесено',
  cancelled: 'Отменено',
}

/** A short mark drawn in front of the title of a block. */
export const statusMarks: Partial<Record<InstanceStatus, string>> = {
  done: '✓',
  partial: '◐',
  not_done: '✗',
  in_progress: '▶',
  rescheduled: '⇢',
}

/** What can be done with a task in its current state (the server enforces the same rules). */
export function actionsFor(instance: Instance) {
  const { status } = instance
  const planned = !isUnplanned(instance)
  const history = status === 'rescheduled' || status === 'cancelled'
  return {
    complete: planned && !history && status !== 'done',
    start: status === 'planned' || status === 'not_done',
    stop: status === 'in_progress',
    reschedule: planned && (status === 'planned' || status === 'not_done'),
    editFact: !history,
    // Planned again: for any marked task with a plan to go back to. A rescheduled one qualifies
    // only once the task it was moved to is gone.
    removeMark:
      planned &&
      status !== 'planned' &&
      status !== 'cancelled' &&
      (status !== 'rescheduled' || instance.rescheduled_to === null),
  }
}

/** The Russian sentence for a deviation, e.g. "Начали позже на 20 мин". */
export function deviationText(d: Deviation): string {
  const minutes = formatMinutes(d.minutes)
  switch (d.kind) {
    case 'started_late':
      return `Начали позже на ${minutes}`
    case 'started_early':
      return `Начали раньше на ${minutes}`
    case 'finished_late':
      return `Закончили позже на ${minutes} (затянулось)`
    case 'finished_early':
      return `Закончили раньше на ${minutes}`
    case 'took_longer':
      return `Заняло больше на ${minutes}`
    case 'took_shorter':
      return `Заняло меньше на ${minutes}`
  }
}

/** "20 мин", "1 ч 30 мин", "2 ч". */
export function formatMinutes(total: number): string {
  const h = Math.floor(total / 60)
  const m = total % 60
  if (h === 0) return `${m} мин`
  return m === 0 ? `${h} ч` : `${h} ч ${m} мин`
}
