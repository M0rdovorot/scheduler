import { describe, expect, it } from 'vitest'
import { deviceTimeZone, isValidTimeZone } from './timezone'

describe('isValidTimeZone', () => {
  it.each(['UTC', 'Europe/Moscow', 'America/Argentina/Buenos_Aires'])('accepts %s', (name) => {
    expect(isValidTimeZone(name)).toBe(true)
  })

  it.each(['', 'Mars/Olympus', 'moscow time', '+03:00'])('rejects %j', (name) => {
    expect(isValidTimeZone(name)).toBe(false)
  })

  it('accepts the device time zone', () => {
    expect(isValidTimeZone(deviceTimeZone())).toBe(true)
  })
})
