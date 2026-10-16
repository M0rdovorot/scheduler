import { describe, expect, it } from 'vitest'
import type { Instance } from '@/api/types'
import {
  actionsFor,
  deviationText,
  factInterval,
  formatElapsed,
  formatMinutes,
  isTooLong,
  isUnmarked,
  isUnplanned,
  planInterval,
} from './fact'

const base: Instance = {
  id: 't1',
  title: 'Спорт',
  description: '',
  planned_start: '2026-10-14T10:00:00Z',
  planned_end: '2026-10-14T11:00:00Z',
  actual_start: null,
  actual_end: null,
  status: 'planned',
  comment: '',
  category_ids: [],
  series_id: null,
  habit_id: null,
  rescheduled_from: null,
  rescheduled_to: null,
  deviations: [],
}
const NOW = new Date('2026-10-14T12:00:00Z')
const with_ = (over: Partial<Instance>): Instance => ({ ...base, ...over })

describe('planInterval / factInterval', () => {
  it('reads the plan, and none for an unplanned task', () => {
    expect(planInterval(base)?.start.toISOString()).toBe('2026-10-14T10:00:00.000Z')
    expect(planInterval(with_({ planned_start: null, planned_end: null }))).toBeNull()
  })

  it('has no fact before the task is started', () => {
    expect(factInterval(base, NOW)).toBeNull()
  })

  it('reads a finished fact as it is', () => {
    const f = factInterval(
      with_({ actual_start: '2026-10-14T10:20:00Z', actual_end: '2026-10-14T11:30:00Z' }),
      NOW,
    )
    expect(f?.end.toISOString()).toBe('2026-10-14T11:30:00.000Z')
  })

  it('lets a running timer last until now', () => {
    const f = factInterval(
      with_({ status: 'in_progress', actual_start: '2026-10-14T10:20:00Z' }),
      NOW,
    )
    expect(f?.end.getTime()).toBe(NOW.getTime())
  })

  it('never ends before the start when the clock is behind', () => {
    const f = factInterval(
      with_({ status: 'in_progress', actual_start: '2026-10-14T12:30:00Z' }),
      NOW,
    )
    expect(f?.end.getTime()).toBe(f?.start.getTime())
  })
})

describe('isUnmarked (FR-5.9)', () => {
  it('flags a planned task whose time has passed', () => {
    expect(isUnmarked(base, NOW)).toBe(true)
  })

  it('does not flag a task that is still ahead or running its slot', () => {
    expect(isUnmarked(base, new Date('2026-10-14T10:30:00Z'))).toBe(false)
    expect(isUnmarked(base, new Date('2026-10-14T11:00:00Z'))).toBe(false) // ends exactly now
  })

  it.each(['done', 'partial', 'not_done', 'in_progress', 'rescheduled'] as const)(
    'does not flag a %s task',
    (status) => {
      expect(isUnmarked(with_({ status }), NOW)).toBe(false)
    },
  )

  it('does not flag a task outside the plan', () => {
    expect(
      isUnmarked(with_({ planned_start: null, planned_end: null, status: 'planned' }), NOW),
    ).toBe(false)
    expect(isUnplanned(with_({ planned_start: null, planned_end: null }))).toBe(true)
  })
})

describe('actionsFor', () => {
  it('offers start, done, reschedule and fact editing for a planned task', () => {
    expect(actionsFor(base)).toEqual({
      complete: true,
      start: true,
      stop: false,
      reschedule: true,
      editFact: true,
      removeMark: false,
    })
  })

  it('offers stop for a running task and no second start', () => {
    const a = actionsFor(with_({ status: 'in_progress', actual_start: '2026-10-14T10:00:00Z' }))
    expect(a).toMatchObject({ stop: true, start: false, reschedule: false, removeMark: true })
  })

  it('lets a done task be marked again or have its mark removed, not be started', () => {
    const a = actionsFor(
      with_({ status: 'done', actual_start: base.planned_start, actual_end: base.planned_end }),
    )
    expect(a).toMatchObject({ complete: false, start: false, removeMark: true, editFact: true })
  })

  it('lets a not done task be started, moved or completed', () => {
    expect(actionsFor(with_({ status: 'not_done' }))).toMatchObject({
      start: true,
      reschedule: true,
      complete: true,
      removeMark: true,
    })
  })

  it('lets the mark of a rescheduled task be removed once the new task is gone', () => {
    expect(actionsFor(with_({ status: 'rescheduled' })).removeMark).toBe(true)
  })

  it('leaves a rescheduled task alone while the new task exists', () => {
    const link = { id: 'n', planned_start: base.planned_start!, planned_end: base.planned_end! }
    expect(actionsFor(with_({ status: 'rescheduled', rescheduled_to: link }))).toEqual({
      complete: false,
      start: false,
      stop: false,
      reschedule: false,
      editFact: false,
      removeMark: false,
    })
  })

  it('has no plan to complete, move or return to for an unplanned task', () => {
    const a = actionsFor(
      with_({
        planned_start: null,
        planned_end: null,
        status: 'in_progress',
        actual_start: base.planned_start,
      }),
    )
    expect(a).toMatchObject({
      complete: false,
      reschedule: false,
      removeMark: false,
      stop: true,
      editFact: true,
    })
  })
})

describe('deviationText / formatMinutes', () => {
  it.each([
    [{ kind: 'started_late', minutes: 20 }, 'Начали позже на 20 мин'],
    [{ kind: 'started_early', minutes: 5 }, 'Начали раньше на 5 мин'],
    [{ kind: 'finished_late', minutes: 90 }, 'Закончили позже на 1 ч 30 мин (затянулось)'],
    [{ kind: 'finished_early', minutes: 60 }, 'Закончили раньше на 1 ч'],
    [{ kind: 'took_longer', minutes: 15 }, 'Заняло больше на 15 мин'],
    [{ kind: 'took_shorter', minutes: 125 }, 'Заняло меньше на 2 ч 5 мин'],
  ] as const)('%j', (d, want) => {
    expect(deviationText(d)).toBe(want)
  })

  it('formats minutes', () => {
    expect(formatMinutes(0)).toBe('0 мин')
    expect(formatMinutes(59)).toBe('59 мин')
    expect(formatMinutes(120)).toBe('2 ч')
  })
})

describe('formatElapsed / isTooLong', () => {
  it.each([
    [0, '0:00:00'],
    [999, '0:00:00'],
    [1000, '0:00:01'],
    [65_000, '0:01:05'],
    [3_661_000, '1:01:01'],
    [36_000_000, '10:00:00'],
    [-5000, '0:00:00'],
  ])('%i ms → %s', (ms, want) => {
    expect(formatElapsed(ms)).toBe(want)
  })

  it('flags a timer that runs longer than the statistics count', () => {
    const start = new Date('2026-10-14T00:00:00Z')
    expect(isTooLong(start, new Date('2026-10-14T12:00:00Z'))).toBe(false) // exactly the cap
    expect(isTooLong(start, new Date('2026-10-14T12:00:01Z'))).toBe(true)
  })
})
