import { describe, expect, it } from 'vitest'
import { deviceTimeZone, normalizeTimeZone } from './timezone'

describe('normalizeTimeZone', () => {
  it.each(['UTC', 'Europe/Moscow', 'Asia/Tokyo'])('keeps %s', (name) => {
    expect(normalizeTimeZone(name)).toBe(name)
  })

  it.each([
    ['europe/moscow', 'Europe/Moscow'],
    ['EUROPE/MOSCOW', 'Europe/Moscow'],
    ['utc', 'UTC'],
  ])('fixes the case of %s', (name, want) => {
    expect(normalizeTimeZone(name)).toBe(want)
  })

  it.each(['', 'Mars/Olympus', 'moscow time', '+03:00', '-05:00'])('rejects %j', (name) => {
    expect(normalizeTimeZone(name)).toBeNull()
  })

  it('accepts the device time zone', () => {
    expect(normalizeTimeZone(deviceTimeZone())).not.toBeNull()
  })
})
