import { describe, expect, it } from 'vitest'
import { ApiError } from '@/api/errors'
import { habitErrorMessage } from './messages'

const err = (status: number, code: string, field?: string) =>
  new ApiError(status, { code, message: 'x', ...(field ? { field } : {}) })

describe('habitErrorMessage', () => {
  it('explains why a habit cannot be in the calendar by the code, not by the field', () => {
    expect(habitErrorMessage(err(400, 'habit_weekly_in_grid', 'time'))).toMatch(/раз в неделю/)
    expect(habitErrorMessage(err(400, 'habit_weekly_in_grid', 'frequency'))).toMatch(/раз в неделю/)
    expect(habitErrorMessage(err(400, 'habit_archived', 'time'))).toMatch(/архива/)
  })

  it('does not blame the calendar for an incomplete schedule or a bad time', () => {
    expect(habitErrorMessage(err(400, 'validation_failed', 'frequency'))).toMatch(
      /Расписание неполное/,
    )
    expect(habitErrorMessage(err(400, 'validation_failed', 'time'))).toMatch(/07:30/)
  })

  it('knows the other fields and a missing habit', () => {
    expect(habitErrorMessage(err(400, 'validation_failed', 'target_value'))).toMatch(/Цель/)
    expect(habitErrorMessage(err(400, 'validation_failed', 'date'))).toMatch(/не наступил/)
    expect(habitErrorMessage(err(404, 'not_found'))).toMatch(/не найдена/)
  })

  it('has a general message for anything else', () => {
    expect(habitErrorMessage(new Error('boom'))).toMatch(/Не удалось/)
    expect(habitErrorMessage(err(500, 'internal'))).toMatch(/Не удалось/)
  })
})
