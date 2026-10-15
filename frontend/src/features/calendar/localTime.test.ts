import { describe, expect, it } from 'vitest'
import { formatTimeRange, fromLocalInput, toLocalInput } from './localTime'

describe('fromLocalInput', () => {
  it('reads the value in the given zone', () => {
    expect(fromLocalInput('2026-10-14T10:00', 'UTC')?.toISOString()).toBe(
      '2026-10-14T10:00:00.000Z',
    )
    expect(fromLocalInput('2026-10-14T10:00', 'Europe/Moscow')?.toISOString()).toBe(
      '2026-10-14T07:00:00.000Z',
    )
    expect(fromLocalInput('2026-10-14T10:00', 'America/New_York')?.toISOString()).toBe(
      '2026-10-14T14:00:00.000Z',
    )
  })

  it.each([
    '',
    'tomorrow',
    '2026-10-14',
    '2026-10-14T10',
    '2026-13-01T10:00',
    '2026-02-30T10:00',
    '2026-10-14T24:00',
    '2026-10-14T10:60',
  ])('rejects %j', (value) => {
    expect(fromLocalInput(value, 'UTC')).toBeNull()
  })

  it('accepts a leap day only in a leap year', () => {
    expect(fromLocalInput('2028-02-29T10:00', 'UTC')).not.toBeNull()
    expect(fromLocalInput('2026-02-29T10:00', 'UTC')).toBeNull()
  })

  it('moves a time that is skipped when the clocks go forward', () => {
    // 2026-03-08 in New York: 02:00 EST jumps to 03:00 EDT, so 02:30 does not exist.
    const date = fromLocalInput('2026-03-08T02:30', 'America/New_York')
    expect(date?.toISOString()).toBe('2026-03-08T07:30:00.000Z') // 03:30 EDT
  })

  it('reads times around the clocks going back consistently', () => {
    // 2026-11-01 in New York: 01:30 happens twice; either reading is a real 01:30.
    const date = fromLocalInput('2026-11-01T01:30', 'America/New_York')!
    expect(toLocalInput(date, 'America/New_York')).toBe('2026-11-01T01:30')
  })
})

describe('toLocalInput', () => {
  it('writes the instant in the zone', () => {
    const instant = new Date('2026-10-14T07:00:00Z')
    expect(toLocalInput(instant, 'Europe/Moscow')).toBe('2026-10-14T10:00')
    expect(toLocalInput(instant, 'UTC')).toBe('2026-10-14T07:00')
    expect(toLocalInput(instant, 'Pacific/Auckland')).toBe('2026-10-14T20:00')
  })

  it('round-trips with fromLocalInput', () => {
    for (const tz of ['UTC', 'Europe/Moscow', 'Asia/Kolkata', 'America/Los_Angeles']) {
      const value = '2026-07-04T23:45'
      expect(toLocalInput(fromLocalInput(value, tz)!, tz)).toBe(value)
    }
  })
})

describe('formatTimeRange', () => {
  it('shows only times within one day', () => {
    const range = formatTimeRange(
      new Date('2026-10-14T07:00:00Z'),
      new Date('2026-10-14T08:30:00Z'),
      'Europe/Moscow',
    )
    expect(range).toBe('10:00–11:30')
  })

  it('adds the dates for a task across midnight', () => {
    const range = formatTimeRange(
      new Date('2026-10-14T19:00:00Z'),
      new Date('2026-10-15T03:00:00Z'),
      'UTC',
    )
    expect(range).toMatch(/14\s+окт.*19:00.*15\s+окт.*03:00/)
  })

  it('judges the day in the user zone, not in UTC', () => {
    // 21:30–22:30 UTC is 00:30–01:30 on the next day in Moscow: still one day there.
    const range = formatTimeRange(
      new Date('2026-10-14T21:30:00Z'),
      new Date('2026-10-14T22:30:00Z'),
      'Europe/Moscow',
    )
    expect(range).toBe('00:30–01:30')
  })
})
