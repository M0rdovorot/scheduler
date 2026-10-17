import { describe, expect, it } from 'vitest'
import type { ReminderRule } from '@/api/types'
import {
  amountLabel,
  draftFromRule,
  draftMinutes,
  kindsFor,
  newDraft,
  quietDraft,
  quietError,
  quietFromDraft,
  ruleFromDraft,
  ruleLabel,
  rulesFromDrafts,
  validateDrafts,
  type RuleDraft,
} from './rules'

const task = (kind: ReminderRule['kind'], offset: number): ReminderRule => ({
  kind,
  offset_minutes: offset,
  time_of_day: null,
})
const draft = (over: Partial<RuleDraft> = {}): RuleDraft => ({
  kind: 'before_start',
  amount: '10',
  unit: 'minute',
  time: '',
  ...over,
})

describe('amounts', () => {
  it.each([
    [0, '0 минут'],
    [1, '1 минута'],
    [10, '10 минут'],
    [21, '21 минута'],
    [60, '1 час'],
    [120, '2 часа'],
    [300, '5 часов'],
    [90, '90 минут'],
    [1440, '1 день'],
    [2880, '2 дня'],
    [10080, '7 дней'],
  ])('%i → %s', (minutes, want) => {
    expect(amountLabel(minutes)).toBe(want)
  })
})

describe('rule labels', () => {
  it.each([
    [task('before_start', 10), 'За 10 минут до начала'],
    [task('before_start', 1440), 'За 1 день до начала'],
    [task('before_start', 0), 'В момент начала'],
    [task('after_end', 0), 'Сразу после окончания'],
    [task('after_end', 15), 'Через 15 минут после окончания'],
    [task('not_started', 15), 'Через 15 минут после начала, если не начато'],
    [task('overrun', 60), 'Через 1 час после окончания, если таймер идёт'],
    [{ kind: 'habit_time', offset_minutes: null, time_of_day: '21:00' } as ReminderRule, 'В 21:00'],
  ])('%j → %s', (rule, want) => {
    expect(ruleLabel(rule)).toBe(want)
  })
})

describe('drafts', () => {
  it('shows an offset in the largest exact unit', () => {
    expect(draftFromRule(task('before_start', 10))).toMatchObject({ amount: '10', unit: 'minute' })
    expect(draftFromRule(task('before_start', 120))).toMatchObject({ amount: '2', unit: 'hour' })
    expect(draftFromRule(task('before_start', 1440))).toMatchObject({ amount: '1', unit: 'day' })
    expect(draftFromRule(task('before_start', 90))).toMatchObject({ amount: '90', unit: 'minute' })
    expect(draftFromRule(task('after_end', 0))).toMatchObject({ amount: '0', unit: 'minute' })
  })

  it('round-trips every rule', () => {
    for (const minutes of [0, 5, 10, 59, 60, 90, 120, 1440, 4320, 10080]) {
      const rule = task('after_end', minutes)
      expect(ruleFromDraft(draftFromRule(rule))).toEqual(rule)
    }
    const habit: ReminderRule = { kind: 'habit_time', offset_minutes: null, time_of_day: '07:05' }
    expect(ruleFromDraft(draftFromRule(habit))).toEqual(habit)
  })

  it('turns the typed amount into minutes by the unit', () => {
    expect(draftMinutes(draft({ amount: '2', unit: 'hour' }))).toBe(120)
    expect(draftMinutes(draft({ amount: '3', unit: 'day' }))).toBe(4320)
    expect(draftMinutes(draft({ amount: '7', unit: 'day' }))).toBe(10080)
    expect(draftMinutes(draft({ amount: '8', unit: 'day' }))).toBeNull()
    expect(draftMinutes(draft({ amount: '10081' }))).toBeNull()
    expect(draftMinutes(draft({ amount: '' }))).toBeNull()
    expect(draftMinutes(draft({ amount: '1.5' }))).toBeNull()
    expect(draftMinutes(draft({ amount: '-5' }))).toBeNull()
    expect(draftMinutes(draft({ amount: ' 15 ' }))).toBe(15)
  })

  it('checks a habit time', () => {
    const habit = (time: string): RuleDraft => ({
      kind: 'habit_time',
      amount: '',
      unit: 'minute',
      time,
    })
    expect(ruleFromDraft(habit('21:30'))).toEqual({
      kind: 'habit_time',
      offset_minutes: null,
      time_of_day: '21:30',
    })
    expect(ruleFromDraft(habit(''))).toBeNull()
    expect(ruleFromDraft(habit('24:00'))).toBeNull()
    expect(ruleFromDraft(habit('7:30'))).toBeNull()
  })

  it('reports the drafts that cannot be saved by their place in the list', () => {
    const errors = validateDrafts([
      draft(),
      draft({ amount: 'x' }),
      draft({ kind: 'habit_time', time: '' }),
    ])
    expect(Object.keys(errors)).toEqual(['1', '2'])
    expect(validateDrafts([])).toEqual({})
  })

  it('sends valid rules, each once', () => {
    const rules = rulesFromDrafts([
      draft({ amount: '10' }),
      draft({ amount: '600', unit: 'minute' }),
      draft({ amount: '10', unit: 'minute' }), // the same as the first
      draft({ amount: '1', unit: 'hour' }),
      draft({ amount: 'nope' }),
    ])
    expect(rules.map((r) => r.offset_minutes)).toEqual([10, 600, 60])
  })

  it('offers a habit times of day and a task its four kinds', () => {
    expect(kindsFor('habit')).toEqual(['habit_time'])
    expect(kindsFor('category')).toEqual(['before_start', 'after_end', 'not_started', 'overrun'])
    expect(kindsFor('global')).toHaveLength(4)
    expect(newDraft('habit').kind).toBe('habit_time')
    expect(newDraft('instance').kind).toBe('before_start')
  })
})

describe('quiet hours', () => {
  it('starts as off at 23:00–08:00', () => {
    expect(quietDraft(null)).toEqual({ on: false, start: '23:00', end: '08:00' })
    expect(quietDraft({ start: '22:00', end: '07:30' })).toEqual({
      on: true,
      start: '22:00',
      end: '07:30',
    })
  })

  it('is only checked when on', () => {
    expect(quietError({ on: false, start: '', end: '' })).toBeNull()
    expect(quietError({ on: true, start: '23:00', end: '08:00' })).toBeNull()
    expect(quietError({ on: true, start: '08:00', end: '08:00' })).toMatch(/не должны совпадать/)
    expect(quietError({ on: true, start: '', end: '08:00' })).toMatch(/Укажите/)
  })

  it('goes to the API as null or the pair', () => {
    expect(quietFromDraft({ on: false, start: '23:00', end: '08:00' })).toBeNull()
    expect(quietFromDraft({ on: true, start: '23:00', end: '08:00' })).toEqual({
      start: '23:00',
      end: '08:00',
    })
  })
})
