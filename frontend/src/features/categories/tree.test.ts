import { describe, expect, it } from 'vitest'
import type { Category } from '@/api/types'
import { buildTree, countDescendants, findNode, flattenTree, parentOptions } from './tree'

function cat(id: string, name: string, parent: string | null = null, archived = false): Category {
  return {
    id,
    name,
    parent_id: parent,
    color: '#3b82f6',
    archived_at: archived ? '2026-01-01T00:00:00Z' : null,
  }
}

const sample = [
  cat('sport', 'Спорт'),
  cat('swim', 'Плавание', 'sport'),
  cat('run', 'Бег', 'sport'),
  cat('sprint', 'Спринт', 'run'),
  cat('work', 'Работа'),
  cat('home', 'Дом', null, true),
]

describe('buildTree', () => {
  it('nests categories and sorts siblings by name', () => {
    const forest = buildTree(sample)
    expect(forest.map((n) => n.category.id)).toEqual(['home', 'work', 'sport'])
    const sport = findNode(forest, 'sport')
    expect(sport?.children.map((n) => n.category.id)).toEqual(['run', 'swim'])
    expect(findNode(forest, 'run')?.children.map((n) => n.category.id)).toEqual(['sprint'])
  })

  it('does not depend on the input order', () => {
    const shuffled = [...sample].reverse()
    expect(flattenTree(buildTree(shuffled)).map((f) => f.category.id)).toEqual(
      flattenTree(buildTree(sample)).map((f) => f.category.id),
    )
  })

  it('shows a category with an unknown parent at the top level', () => {
    const forest = buildTree([cat('a', 'A', 'missing')])
    expect(forest.map((n) => n.category.id)).toEqual(['a'])
  })

  it('handles an empty list', () => {
    expect(buildTree([])).toEqual([])
  })

  it('sorts case-insensitively and numerically', () => {
    const forest = buildTree([cat('1', 'проект 10'), cat('2', 'Проект 2'), cat('3', 'арбуз')])
    expect(forest.map((n) => n.category.name)).toEqual(['арбуз', 'Проект 2', 'проект 10'])
  })
})

describe('flattenTree', () => {
  it('lists depth first with depths', () => {
    const flat = flattenTree(buildTree(sample)).map((f) => [f.category.id, f.depth])
    expect(flat).toEqual([
      ['home', 0],
      ['work', 0],
      ['sport', 0],
      ['run', 1],
      ['sprint', 2],
      ['swim', 1],
    ])
  })

  it('prunes a skipped node with its subtree', () => {
    const ids = flattenTree(buildTree(sample), (c) => c.id === 'run').map((f) => f.category.id)
    expect(ids).toEqual(['home', 'work', 'sport', 'swim'])
  })
})

describe('countDescendants', () => {
  it('counts all levels but not the node', () => {
    const forest = buildTree(sample)
    expect(countDescendants(findNode(forest, 'sport')!)).toBe(3)
    expect(countDescendants(findNode(forest, 'run')!)).toBe(1)
    expect(countDescendants(findNode(forest, 'swim')!)).toBe(0)
  })
})

describe('parentOptions', () => {
  it('excludes archived categories and the moving subtree', () => {
    const ids = parentOptions(buildTree(sample), 'sport').map((f) => f.category.id)
    expect(ids).toEqual(['work'])
  })

  it('offers every active category when creating', () => {
    const ids = parentOptions(buildTree(sample), null).map((f) => f.category.id)
    expect(ids).toEqual(['work', 'sport', 'run', 'sprint', 'swim'])
  })
})
