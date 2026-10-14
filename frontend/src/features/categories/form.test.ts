import { describe, expect, it } from 'vitest'
import type { Category } from '@/api/types'
import { diffDraft, draftFromCategory, hasChanges, isHexColor, validateDraft } from './form'

const original: Category = {
  id: 'c1',
  parent_id: 'p1',
  name: 'Бег',
  color: '#3b82f6',
  archived_at: null,
}

describe('validateDraft', () => {
  const ok = { name: 'Бег', color: '#3b82f6', parentId: '' }

  it('accepts a valid draft', () => {
    expect(validateDraft(ok)).toEqual({})
  })

  it.each(['', '   '])('rejects the empty name %j', (name) => {
    expect(validateDraft({ ...ok, name }).name).toBeDefined()
  })

  it('counts characters, not UTF-16 units', () => {
    expect(validateDraft({ ...ok, name: '😀'.repeat(100) })).toEqual({})
    expect(validateDraft({ ...ok, name: '😀'.repeat(101) }).name).toBeDefined()
  })

  it.each(['red', '#abc', '#12345g', '3b82f6'])('rejects the color %j', (color) => {
    expect(validateDraft({ ...ok, color }).color).toBeDefined()
  })
})

describe('isHexColor', () => {
  it('accepts upper and lower case', () => {
    expect(isHexColor('#AABBCC')).toBe(true)
    expect(isHexColor('#aabbcc')).toBe(true)
  })
})

describe('diffDraft', () => {
  it('is empty for an untouched draft', () => {
    const changes = diffDraft(original, draftFromCategory(original))
    expect(changes).toEqual({ update: {} })
    expect(hasChanges(changes)).toBe(false)
  })

  it('reports only the changed name and color, normalised', () => {
    const draft = { ...draftFromCategory(original), name: ' Пробежка ', color: '#FF0000' }
    expect(diffDraft(original, draft)).toEqual({ update: { name: 'Пробежка', color: '#ff0000' } })
  })

  it('does not report a color that only differs in case', () => {
    const draft = { ...draftFromCategory(original), color: '#3B82F6' }
    expect(hasChanges(diffDraft(original, draft))).toBe(false)
  })

  it('reports a move to another parent and to the top level', () => {
    const toOther = diffDraft(original, { ...draftFromCategory(original), parentId: 'p2' })
    expect(toOther.move).toEqual({ parentId: 'p2' })
    const toTop = diffDraft(original, { ...draftFromCategory(original), parentId: '' })
    expect(toTop.move).toEqual({ parentId: null })
    expect(hasChanges(toTop)).toBe(true)
  })

  it('treats a top-level category as parent ""', () => {
    const top = { ...original, parent_id: null }
    expect(draftFromCategory(top).parentId).toBe('')
    expect(diffDraft(top, draftFromCategory(top)).move).toBeUndefined()
  })
})
