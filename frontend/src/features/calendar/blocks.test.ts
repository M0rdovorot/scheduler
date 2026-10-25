import { describe, expect, it } from 'vitest'
import type { Instance } from '@/api/types'
import { blocksForDay, effectiveMode, modeOptions, touchesDay } from './blocks'

const tz = 'UTC'
const NOW = new Date('2026-10-14T12:00:00Z')

const task = (over: Partial<Instance>): Instance => ({
  id: 't',
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
  visibility: 'private',
  ...over,
})

const done = task({
  id: 'done',
  status: 'done',
  actual_start: '2026-10-14T10:20:00Z',
  actual_end: '2026-10-14T11:30:00Z',
})
const unplanned = task({
  id: 'free',
  planned_start: null,
  planned_end: null,
  status: 'done',
  actual_start: '2026-10-14T08:00:00Z',
  actual_end: '2026-10-14T08:20:00Z',
})
const running = task({ id: 'run', status: 'in_progress', actual_start: '2026-10-14T11:40:00Z' })
const planned = task({ id: 'plan' })
const all = [done, unplanned, running, planned]
const DAY = '2026-10-14'

const summary = (blocks: ReturnType<typeof blocksForDay>) =>
  blocks.map(
    (b) =>
      `${b.instance.id}:${b.kind}:${b.seg.startMin}-${b.seg.endMin}${b.stripe ? `+${b.stripe.startMin}-${b.stripe.endMin}` : ''}`,
  )

describe('blocksForDay', () => {
  it('plan: draws the plan of every planned task and hides the unplanned ones', () => {
    expect(summary(blocksForDay(all, DAY, tz, 'plan', NOW))).toEqual([
      'done:plan:600-660',
      'run:plan:600-660',
      'plan:plan:600-660',
    ])
  })

  it('fact: draws the fact, the timer up to now, and the unplanned tasks; planned-only tasks have none', () => {
    expect(summary(blocksForDay(all, DAY, tz, 'fact', NOW))).toEqual([
      'done:fact:620-690',
      'free:unplanned:480-500',
      'run:fact:700-720',
    ])
  })

  it('both: the plan with the fact as a stripe, unplanned tasks by their fact', () => {
    expect(summary(blocksForDay(all, DAY, tz, 'both', NOW))).toEqual([
      'done:plan:600-660+620-690',
      'free:unplanned:480-500',
      'run:plan:600-660+700-720',
      'plan:plan:600-660',
    ])
  })

  it('keeps a rescheduled original in the plan, without a fact', () => {
    const moved = task({ id: 'moved', status: 'rescheduled' })
    expect(summary(blocksForDay([moved], DAY, tz, 'plan', NOW))).toEqual(['moved:plan:600-660'])
    expect(blocksForDay([moved], DAY, tz, 'fact', NOW)).toEqual([])
  })

  it('shows a fact that lies on another day than the plan', () => {
    // Planned on the 14th, done in the night after midnight.
    const late = task({
      id: 'late',
      status: 'done',
      actual_start: '2026-10-15T00:10:00Z',
      actual_end: '2026-10-15T00:50:00Z',
    })
    expect(summary(blocksForDay([late], '2026-10-15', tz, 'both', NOW))).toEqual([
      'late:fact:10-50',
    ])
    expect(blocksForDay([late], '2026-10-15', tz, 'plan', NOW)).toEqual([])
    expect(summary(blocksForDay([late], DAY, tz, 'both', NOW))).toEqual(['late:plan:600-660'])
  })

  it('clips a fact across midnight to each day', () => {
    const night = task({
      id: 'night',
      planned_start: '2026-10-14T22:00:00Z',
      planned_end: '2026-10-14T23:00:00Z',
      status: 'done',
      actual_start: '2026-10-14T23:30:00Z',
      actual_end: '2026-10-15T01:00:00Z',
    })
    expect(summary(blocksForDay([night], DAY, tz, 'fact', NOW))).toEqual(['night:fact:1410-1440'])
    expect(summary(blocksForDay([night], '2026-10-15', tz, 'fact', NOW))).toEqual([
      'night:fact:0-60',
    ])
  })
})

describe('touchesDay', () => {
  it('is true when either the plan or the fact reaches the day', () => {
    expect(touchesDay(planned, DAY, tz, NOW)).toBe(true)
    expect(touchesDay(planned, '2026-10-15', tz, NOW)).toBe(false)
    expect(touchesDay(unplanned, DAY, tz, NOW)).toBe(true)
    expect(touchesDay(unplanned, '2026-10-13', tz, NOW)).toBe(false)
    const late = task({
      status: 'done',
      actual_start: '2026-10-15T00:10:00Z',
      actual_end: '2026-10-15T00:50:00Z',
    })
    expect(touchesDay(late, '2026-10-15', tz, NOW)).toBe(true)
  })

  it('counts a running timer up to now only', () => {
    const tomorrow = '2026-10-15'
    expect(touchesDay(running, DAY, tz, NOW)).toBe(true)
    expect(
      touchesDay(
        task({
          status: 'in_progress',
          actual_start: '2026-10-14T11:40:00Z',
          planned_start: null,
          planned_end: null,
        }),
        tomorrow,
        tz,
        NOW,
      ),
    ).toBe(false)
  })
})

describe('modes by view', () => {
  it('offers plan, fact and both for a day and three days, and no "both" for a week', () => {
    expect(modeOptions('day')).toEqual(['plan', 'fact', 'both'])
    expect(modeOptions('three_days')).toEqual(['plan', 'fact', 'both'])
    expect(modeOptions('week')).toEqual(['plan', 'fact'])
  })

  it('falls back to the plan for "both" in a week', () => {
    expect(effectiveMode('both', 'week')).toBe('plan')
    expect(effectiveMode('both', 'day')).toBe('both')
    expect(effectiveMode('fact', 'week')).toBe('fact')
    expect(effectiveMode('plan', 'three_days')).toBe('plan')
  })
})
