import type { BusyBlock, Instance } from '@/api/types'

/** What a block without a title says. */
export const busyTitle = 'Занят'

/**
 * Busy blocks as tasks, so that the calendar grid can draw them. They are plain planned
 * tasks: no category, no series, nothing of the partner's own tracking.
 */
export function busyInstances(blocks: readonly BusyBlock[]): Instance[] {
  return blocks.map((b, i) => ({
    id: `busy-${i}`,
    series_id: null,
    habit_id: null,
    title: b.title ?? busyTitle,
    description: '',
    planned_start: b.start,
    planned_end: b.end,
    actual_start: null,
    actual_end: null,
    status: 'planned',
    comment: '',
    category_ids: [],
    rescheduled_from: null,
    rescheduled_to: null,
    deviations: [],
    visibility: 'private',
  }))
}
