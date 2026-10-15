import { describe, expect, it } from 'vitest'
import { layoutColumns, type LayoutItem } from './layout'

const item = (id: string, startMin: number, endMin: number): LayoutItem => ({
  id,
  startMin,
  endMin,
})

function place(items: LayoutItem[]) {
  return Object.fromEntries(
    [...layoutColumns(items)].map(([id, p]) => [id, `${p.column}/${p.columns}`]),
  )
}

describe('layoutColumns', () => {
  it('gives a lone task the full width', () => {
    expect(place([item('a', 0, 60)])).toEqual({ a: '0/1' })
  })

  it('returns nothing for no tasks', () => {
    expect(layoutColumns([]).size).toBe(0)
  })

  it('puts two overlapping tasks side by side', () => {
    expect(place([item('a', 60, 120), item('b', 90, 150)])).toEqual({ a: '0/2', b: '1/2' })
  })

  it('does not treat tasks that only touch as overlapping', () => {
    expect(place([item('a', 60, 120), item('b', 120, 180)])).toEqual({ a: '0/1', b: '0/1' })
  })

  it('reuses a freed column inside one group', () => {
    // a overlaps b and c, but b and c do not overlap each other.
    expect(place([item('a', 0, 180), item('b', 0, 60), item('c', 60, 120)])).toEqual({
      a: '0/2',
      b: '1/2',
      c: '1/2',
    })
  })

  it('opens a third column only when three tasks overlap at once', () => {
    expect(place([item('a', 0, 120), item('b', 30, 120), item('c', 60, 120)])).toEqual({
      a: '0/3',
      b: '1/3',
      c: '2/3',
    })
  })

  it('keeps separate groups independent', () => {
    expect(
      place([item('a', 0, 60), item('b', 30, 90), item('c', 200, 260), item('d', 300, 360)]),
    ).toEqual({ a: '0/2', b: '1/2', c: '0/1', d: '0/1' })
  })

  it('chains tasks that overlap transitively into one group', () => {
    // a–b overlap and b–c overlap, a–c do not: still one group of two columns.
    expect(place([item('a', 0, 60), item('b', 30, 120), item('c', 90, 150)])).toEqual({
      a: '0/2',
      b: '1/2',
      c: '0/2',
    })
  })

  it('places a long task first so shorter ones nest beside it', () => {
    expect(place([item('short', 60, 90), item('long', 60, 240)])).toEqual({
      long: '0/2',
      short: '1/2',
    })
  })

  it('is independent of the input order and stable for identical tasks', () => {
    const items = [item('b', 60, 120), item('a', 60, 120), item('c', 60, 120)]
    const forward = place(items)
    expect(place([...items].reverse())).toEqual(forward)
    expect(forward).toEqual({ a: '0/3', b: '1/3', c: '2/3' })
  })

  it('never lets two tasks in the same column overlap', () => {
    const items = Array.from({ length: 60 }, (_, i) =>
      item(`t${i}`, (i * 37) % 600, ((i * 37) % 600) + 20 + ((i * 13) % 90)),
    )
    const placed = layoutColumns(items)
    for (const a of items) {
      for (const b of items) {
        if (a.id >= b.id) continue
        const pa = placed.get(a.id)!
        const pb = placed.get(b.id)!
        const overlap = a.startMin < b.endMin && b.startMin < a.endMin
        if (overlap) {
          expect(pa.column).not.toBe(pb.column)
          expect(pa.columns).toBe(pb.columns)
        }
        expect(pa.column).toBeLessThan(pa.columns)
      }
    }
  })
})
