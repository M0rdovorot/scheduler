import { describe, expect, it } from 'vitest'
import type { Habit, HabitDay } from '@/api/types'
import {
  canBeInGrid,
  draftFromHabit,
  emptyDraft,
  hasChanges,
  placementChange,
  toInput,
  toPatch,
  validateDraft,
  type HabitDraft,
} from './form'
import { frequencyLabel, plural, progressLabel, streakLabel, weekProgressLabel } from './format'
import { buildHeatmap, heatmapRange } from './heatmap'
import { parseValue, stepFor, stepped, toggled } from './marks'

const habit = (over: Partial<Habit> = {}): Habit => ({
  id: 'h1',
  title: 'Вода',
  kind: 'quantity',
  target_value: 8,
  unit: 'стаканов',
  frequency: 'daily',
  weekdays: [],
  times_per_week: null,
  color: '#3b82f6',
  archived_at: null,
  created_at: '2026-10-01T00:00:00Z',
  placement: null,
  ...over,
})

const draft = (over: Partial<HabitDraft> = {}): HabitDraft => ({
  ...emptyDraft('#3b82f6'),
  title: 'Йога',
  ...over,
})

describe('plural and labels', () => {
  it.each([
    [1, 'день'],
    [2, 'дня'],
    [5, 'дней'],
    [11, 'дней'],
    [12, 'дней'],
    [21, 'день'],
    [22, 'дня'],
    [100, 'дней'],
    [111, 'дней'],
    [0, 'дней'],
  ])('%i → %s', (n, want) => {
    expect(plural(n, ['день', 'дня', 'дней'])).toBe(want)
  })

  it('names the frequency', () => {
    expect(frequencyLabel(habit())).toBe('Каждый день')
    expect(frequencyLabel(habit({ frequency: 'weekdays', weekdays: [5, 1, 3] }))).toBe('Пн, Ср, Пт')
    expect(frequencyLabel(habit({ frequency: 'times_per_week', times_per_week: 3 }))).toBe(
      '3 раза в неделю',
    )
    expect(frequencyLabel(habit({ frequency: 'times_per_week', times_per_week: 5 }))).toBe(
      '5 раз в неделю',
    )
    expect(frequencyLabel(habit({ frequency: 'times_per_week', times_per_week: 1 }))).toBe(
      '1 раз в неделю',
    )
  })

  it('names streaks in days or weeks', () => {
    expect(streakLabel(1, 'day')).toBe('1 день')
    expect(streakLabel(3, 'day')).toBe('3 дня')
    expect(streakLabel(2, 'week')).toBe('2 недели')
    expect(streakLabel(5, 'week')).toBe('5 недель')
    expect(streakLabel(0, 'day')).toBe('0 дней')
  })

  it('shows the progress of a quantity only', () => {
    expect(progressLabel(habit(), 3)).toBe('3 из 8 стаканов')
    expect(progressLabel(habit({ unit: '' }), 3)).toBe('3 из 8')
    expect(progressLabel(habit({ kind: 'boolean' }), 1)).toBe('')
    expect(weekProgressLabel(2, 3)).toBe('На этой неделе: 2 из 3')
  })
})

describe('marks', () => {
  it('toggles a yes/no habit', () => {
    expect(toggled(0)).toBe(1)
    expect(toggled(1)).toBe(0)
  })

  it.each([
    [8, 1],
    [20, 1],
    [30, 5],
    [100, 5],
    [200, 10],
    [500, 10],
    [1000, 50],
  ])('the step of a goal of %i is %i', (target, step) => {
    expect(stepFor(target)).toBe(step)
  })

  it('steps up and down, not below zero and past the goal', () => {
    expect(stepped(3, 8, 1)).toBe(4)
    expect(stepped(8, 8, 1)).toBe(9)
    expect(stepped(0, 8, -1)).toBe(0)
    expect(stepped(30, 30, -1)).toBe(25)
    expect(stepped(2, 30, -1)).toBe(0)
  })

  it('reads a typed value', () => {
    expect(parseValue('12', 'quantity')).toBe(12)
    expect(parseValue(' 7 ', 'quantity')).toBe(7)
    expect(parseValue('0', 'quantity')).toBe(0)
    expect(parseValue('', 'quantity')).toBeNull()
    expect(parseValue('-3', 'quantity')).toBeNull()
    expect(parseValue('1.5', 'quantity')).toBeNull()
    expect(parseValue('abc', 'quantity')).toBeNull()
    expect(parseValue('2000000', 'quantity')).toBeNull()
    expect(parseValue('2', 'boolean')).toBeNull()
    expect(parseValue('1', 'boolean')).toBe(1)
  })
})

describe('the habit form', () => {
  it('accepts the defaults with a title', () => {
    expect(validateDraft(draft())).toEqual({})
  })

  it('asks for a title', () => {
    expect(validateDraft(draft({ title: '  ' })).title).toBeTruthy()
    expect(validateDraft(draft({ title: 'я'.repeat(201) })).title).toBeTruthy()
    expect(validateDraft(draft({ title: 'я'.repeat(200) })).title).toBeUndefined()
  })

  it('checks the goal of a quantity only', () => {
    expect(validateDraft(draft({ kind: 'quantity', target: '0' })).target).toBeTruthy()
    expect(validateDraft(draft({ kind: 'quantity', target: '8.5' })).target).toBeTruthy()
    expect(validateDraft(draft({ kind: 'quantity', target: '' })).target).toBeTruthy()
    expect(validateDraft(draft({ kind: 'quantity', target: '8' })).target).toBeUndefined()
    expect(validateDraft(draft({ kind: 'boolean', target: 'x' })).target).toBeUndefined()
    expect(validateDraft(draft({ kind: 'quantity', unit: 'x'.repeat(31) })).unit).toBeTruthy()
  })

  it('checks the schedule', () => {
    expect(validateDraft(draft({ frequency: 'weekdays', weekdays: [] })).weekdays).toBeTruthy()
    expect(validateDraft(draft({ frequency: 'weekdays', weekdays: [2] })).weekdays).toBeUndefined()
    expect(
      validateDraft(draft({ frequency: 'times_per_week', timesPerWeek: '0' })).timesPerWeek,
    ).toBeTruthy()
    expect(
      validateDraft(draft({ frequency: 'times_per_week', timesPerWeek: '8' })).timesPerWeek,
    ).toBeTruthy()
    expect(
      validateDraft(draft({ frequency: 'times_per_week', timesPerWeek: '7' })).timesPerWeek,
    ).toBeUndefined()
    // The weekdays of another frequency are not checked.
    expect(validateDraft(draft({ frequency: 'daily', weekdays: [] })).weekdays).toBeUndefined()
  })

  it('checks the place in the grid only when it is on', () => {
    expect(validateDraft(draft({ inGrid: false, time: '', duration: '' }))).toEqual({})
    expect(validateDraft(draft({ inGrid: true, time: '' })).time).toBeTruthy()
    expect(validateDraft(draft({ inGrid: true, duration: '0' })).duration).toBeTruthy()
    expect(validateDraft(draft({ inGrid: true, duration: '1441' })).duration).toBeTruthy()
    expect(validateDraft(draft({ inGrid: true, time: '07:30', duration: '20' }))).toEqual({})
    // A weekly goal has no place in the grid, so it is not checked either.
    expect(validateDraft(draft({ frequency: 'times_per_week', inGrid: true, time: '' }))).toEqual(
      {},
    )
    expect(canBeInGrid({ frequency: 'times_per_week' })).toBe(false)
    expect(canBeInGrid({ frequency: 'weekdays' })).toBe(true)
  })

  it('builds the request for each frequency', () => {
    expect(toInput(draft())).toEqual({
      title: 'Йога',
      kind: 'boolean',
      frequency: 'daily',
      color: '#3b82f6',
    })
    expect(toInput(draft({ frequency: 'weekdays', weekdays: [5, 1] }))).toMatchObject({
      frequency: 'weekdays',
      weekdays: [1, 5],
    })
    expect(toInput(draft({ frequency: 'times_per_week', timesPerWeek: '4' }))).toMatchObject({
      frequency: 'times_per_week',
      times_per_week: 4,
    })
    expect(toInput(draft({ kind: 'quantity', target: '8', unit: ' стаканов ' }))).toMatchObject({
      target_value: 8,
      unit: 'стаканов',
    })
    expect(toInput(draft({ inGrid: true, time: '07:30', duration: '20' })).placement).toEqual({
      time: '07:30',
      duration_minutes: 20,
    })
    // The place in the grid is dropped for a weekly goal.
    expect(toInput(draft({ frequency: 'times_per_week', inGrid: true })).placement).toBeUndefined()
  })

  it('round-trips a habit through a draft without changes', () => {
    for (const h of [
      habit(),
      habit({ kind: 'boolean', target_value: 1, unit: '' }),
      habit({ frequency: 'weekdays', weekdays: [3, 1] }),
      habit({ frequency: 'times_per_week', times_per_week: 4 }),
      habit({ placement: { time: '07:30', duration_minutes: 20 } }),
    ]) {
      expect(hasChanges(h, draftFromHabit(h))).toBe(false)
    }
  })

  it('patches only what changed', () => {
    const h = habit()
    expect(toPatch(h, { ...draftFromHabit(h), title: 'Вода дома' })).toEqual({ title: 'Вода дома' })
    expect(toPatch(h, { ...draftFromHabit(h), target: '10' })).toEqual({ target_value: 10 })
    expect(toPatch(h, { ...draftFromHabit(h), color: '#ef4444' })).toEqual({ color: '#ef4444' })
    // A new schedule is sent whole.
    expect(toPatch(h, { ...draftFromHabit(h), frequency: 'weekdays', weekdays: [2, 4] })).toEqual({
      frequency: 'weekdays',
      weekdays: [2, 4],
    })
    expect(
      toPatch(habit({ frequency: 'weekdays', weekdays: [1, 3] }), {
        ...draftFromHabit(habit({ frequency: 'weekdays', weekdays: [1, 3] })),
        weekdays: [3, 1],
      }),
    ).toEqual({})
    // The kind and the goal of a yes/no habit are never sent.
    const yesno = habit({ kind: 'boolean', target_value: 1, unit: '' })
    expect(toPatch(yesno, { ...draftFromHabit(yesno), target: '5', unit: 'x' })).toEqual({})
  })

  it('works out what to do with the grid', () => {
    const placed = habit({ placement: { time: '07:30', duration_minutes: 20 } })
    expect(placementChange(habit(), draft({ inGrid: false }))).toBeNull()
    expect(
      placementChange(habit(), draft({ inGrid: true, time: '08:00', duration: '15' })),
    ).toEqual({
      kind: 'set',
      placement: { time: '08:00', duration_minutes: 15 },
    })
    expect(placementChange(placed, draftFromHabit(placed))).toBeNull()
    expect(placementChange(placed, { ...draftFromHabit(placed), inGrid: false })).toEqual({
      kind: 'clear',
    })
    expect(placementChange(placed, { ...draftFromHabit(placed), duration: '25' })).toEqual({
      kind: 'set',
      placement: { time: '07:30', duration_minutes: 25 },
    })
    // Becoming a weekly goal takes the habit out of the grid.
    expect(
      placementChange(placed, { ...draftFromHabit(placed), frequency: 'times_per_week' }),
    ).toEqual({
      kind: 'clear',
    })
  })
})

describe('heatmapRange', () => {
  it('runs from the Monday of the oldest week to the Sunday of this one', () => {
    // Wednesday 14 October 2026.
    expect(heatmapRange('2026-10-14', 2)).toEqual({ from: '2026-10-05', to: '2026-10-18' })
    expect(heatmapRange('2026-10-12', 1)).toEqual({ from: '2026-10-12', to: '2026-10-18' })
    expect(heatmapRange('2026-10-18', 1)).toEqual({ from: '2026-10-12', to: '2026-10-18' })
    const { from, to } = heatmapRange('2026-10-14')
    expect((Date.parse(to) - Date.parse(from)) / 864e5 + 1).toBe(18 * 7)
  })
})

describe('buildHeatmap', () => {
  const day = (date: string, value = 0, done = false, planned = true): HabitDay => ({
    date,
    value,
    done,
    planned,
  })
  const week = (start: string, make: (i: number, date: string) => HabitDay): HabitDay[] =>
    Array.from({ length: 7 }, (_, i) => {
      const d = new Date(Date.UTC(2026, 9, Number(start.slice(8)) + i)).toISOString().slice(0, 10)
      return make(i, d)
    })

  it('lays days out as weeks, Monday first', () => {
    const days = [...week('2026-10-05', (_, d) => day(d)), ...week('2026-10-12', (_, d) => day(d))]
    const map = buildHeatmap(days, 1, '2026-10-14', false)
    expect(map.weeks).toHaveLength(2)
    expect(map.weeks[0]![0]!.date).toBe('2026-10-05')
    expect(map.weeks[0]![6]!.date).toBe('2026-10-11')
    expect(map.weeks[1]![2]!.date).toBe('2026-10-14')
  })

  it('pads an incomplete first week', () => {
    const map = buildHeatmap([day('2026-10-07'), day('2026-10-08')], 1, '2026-10-14', false)
    expect(map.weeks[0]!.map((c) => c?.date ?? null)).toEqual([
      null,
      null,
      '2026-10-07',
      '2026-10-08',
      null,
      null,
      null,
    ])
  })

  it('grades a day by the share of the goal', () => {
    const days = [
      day('2026-10-05', 0),
      day('2026-10-06', 2),
      day('2026-10-07', 4),
      day('2026-10-08', 7),
      day('2026-10-09', 8, true),
      day('2026-10-10', 12, true),
    ]
    const cells = buildHeatmap(days, 8, '2026-10-14', false).weeks[0]!.map((c) => c?.level)
    expect(cells.slice(0, 6)).toEqual([0, 1, 2, 3, 4, 4])
  })

  it('marks unscheduled days as off, except for a weekly goal and for a day with a mark', () => {
    const days = [day('2026-10-05', 0, false, false), day('2026-10-06', 1, true, false)]
    const own = buildHeatmap(days, 1, '2026-10-14', false).weeks[0]!
    expect(own[0]!.off).toBe(true)
    expect(own[1]!.off).toBe(false)
    expect(buildHeatmap(days, 1, '2026-10-14', true).weeks[0]![0]!.off).toBe(false)
  })

  it('marks the days that have not come', () => {
    const map = buildHeatmap([day('2026-10-14'), day('2026-10-15')], 1, '2026-10-14', false)
    expect(map.weeks[0]![2]!.future).toBe(false)
    expect(map.weeks[0]![3]!.future).toBe(true)
  })

  it('labels each month once, at the week whose Monday is in it', () => {
    const days: HabitDay[] = []
    for (let i = 0; i < 35; i++) {
      const d = new Date(Date.UTC(2026, 8, 28 + i)).toISOString().slice(0, 10) // 28 Sep … 1 Nov
      days.push(day(d))
    }
    const map = buildHeatmap(days, 1, '2026-11-30', false)
    // Mondays: 28 Sep, 5, 12, 19, 26 Oct.
    expect(map.monthStarts).toEqual([
      { week: 0, month: 9 },
      { week: 1, month: 10 },
    ])
  })
})
