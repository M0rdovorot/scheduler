import { describe, expect, it } from 'vitest'
import { daysFrom, formatDuration, formatSlot, freeByDay, parseTimeOfDay } from './freeTime'

const tz = 'Europe/Moscow' // UTC+3, no daylight saving
const all = { minMinutes: 1, fromMin: 0, toMin: 1440 }

// Moscow 2026-10-14 from 10:00 to 12:30 is 07:00–09:30 UTC.
const free = (start: string, end: string) => ({ start, end })

describe('freeByDay', () => {
  it('turns a stretch into local minutes of its day', () => {
    const got = freeByDay(
      [free('2026-10-14T07:00:00Z', '2026-10-14T09:30:00Z')],
      daysFrom('2026-10-14', 2),
      tz,
      all,
    )
    expect(got).toEqual([{ day: '2026-10-14', slots: [{ startMin: 600, endMin: 750 }] }])
  })

  it('splits a stretch over midnight between the days', () => {
    // 22:00 on the 14th to 02:00 on the 15th, Moscow.
    const got = freeByDay(
      [free('2026-10-14T19:00:00Z', '2026-10-14T23:00:00Z')],
      daysFrom('2026-10-14', 2),
      tz,
      all,
    )
    expect(got).toEqual([
      { day: '2026-10-14', slots: [{ startMin: 1320, endMin: 1440 }] },
      { day: '2026-10-15', slots: [{ startMin: 0, endMin: 120 }] },
    ])
  })

  it('keeps only the hours the person is awake', () => {
    const got = freeByDay(
      [free('2026-10-14T00:00:00Z', '2026-10-14T21:00:00Z')], // 03:00–24:00 Moscow
      ['2026-10-14'],
      tz,
      { minMinutes: 1, fromMin: 9 * 60, toMin: 21 * 60 },
    )
    expect(got[0]?.slots).toEqual([{ startMin: 540, endMin: 1260 }])
  })

  it('drops what became too short after the cut', () => {
    // 20:30–23:00 Moscow, awake until 21:00: only 30 minutes are left.
    const stretch = free('2026-10-14T17:30:00Z', '2026-10-14T20:00:00Z')
    const filter = { minMinutes: 60, fromMin: 9 * 60, toMin: 21 * 60 }
    expect(freeByDay([stretch], ['2026-10-14'], tz, filter)).toEqual([])
    expect(freeByDay([stretch], ['2026-10-14'], tz, { ...filter, minMinutes: 30 })).toHaveLength(1)
  })

  it('lists no day without free time and keeps the order of the days', () => {
    const got = freeByDay(
      [
        free('2026-10-16T07:00:00Z', '2026-10-16T08:00:00Z'),
        free('2026-10-14T07:00:00Z', '2026-10-14T08:00:00Z'),
      ],
      daysFrom('2026-10-14', 4),
      tz,
      all,
    )
    expect(got.map((d) => d.day)).toEqual(['2026-10-14', '2026-10-16'])
  })

  it('has nothing for no free time', () => {
    expect(freeByDay([], daysFrom('2026-10-14', 3), tz, all)).toEqual([])
  })
})

describe('daysFrom', () => {
  it('counts calendar days across a month end', () => {
    expect(daysFrom('2026-10-30', 3)).toEqual(['2026-10-30', '2026-10-31', '2026-11-01'])
  })
})

describe('formatDuration', () => {
  it.each([
    [45, '45 мин'],
    [60, '1 ч'],
    [210, '3 ч 30 мин'],
    [1440, '24 ч'],
  ])('%i minutes is %s', (minutes, text) => {
    expect(formatDuration(minutes)).toBe(text)
  })
})

describe('formatSlot', () => {
  it('writes the times of the day', () => {
    expect(formatSlot({ startMin: 540, endMin: 725 })).toBe('09:00–12:05')
  })
})

describe('parseTimeOfDay', () => {
  it('reads a time of day in minutes', () => {
    expect(parseTimeOfDay('09:30')).toBe(570)
    expect(parseTimeOfDay('00:00')).toBe(0)
  })

  it('rejects what is not a time', () => {
    expect(parseTimeOfDay('')).toBeNull()
    expect(parseTimeOfDay('24:00')).toBeNull()
    expect(parseTimeOfDay('9:30')).toBeNull()
  })
})
