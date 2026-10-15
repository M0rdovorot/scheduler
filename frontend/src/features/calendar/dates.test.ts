import { describe, expect, it } from 'vitest'
import {
  addDays,
  dayRange,
  dayStart,
  rangeLabel,
  shiftAnchor,
  todayIn,
  visibleDays,
  weekStart,
  weekdayIndex,
} from './dates'

describe('addDays', () => {
  it.each([
    ['2026-10-14', 1, '2026-10-15'],
    ['2026-10-31', 1, '2026-11-01'],
    ['2026-12-31', 1, '2027-01-01'],
    ['2026-03-01', -1, '2026-02-28'],
    ['2028-03-01', -1, '2028-02-29'],
    ['2026-10-14', 0, '2026-10-14'],
    ['2026-10-14', 30, '2026-11-13'],
  ])('%s %+d → %s', (day, n, want) => {
    expect(addDays(day, n)).toBe(want)
  })
})

describe('weekdayIndex / weekStart', () => {
  it('counts Monday as 0 and Sunday as 6', () => {
    expect(weekdayIndex('2026-10-12')).toBe(0) // Monday
    expect(weekdayIndex('2026-10-14')).toBe(2) // Wednesday
    expect(weekdayIndex('2026-10-18')).toBe(6) // Sunday
  })

  it('starts the week on Monday', () => {
    expect(weekStart('2026-10-12')).toBe('2026-10-12')
    expect(weekStart('2026-10-14')).toBe('2026-10-12')
    expect(weekStart('2026-10-18')).toBe('2026-10-12')
    expect(weekStart('2026-10-19')).toBe('2026-10-19')
  })

  it('crosses month and year boundaries', () => {
    expect(weekStart('2027-01-01')).toBe('2026-12-28')
  })
})

describe('visibleDays', () => {
  it('shows one day', () => {
    expect(visibleDays('day', '2026-10-14')).toEqual(['2026-10-14'])
  })

  it('shows yesterday, the anchor and tomorrow for three days', () => {
    expect(visibleDays('three_days', '2026-10-14')).toEqual([
      '2026-10-13',
      '2026-10-14',
      '2026-10-15',
    ])
  })

  it('shows Monday to Sunday for a week', () => {
    const days = visibleDays('week', '2026-10-18')
    expect(days).toHaveLength(7)
    expect(days[0]).toBe('2026-10-12')
    expect(days[6]).toBe('2026-10-18')
  })
})

describe('shiftAnchor', () => {
  it.each([
    ['day', 1, '2026-10-15'],
    ['day', -1, '2026-10-13'],
    ['three_days', 1, '2026-10-17'],
    ['three_days', -1, '2026-10-11'],
    ['week', 1, '2026-10-21'],
    ['week', -1, '2026-10-07'],
  ] as const)('%s %i', (view, dir, want) => {
    expect(shiftAnchor(view, '2026-10-14', dir)).toBe(want)
  })

  it('moves three-day views by whole views, with no overlap', () => {
    const next = shiftAnchor('three_days', '2026-10-14', 1)
    expect(visibleDays('three_days', next)[0]).toBe('2026-10-16')
  })
})

describe('todayIn', () => {
  it('uses the date in the given zone, not UTC', () => {
    const instant = new Date('2026-10-14T22:30:00Z')
    expect(todayIn('UTC', instant)).toBe('2026-10-14')
    expect(todayIn('Europe/Moscow', instant)).toBe('2026-10-15')
    expect(todayIn('America/Los_Angeles', instant)).toBe('2026-10-14')
    expect(todayIn('Pacific/Auckland', instant)).toBe('2026-10-15')
  })
})

describe('dayStart / dayRange', () => {
  it('is local midnight as an instant', () => {
    expect(dayStart('2026-10-14', 'UTC').toISOString()).toBe('2026-10-14T00:00:00.000Z')
    expect(dayStart('2026-10-14', 'Europe/Moscow').toISOString()).toBe('2026-10-13T21:00:00.000Z')
    expect(dayStart('2026-10-14', 'Asia/Kolkata').toISOString()).toBe('2026-10-13T18:30:00.000Z')
  })

  it('follows daylight saving time', () => {
    // New York leaves DST on 2026-11-01: that day is 25 hours long.
    const start = dayStart('2026-11-01', 'America/New_York')
    const next = dayStart('2026-11-02', 'America/New_York')
    expect(start.toISOString()).toBe('2026-11-01T04:00:00.000Z')
    expect(next.toISOString()).toBe('2026-11-02T05:00:00.000Z')
    expect((next.getTime() - start.getTime()) / 3600_000).toBe(25)
  })

  it('covers [first day, day after the last)', () => {
    const { from, to } = dayRange(['2026-10-13', '2026-10-14', '2026-10-15'], 'UTC')
    expect(from.toISOString()).toBe('2026-10-13T00:00:00.000Z')
    expect(to.toISOString()).toBe('2026-10-16T00:00:00.000Z')
  })
})

describe('rangeLabel', () => {
  it('shows a single day or a range', () => {
    expect(rangeLabel(['2026-10-14'])).toMatch(/14\s+окт/)
    expect(rangeLabel(['2026-10-12', '2026-10-18'])).toMatch(/12\s+окт.*18\s+окт/)
    expect(rangeLabel([])).toBe('')
  })

  it('adds the year only when the range is outside the current year', () => {
    expect(rangeLabel(['2026-10-14'], 2026)).not.toMatch(/2026/)
    expect(rangeLabel(['2027-01-05'], 2026)).toMatch(/2027/)
    // A week across New Year: both ends get a year, so the end is not mistaken for this year.
    expect(rangeLabel(['2026-12-28', '2027-01-03'], 2026)).toMatch(/2026.*2027/)
    expect(rangeLabel(['2025-12-29', '2026-01-04'], 2026)).toMatch(/2025.*2026/)
  })
})
