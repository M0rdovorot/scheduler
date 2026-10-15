import { describe, expect, it } from 'vitest'
import { segmentOnDay, wallMinutes } from './segments'

const d = (iso: string) => new Date(iso)

describe('wallMinutes', () => {
  it('counts minutes by the zone clock', () => {
    // 10:00 in Moscow (UTC+3) is 07:00 UTC.
    expect(wallMinutes(d('2026-10-14T07:00:00Z'), '2026-10-14', 'Europe/Moscow')).toBe(600)
    expect(wallMinutes(d('2026-10-14T07:00:00Z'), '2026-10-14', 'UTC')).toBe(420)
  })

  it('is negative before the day and beyond 1440 after it', () => {
    expect(wallMinutes(d('2026-10-13T23:00:00Z'), '2026-10-14', 'UTC')).toBe(-60)
    expect(wallMinutes(d('2026-10-15T01:00:00Z'), '2026-10-14', 'UTC')).toBe(1500)
  })

  it('includes seconds as a fraction', () => {
    expect(wallMinutes(d('2026-10-14T00:00:30Z'), '2026-10-14', 'UTC')).toBe(0.5)
  })

  it('keeps wall-clock times on a day when the clocks change', () => {
    // US clocks go back on 2026-11-01 at 02:00 EDT → 01:00 EST.
    const tz = 'America/New_York'
    expect(wallMinutes(d('2026-11-01T14:00:00Z'), '2026-11-01', tz)).toBe(9 * 60) // 09:00 EST
    expect(wallMinutes(d('2026-11-01T04:30:00Z'), '2026-11-01', tz)).toBe(30) // 00:30 EDT
  })
})

describe('segmentOnDay', () => {
  const tz = 'UTC'
  const day = '2026-10-14'

  it('returns a task inside the day as is', () => {
    expect(segmentOnDay(d('2026-10-14T10:00:00Z'), d('2026-10-14T11:30:00Z'), day, tz)).toEqual({
      startMin: 600,
      endMin: 690,
      continuesBefore: false,
      continuesAfter: false,
    })
  })

  it('clips a task that continues after midnight (FR-3.5)', () => {
    const start = d('2026-10-14T22:00:00Z')
    const end = d('2026-10-15T06:00:00Z')
    expect(segmentOnDay(start, end, '2026-10-14', tz)).toEqual({
      startMin: 1320,
      endMin: 1440,
      continuesBefore: false,
      continuesAfter: true,
    })
    expect(segmentOnDay(start, end, '2026-10-15', tz)).toEqual({
      startMin: 0,
      endMin: 360,
      continuesBefore: true,
      continuesAfter: false,
    })
  })

  it('fills the middle days of a multi-day task', () => {
    const seg = segmentOnDay(d('2026-10-13T12:00:00Z'), d('2026-10-15T12:00:00Z'), day, tz)
    expect(seg).toEqual({ startMin: 0, endMin: 1440, continuesBefore: true, continuesAfter: true })
  })

  it('does not touch neighbouring days when it ends exactly at midnight', () => {
    const start = d('2026-10-14T23:00:00Z')
    const end = d('2026-10-15T00:00:00Z')
    expect(segmentOnDay(start, end, '2026-10-14', tz)).toMatchObject({
      startMin: 1380,
      endMin: 1440,
      continuesAfter: false,
    })
    expect(segmentOnDay(start, end, '2026-10-15', tz)).toBeNull()
  })

  it('returns null for days it does not reach', () => {
    const start = d('2026-10-14T10:00:00Z')
    const end = d('2026-10-14T11:00:00Z')
    expect(segmentOnDay(start, end, '2026-10-13', tz)).toBeNull()
    expect(segmentOnDay(start, end, '2026-10-15', tz)).toBeNull()
  })

  it('uses the user time zone to decide which day a task belongs to', () => {
    // 21:30–23:00 UTC is already 00:30–02:00 on the 15th in Moscow.
    const start = d('2026-10-14T21:30:00Z')
    const end = d('2026-10-14T23:00:00Z')
    expect(segmentOnDay(start, end, '2026-10-14', 'Europe/Moscow')).toBeNull()
    expect(segmentOnDay(start, end, '2026-10-15', 'Europe/Moscow')).toMatchObject({
      startMin: 30,
      endMin: 120,
    })
  })
})
