import { describe, expect, it } from 'vitest'
import {
  defaultRepeat,
  describeRepeat,
  fromRRule,
  isLastWeekdayOfMonth,
  monthlyModes,
  nthWeekdayOfMonth,
  plural,
  sameRepeat,
  toRRule,
  untilFor,
  validateRepeat,
  withFreq,
  type Repeat,
} from './repeat'

const tz = 'Europe/Moscow'
const WED = '2026-10-14' // the 2nd Wednesday of October 2026
const base = (over: Partial<Repeat>): Repeat => ({
  freq: 'daily',
  interval: 1,
  weekdays: [],
  monthly: 'monthday',
  end: { kind: 'never' },
  ...over,
})

describe('toRRule', () => {
  it.each([
    [base({}), 'FREQ=DAILY'],
    [base({ interval: 3 }), 'FREQ=DAILY;INTERVAL=3'],
    [base({ freq: 'weekly', weekdays: [4, 0, 2] }), 'FREQ=WEEKLY;BYDAY=MO,WE,FR'],
    [base({ freq: 'weekly', interval: 2, weekdays: [1] }), 'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU'],
    [base({ freq: 'weekly', weekdays: [0, 0, 2] }), 'FREQ=WEEKLY;BYDAY=MO,WE'],
    [base({ freq: 'monthly', monthly: 'monthday' }), 'FREQ=MONTHLY;BYMONTHDAY=14'],
    [base({ freq: 'monthly', monthly: 'nth' }), 'FREQ=MONTHLY;BYDAY=2WE'],
    [base({ freq: 'yearly' }), 'FREQ=YEARLY'],
    [base({ freq: 'yearly', interval: 2 }), 'FREQ=YEARLY;INTERVAL=2'],
    [base({ end: { kind: 'count', count: 10 } }), 'FREQ=DAILY;COUNT=10'],
  ])('writes %j as %s', (repeat, want) => {
    expect(toRRule(repeat, WED, tz)).toBe(want)
  })

  it('writes the last weekday of the month', () => {
    expect(toRRule(base({ freq: 'monthly', monthly: 'last' }), '2026-10-28', tz)).toBe(
      'FREQ=MONTHLY;BYDAY=-1WE',
    )
  })

  it('writes the end date as the last moment of that day in the time zone', () => {
    // 31 Dec 2026, 23:59:59 in Moscow (UTC+3) is 20:59:59 UTC.
    expect(toRRule(base({ end: { kind: 'until', day: '2026-12-31' } }), WED, tz)).toBe(
      'FREQ=DAILY;UNTIL=20261231T205959Z',
    )
    expect(untilFor('2026-12-31', 'UTC')).toBe('20261231T235959Z')
    expect(untilFor('2026-12-31', 'Pacific/Auckland')).toBe('20261231T105959Z')
  })

  it('keeps the end date on its own day across a clock change', () => {
    // New York leaves daylight time on 2026-11-01 (the day is 25 hours long).
    expect(untilFor('2026-11-01', 'America/New_York')).toBe('20261102T045959Z')
  })
})

describe('fromRRule', () => {
  const roundTrips = [
    base({}),
    base({ interval: 3 }),
    base({ freq: 'weekly', weekdays: [0, 2, 4] }),
    base({ freq: 'weekly', interval: 2, weekdays: [1] }),
    base({ freq: 'monthly', monthly: 'monthday' }),
    base({ freq: 'monthly', monthly: 'nth' }),
    base({ freq: 'yearly', interval: 5 }),
    base({ end: { kind: 'count', count: 7 } }),
    base({ end: { kind: 'until', day: '2026-12-31' } }),
    base({ freq: 'weekly', weekdays: [5], end: { kind: 'until', day: '2027-01-01' } }),
  ]
  it.each(roundTrips)('reads back %j', (repeat) => {
    expect(fromRRule(toRRule(repeat, WED, tz), WED, tz)).toEqual(repeat)
  })

  it('reads the last weekday of the month', () => {
    const repeat = base({ freq: 'monthly', monthly: 'last' })
    expect(fromRRule(toRRule(repeat, '2026-10-28', tz), '2026-10-28', tz)).toEqual(repeat)
  })

  it('round-trips the end date in any zone', () => {
    for (const zone of [
      'UTC',
      'Europe/Moscow',
      'Pacific/Auckland',
      'America/Los_Angeles',
      'Asia/Kolkata',
    ]) {
      const repeat = base({ end: { kind: 'until', day: '2026-12-31' } })
      expect(fromRRule(toRRule(repeat, WED, zone), WED, zone)).toEqual(repeat)
    }
  })

  it('uses the weekday of the start for a weekly rule without BYDAY', () => {
    expect(fromRRule('FREQ=WEEKLY', WED, tz)?.weekdays).toEqual([2])
  })

  it.each([
    '',
    'garbage',
    'FREQ=HOURLY',
    'FREQ=DAILY;BYHOUR=9',
    'FREQ=DAILY;INTERVAL=0',
    'FREQ=DAILY;FREQ=WEEKLY',
    'FREQ=WEEKLY;BYDAY=XX',
    'FREQ=MONTHLY;BYDAY=MO',
    'FREQ=DAILY;BYDAY=MO',
    'FREQ=DAILY;UNTIL=20261231',
  ])('gives up on %j', (rrule) => {
    expect(fromRRule(rrule, WED, tz)).toBeNull()
  })
})

describe('monthly helpers', () => {
  it('finds which weekday of the month a date is', () => {
    expect(nthWeekdayOfMonth('2026-10-01')).toBe(1)
    expect(nthWeekdayOfMonth('2026-10-07')).toBe(1)
    expect(nthWeekdayOfMonth('2026-10-08')).toBe(2)
    expect(nthWeekdayOfMonth('2026-10-14')).toBe(2)
    expect(nthWeekdayOfMonth('2026-10-29')).toBe(5)
  })

  it('detects the last weekday of the month', () => {
    expect(isLastWeekdayOfMonth('2026-10-28')).toBe(true)
    expect(isLastWeekdayOfMonth('2026-10-31')).toBe(true)
    expect(isLastWeekdayOfMonth('2026-10-24')).toBe(false)
    expect(isLastWeekdayOfMonth('2028-02-22')).toBe(false) // leap year: 29 days
    expect(isLastWeekdayOfMonth('2028-02-23')).toBe(true)
  })

  it('offers only the modes that fit the start date', () => {
    expect(monthlyModes('2026-10-14')).toEqual(['monthday', 'nth'])
    expect(monthlyModes('2026-10-28')).toEqual(['monthday', 'nth', 'last']) // the 4th Wednesday is also the last
    expect(monthlyModes('2026-10-22')).toEqual(['monthday', 'nth']) // the 4th Thursday, not the last
    expect(monthlyModes('2026-10-29')).toEqual(['monthday', 'last']) // a 5th weekday is only "last"
  })
})

describe('defaultRepeat / withFreq', () => {
  it('starts a weekly repeat on the weekday of the start date', () => {
    expect(defaultRepeat('weekly', WED).weekdays).toEqual([2])
    expect(defaultRepeat('daily', WED).weekdays).toEqual([])
  })

  it('keeps the interval and the end when the frequency changes', () => {
    const repeat = base({
      freq: 'weekly',
      interval: 3,
      weekdays: [0, 1],
      end: { kind: 'count', count: 5 },
    })
    expect(withFreq(repeat, 'monthly', WED)).toEqual(
      base({ freq: 'monthly', interval: 3, end: { kind: 'count', count: 5 } }),
    )
    expect(withFreq(base({}), 'weekly', WED).weekdays).toEqual([2])
  })
})

describe('validateRepeat', () => {
  it('accepts a normal rule', () => {
    expect(validateRepeat(defaultRepeat('weekly', WED), WED)).toEqual({})
  })

  it.each([0, -1, 1.5, 1000, NaN])('rejects the interval %s', (interval) => {
    expect(validateRepeat(base({ interval }), WED).interval).toBeDefined()
  })

  it('needs a weekday for a weekly rule', () => {
    expect(validateRepeat(base({ freq: 'weekly', weekdays: [] }), WED).weekdays).toBeDefined()
  })

  it('checks the end', () => {
    expect(validateRepeat(base({ end: { kind: 'count', count: 0 } }), WED).end).toBeDefined()
    expect(validateRepeat(base({ end: { kind: 'count', count: 1001 } }), WED).end).toBeDefined()
    expect(validateRepeat(base({ end: { kind: 'count', count: 1000 } }), WED).end).toBeUndefined()
    expect(
      validateRepeat(base({ end: { kind: 'until', day: '2026-10-13' } }), WED).end,
    ).toBeDefined()
    expect(
      validateRepeat(base({ end: { kind: 'until', day: '2026-10-14' } }), WED).end,
    ).toBeUndefined()
    expect(validateRepeat(base({ end: { kind: 'until', day: '' } }), WED).end).toBeDefined()
  })
})

describe('sameRepeat', () => {
  it('compares by the RRULE they produce', () => {
    const a = base({ freq: 'weekly', weekdays: [0, 2] })
    expect(sameRepeat(a, base({ freq: 'weekly', weekdays: [2, 0] }), WED, tz)).toBe(true)
    expect(sameRepeat(a, base({ freq: 'weekly', weekdays: [0] }), WED, tz)).toBe(false)
    expect(sameRepeat(null, null, WED, tz)).toBe(true)
    expect(sameRepeat(a, null, WED, tz)).toBe(false)
  })
})

describe('plural', () => {
  it.each([
    [1, 'день'],
    [2, 'дня'],
    [4, 'дня'],
    [5, 'дней'],
    [11, 'дней'],
    [12, 'дней'],
    [14, 'дней'],
    [21, 'день'],
    [22, 'дня'],
    [25, 'дней'],
    [101, 'день'],
    [111, 'дней'],
  ])('%i → %s', (n, want) => {
    expect(plural(n, 'день', 'дня', 'дней')).toBe(want)
  })
})

describe('describeRepeat', () => {
  it.each([
    [base({}), 'Ежедневно'],
    [base({ interval: 2 }), 'Каждые 2 дня'],
    [base({ interval: 5 }), 'Каждые 5 дней'],
    [base({ interval: 21 }), 'Каждый 21 день'],
    [base({ interval: 11 }), 'Каждые 11 дней'],
    [base({ freq: 'weekly', weekdays: [0, 2] }), 'Еженедельно: пн, ср'],
    [base({ freq: 'weekly', interval: 2, weekdays: [4] }), 'Каждые 2 недели: пт'],
    [base({ freq: 'weekly', interval: 5, weekdays: [4] }), 'Каждые 5 недель: пт'],
    [base({ freq: 'weekly', interval: 21, weekdays: [4] }), 'Каждую 21 неделю: пт'],
    [base({ freq: 'monthly', monthly: 'monthday' }), 'Ежемесячно, 14-го числа'],
    [base({ freq: 'monthly', monthly: 'nth' }), 'Ежемесячно, 2-й ср'],
    [base({ freq: 'monthly', interval: 3, monthly: 'monthday' }), 'Каждые 3 месяца, 14-го числа'],
    [base({ freq: 'monthly', interval: 6, monthly: 'monthday' }), 'Каждые 6 месяцев, 14-го числа'],
    [base({ freq: 'yearly' }), 'Ежегодно'],
    [base({ freq: 'yearly', interval: 2 }), 'Каждые 2 года'],
    [base({ freq: 'yearly', interval: 5 }), 'Каждые 5 лет'],
    [base({ end: { kind: 'count', count: 10 } }), 'Ежедневно, 10 раз'],
    [base({ end: { kind: 'count', count: 3 } }), 'Ежедневно, 3 раза'],
    [base({ end: { kind: 'count', count: 21 } }), 'Ежедневно, 21 раз'],
    [base({ end: { kind: 'until', day: '2026-12-31' } }), 'Ежедневно, до 31.12.2026'],
    [
      base({ freq: 'weekly', weekdays: [0], end: { kind: 'until', day: '2027-01-05' } }),
      'Еженедельно: пн, до 05.01.2027',
    ],
  ])('describes %j', (repeat, want) => {
    expect(describeRepeat(repeat, WED)).toBe(want)
  })

  it('describes the last weekday of the month', () => {
    expect(describeRepeat(base({ freq: 'monthly', monthly: 'last' }), '2026-10-28')).toBe(
      'Ежемесячно, последний ср',
    )
  })
})
