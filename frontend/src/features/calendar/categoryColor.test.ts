import { describe, expect, it } from 'vitest'
import type { Category } from '@/api/types'
import { instanceColor, noCategoryColor, primaryCategory } from './categoryColor'

const cat = (id: string, name: string): Category => ({
  id,
  name,
  parent_id: null,
  color: '#000000',
  archived_at: null,
})
const byId = new Map([cat('a', 'Спорт'), cat('b', 'Работа'), cat('c', 'Дом')].map((c) => [c.id, c]))

describe('primaryCategory', () => {
  it('picks the first category by name', () => {
    expect(primaryCategory(['a', 'b', 'c'], byId)?.name).toBe('Дом')
  })

  it('does not depend on the order of the ids', () => {
    expect(primaryCategory(['c', 'b', 'a'], byId)?.id).toBe(
      primaryCategory(['a', 'c', 'b'], byId)?.id,
    )
  })

  it('ignores unknown ids and handles no categories', () => {
    expect(primaryCategory(['x', 'a'], byId)?.id).toBe('a')
    expect(primaryCategory(['x'], byId)).toBeUndefined()
    expect(primaryCategory([], byId)).toBeUndefined()
  })
})

describe('instanceColor', () => {
  const sport: Category = {
    id: 's',
    name: 'Спорт',
    parent_id: null,
    color: '#ef4444',
    archived_at: null,
  }
  const cats = new Map([[sport.id, sport]])
  const habits = new Map([['h', '#22c55e']])

  it('uses the category first', () => {
    expect(instanceColor({ category_ids: ['s'], habit_id: 'h' }, cats, habits)).toBe('#ef4444')
  })

  it('uses the color of the habit for an occurrence without a category', () => {
    expect(instanceColor({ category_ids: [], habit_id: 'h' }, cats, habits)).toBe('#22c55e')
  })

  it('is neutral for anything else, also for a habit that is not loaded yet', () => {
    expect(instanceColor({ category_ids: [], habit_id: null }, cats, habits)).toBe(noCategoryColor)
    expect(instanceColor({ category_ids: [], habit_id: 'gone' }, cats, habits)).toBe(
      noCategoryColor,
    )
  })
})
