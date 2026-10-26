import { describe, expect, it } from 'vitest'
import { busyInstances, busyTitle } from './busyInstances'

describe('busyInstances', () => {
  const blocks = [
    { start: '2026-10-14T06:00:00Z', end: '2026-10-14T07:00:00Z', title: 'Стоматолог' },
    { start: '2026-10-14T08:00:00Z', end: '2026-10-14T09:30:00Z', title: null },
  ]

  it('keeps the times and shows the title only where there is one', () => {
    const list = busyInstances(blocks)
    expect(list.map((i) => i.title)).toEqual(['Стоматолог', busyTitle])
    expect(list.map((i) => [i.planned_start, i.planned_end])).toEqual([
      ['2026-10-14T06:00:00Z', '2026-10-14T07:00:00Z'],
      ['2026-10-14T08:00:00Z', '2026-10-14T09:30:00Z'],
    ])
  })

  it('gives each block its own id', () => {
    expect(new Set(busyInstances(blocks).map((i) => i.id)).size).toBe(2)
  })

  it('makes plain planned tasks with nothing of a real task', () => {
    for (const i of busyInstances(blocks)) {
      expect(i).toMatchObject({
        status: 'planned',
        series_id: null,
        habit_id: null,
        category_ids: [],
        actual_start: null,
        description: '',
      })
    }
  })

  it('is empty for no blocks', () => {
    expect(busyInstances([])).toEqual([])
  })
})
