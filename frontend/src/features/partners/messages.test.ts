import { describe, expect, it } from 'vitest'
import { ApiError } from '@/api/errors'
import { partnerErrorMessage } from './messages'

describe('partnerErrorMessage', () => {
  it('explains each way an invite can fail', () => {
    const texts = ['invite_invalid', 'own_invite', 'already_partners'].map((code) =>
      partnerErrorMessage(new ApiError(code === 'invite_invalid' ? 404 : 409, { code })),
    )
    expect(new Set(texts).size).toBe(3)
    expect(texts[0]).toMatch(/просрочено/)
    expect(texts[1]).toMatch(/ваше/)
    expect(texts[2]).toMatch(/уже партнёры/)
  })

  it('says a missing partner is gone', () => {
    expect(partnerErrorMessage(new ApiError(404, { code: 'not_found' }))).toMatch(
      /Партнёр не найден/,
    )
  })

  it('falls back for anything else', () => {
    expect(partnerErrorMessage(new Error('boom'))).toMatch(/Не удалось/)
    expect(partnerErrorMessage(new ApiError(500))).toMatch(/Не удалось/)
  })
})
