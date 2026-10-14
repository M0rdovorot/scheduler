import { describe, expect, it } from 'vitest'
import type { User } from '@/api/types'
import { buildSettingsPatch, draftFromUser, validateDraft } from './draft'

const user: User = {
  id: 'u1',
  display_name: 'Ann',
  timezone: 'Europe/Moscow',
  slot_minutes: 30,
  default_view: 'day',
  deviation_threshold_minutes: 10,
}

describe('draftFromUser', () => {
  it('mirrors the user', () => {
    expect(draftFromUser(user)).toEqual({
      timezone: 'Europe/Moscow',
      slotMinutes: 30,
      defaultView: 'day',
      deviationThreshold: '10',
    })
  })
})

describe('buildSettingsPatch', () => {
  it('is empty when nothing changed', () => {
    expect(buildSettingsPatch(user, draftFromUser(user))).toEqual({})
  })

  it('contains only changed fields', () => {
    const draft = { ...draftFromUser(user), slotMinutes: 15 as const, deviationThreshold: '0' }
    expect(buildSettingsPatch(user, draft)).toEqual({
      slot_minutes: 15,
      deviation_threshold_minutes: 0,
    })
  })

  it('sends the time zone trimmed and in canonical case', () => {
    const draft = { ...draftFromUser(user), timezone: ' asia/tokyo ' }
    expect(buildSettingsPatch(user, draft)).toEqual({ timezone: 'Asia/Tokyo' })
  })

  it('treats a differently cased saved time zone as unchanged', () => {
    const draft = { ...draftFromUser(user), timezone: 'europe/moscow' }
    expect(buildSettingsPatch(user, draft)).toEqual({})
  })
})

describe('validateDraft', () => {
  it('accepts the saved settings', () => {
    expect(validateDraft(draftFromUser(user))).toEqual({})
  })

  it.each(['', 'moscow', 'Mars/Olympus'])('rejects time zone %j', (timezone) => {
    expect(validateDraft({ ...draftFromUser(user), timezone }).timezone).toBeDefined()
  })

  it.each(['0', '1440', ' 15 '])('accepts threshold %j', (deviationThreshold) => {
    expect(validateDraft({ ...draftFromUser(user), deviationThreshold })).toEqual({})
  })

  it.each(['', '-1', '1.5', '1441', 'abc'])('rejects threshold %j', (deviationThreshold) => {
    expect(
      validateDraft({ ...draftFromUser(user), deviationThreshold }).deviationThreshold,
    ).toBeDefined()
  })
})
