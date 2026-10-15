import { describe, expect, it } from 'vitest'
import type { Category } from '@/api/types'
import { primaryCategory } from './categoryColor'

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
