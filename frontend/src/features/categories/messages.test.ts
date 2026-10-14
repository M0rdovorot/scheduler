import { describe, expect, it } from 'vitest'
import { ApiError } from '@/api/errors'
import { categoryErrorMessage } from './messages'

describe('categoryErrorMessage', () => {
  it.each([
    [new ApiError(400, { code: 'category_cycle' }), /внутрь самой себя/],
    [new ApiError(400, { code: 'parent_archived' }), /в архиве/],
    [new ApiError(404, { code: 'not_found' }), /не найдена/],
    [new ApiError(400, { code: 'validation_failed', field: 'name' }), /Название/],
    [new ApiError(400, { code: 'validation_failed', field: 'color' }), /#rrggbb/],
    [new ApiError(400, { code: 'validation_failed', field: 'parent_id' }), /Родительская/],
    [new ApiError(500), /Не удалось/],
    [new TypeError('network'), /Не удалось/],
  ])('explains %s', (error, pattern) => {
    expect(categoryErrorMessage(error)).toMatch(pattern)
  })
})
