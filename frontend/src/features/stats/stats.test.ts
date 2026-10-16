import { describe, expect, it } from 'vitest'
import type { Category, StatsDay } from '@/api/types'
import {
  buildChart,
  groupByWeek,
  maxSeries,
  niceTicks,
  tickLabel,
  uncategorizedId,
  otherId,
} from './chartData'
import { formatDuration, formatShort } from './format'
import {
  customError,
  customLength,
  maxPeriodDays,
  newPeriod,
  periodDays,
  periodLabel,
  periodRange,
  shiftPeriod,
} from './period'
import { statsRows } from './tree'

const cat = (
  id: string,
  name: string,
  parent: string | null = null,
  color = '#3b82f6',
): Category => ({
  id,
  name,
  parent_id: parent,
  color,
  archived_at: null,
})

describe('periodDays', () => {
  it('is the day itself', () => {
    expect(periodDays(newPeriod('day', '2026-10-14'))).toEqual({
      first: '2026-10-14',
      last: '2026-10-14',
    })
  })

  it('is Monday to Sunday for a week', () => {
    expect(periodDays(newPeriod('week', '2026-10-14'))).toEqual({
      first: '2026-10-12',
      last: '2026-10-18',
    })
    expect(periodDays(newPeriod('week', '2026-10-18'))).toEqual({
      first: '2026-10-12',
      last: '2026-10-18',
    })
    expect(periodDays(newPeriod('week', '2026-10-19'))).toEqual({
      first: '2026-10-19',
      last: '2026-10-25',
    })
  })

  it('is the whole calendar month, of any length', () => {
    expect(periodDays(newPeriod('month', '2026-10-14'))).toEqual({
      first: '2026-10-01',
      last: '2026-10-31',
    })
    expect(periodDays(newPeriod('month', '2026-02-10'))).toEqual({
      first: '2026-02-01',
      last: '2026-02-28',
    })
    expect(periodDays(newPeriod('month', '2028-02-10'))).toEqual({
      first: '2028-02-01',
      last: '2028-02-29',
    })
    expect(periodDays(newPeriod('month', '2026-11-30'))).toEqual({
      first: '2026-11-01',
      last: '2026-11-30',
    })
  })

  it('is the chosen range for a custom period', () => {
    const p = {
      ...newPeriod('custom', '2026-10-14'),
      customFrom: '2026-10-01',
      customTo: '2026-10-20',
    }
    expect(periodDays(p)).toEqual({ first: '2026-10-01', last: '2026-10-20' })
  })
})

describe('periodRange', () => {
  it('runs from local midnight of the first day to that of the day after the last', () => {
    const { from, to } = periodRange(newPeriod('week', '2026-10-14'), 'Europe/Moscow')
    expect(from.toISOString()).toBe('2026-10-11T21:00:00.000Z')
    expect(to.toISOString()).toBe('2026-10-18T21:00:00.000Z')
  })

  it('follows the clocks: a 25-hour day', () => {
    const { from, to } = periodRange(newPeriod('day', '2026-11-01'), 'America/New_York')
    expect((to.getTime() - from.getTime()) / 3600_000).toBe(25)
  })
})

describe('shiftPeriod', () => {
  it.each([
    ['day', '2026-10-14', 1, '2026-10-15'],
    ['day', '2026-10-14', -1, '2026-10-13'],
    ['week', '2026-10-14', 1, '2026-10-21'],
    ['week', '2026-10-14', -1, '2026-10-07'],
    ['month', '2026-10-14', 1, '2026-11-01'],
    ['month', '2026-12-14', 1, '2027-01-01'],
    ['month', '2026-01-31', -1, '2025-12-01'],
    ['month', '2026-03-31', -1, '2026-02-01'],
  ] as const)('%s %s %i → %s', (kind, anchor, dir, want) => {
    expect(shiftPeriod(newPeriod(kind, anchor), dir).anchor).toBe(want)
  })

  it('moves a custom period by its own length, with no overlap and no gap', () => {
    const p = {
      ...newPeriod('custom', '2026-10-14'),
      customFrom: '2026-10-01',
      customTo: '2026-10-10',
    }
    const next = shiftPeriod(p, 1)
    expect([next.customFrom, next.customTo]).toEqual(['2026-10-11', '2026-10-20'])
    const prev = shiftPeriod(p, -1)
    expect([prev.customFrom, prev.customTo]).toEqual(['2026-09-21', '2026-09-30'])
  })

  it('walks months back and forth without drifting', () => {
    let p = newPeriod('month', '2026-01-31')
    for (let i = 0; i < 14; i++) p = shiftPeriod(p, 1)
    for (let i = 0; i < 14; i++) p = shiftPeriod(p, -1)
    expect(periodDays(p).first).toBe('2026-01-01')
  })
})

describe('custom periods', () => {
  it('counts days inclusively', () => {
    expect(customLength('2026-10-14', '2026-10-14')).toBe(1)
    expect(customLength('2026-10-01', '2026-10-31')).toBe(31)
    expect(customLength('2026-12-30', '2027-01-02')).toBe(4)
  })

  it('accepts a valid range up to the limit and says why otherwise', () => {
    expect(customError('2026-10-01', '2026-10-20')).toBeNull()
    expect(customError('2026-01-01', '2026-12-31')).toBeNull() // 365 days
    expect(customError('2026-01-01', '2027-01-01')).toBeNull() // 366 days
    expect(customLength('2026-01-01', '2027-01-02')).toBe(maxPeriodDays + 1)
    expect(customError('2026-01-01', '2027-01-02')).toMatch(/не длиннее/)
    expect(customError('2026-10-20', '2026-10-01')).toMatch(/раньше/)
    expect(customError('', '2026-10-01')).toMatch(/обе даты/)
  })
})

describe('periodLabel', () => {
  it('titles each kind of period', () => {
    expect(periodLabel(newPeriod('day', '2026-10-14'), 2026)).toMatch(/14\s+октября/)
    expect(periodLabel(newPeriod('day', '2027-10-14'), 2026)).toMatch(/14\s+окт.*2027/)
    expect(periodLabel(newPeriod('month', '2026-10-14'), 2026)).toMatch(/октябрь\s+2026/)
    expect(periodLabel(newPeriod('week', '2026-10-14'), 2026)).toMatch(/^12 – 18\s+октября/)
    expect(periodLabel(newPeriod('week', '2026-10-28'), 2026)).toBe('26.10 – 01.11')
    expect(periodLabel(newPeriod('week', '2026-12-30'), 2026)).toBe('28.12.26 – 03.01.27')
  })
})

describe('formatDuration / formatShort', () => {
  it.each([
    [0, '0 мин'],
    [45, '45 мин'],
    [60, '1 ч'],
    [150, '2 ч 30 мин'],
    [1500, '25 ч'],
    [-5, '0 мин'],
  ])('formatDuration(%i) = %s', (minutes, want) => {
    expect(formatDuration(minutes)).toBe(want)
  })

  it.each([
    [0, '0 мин'],
    [45, '45 мин'],
    [60, '1 ч'],
    [90, '1,5 ч'],
    [150, '2,5 ч'],
    [125, '2,1 ч'],
  ])('formatShort(%i) = %s', (minutes, want) => {
    expect(formatShort(minutes)).toBe(want)
  })
})

describe('niceTicks', () => {
  it.each([
    [0, [0, 60]],
    [20, [0, 15, 30]],
    [50, [0, 15, 30, 45, 60]],
    [100, [0, 30, 60, 90, 120]],
    [240, [0, 60, 120, 180, 240]],
    [250, [0, 120, 240, 360]],
    [700, [0, 180, 360, 540, 720]],
  ])('%i minutes', (max, ticks) => {
    expect(niceTicks(max).ticks).toEqual(ticks)
  })

  it('always leaves room for the largest column and has a few ticks only', () => {
    for (let m = 1; m <= 3000; m += 37) {
      const { ticks, max } = niceTicks(m)
      expect(max).toBeGreaterThanOrEqual(m)
      expect(ticks.at(-1)).toBe(max)
      expect(ticks.length).toBeLessThanOrEqual(6)
    }
  })

  it('labels ticks', () => {
    expect(tickLabel(0)).toBe('0')
    expect(tickLabel(30)).toBe('30 мин')
    expect(tickLabel(120)).toBe('2 ч')
  })
})

describe('buildChart', () => {
  const labels = { uncategorized: 'Без категории', other: 'Другое' }
  const day = (date: string, minutes: number, parts: [string | null, number][]): StatsDay => ({
    date,
    minutes,
    by_category: parts.map(([category_id, m]) => ({ category_id, minutes: m })),
  })

  it('gives each category its own color, the biggest first', () => {
    const cats = [cat('a', 'Спорт', null, '#ef4444'), cat('b', 'Работа', null, '#3b82f6')]
    const { series, columns } = buildChart(
      [
        day('2026-10-14', 90, [
          ['a', 30],
          ['b', 60],
        ]),
        day('2026-10-15', 60, [['a', 60]]),
      ],
      cats,
      labels,
    )
    expect(series.map((s) => [s.name, s.color, s.minutes])).toEqual([
      ['Спорт', '#ef4444', 90],
      ['Работа', '#3b82f6', 60],
    ])
    expect(columns[0]!.segments).toEqual([
      { seriesId: 'a', minutes: 30 },
      { seriesId: 'b', minutes: 60 },
    ])
    expect(columns[0]!.total).toBe(90)
  })

  it('keeps the color of a category whatever its rank', () => {
    const cats = [cat('a', 'Спорт', null, '#ef4444'), cat('b', 'Работа', null, '#3b82f6')]
    const small = buildChart([day('2026-10-14', 10, [['a', 10]])], cats, labels)
    const big = buildChart(
      [
        day('2026-10-14', 100, [
          ['a', 10],
          ['b', 90],
        ]),
      ],
      cats,
      labels,
    )
    expect(small.series[0]!.color).toBe('#ef4444')
    expect(big.series.find((s) => s.id === 'a')!.color).toBe('#ef4444')
  })

  it('shows tasks without a category as a neutral series of their own', () => {
    const { series } = buildChart([day('2026-10-14', 30, [[null, 30]])], [], labels)
    expect(series).toHaveLength(1)
    expect(series[0]).toMatchObject({
      id: uncategorizedId,
      name: 'Без категории',
      kind: 'uncategorized',
    })
  })

  it('folds the tail into one neutral "Other" past eight series', () => {
    const cats = Array.from({ length: 10 }, (_, i) => cat(`c${i}`, `Кат ${i}`, null, '#3b82f6'))
    const parts: [string, number][] = cats.map((c, i) => [c.id, 100 - i * 5])
    const { series, columns } = buildChart([day('2026-10-14', 1000, parts)], cats, labels)

    expect(series).toHaveLength(maxSeries)
    expect(series.slice(0, 7).map((s) => s.id)).toEqual(['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6'])
    const other = series.at(-1)!
    expect(other).toMatchObject({ id: otherId, kind: 'other', name: 'Другое' })
    // c7, c8, c9 = 65 + 60 + 55
    expect(other.minutes).toBe(180)
    // Nothing is lost: the column still adds up.
    expect(columns[0]!.total).toBe(parts.reduce((s, [, m]) => s + m, 0))
  })

  it('does not fold exactly eight series', () => {
    const cats = Array.from({ length: 8 }, (_, i) => cat(`c${i}`, `Кат ${i}`))
    const { series } = buildChart(
      [
        day(
          '2026-10-14',
          80,
          cats.map((c, i) => [c.id, 10 - i] as [string, number]),
        ),
      ],
      cats,
      labels,
    )
    expect(series).toHaveLength(8)
    expect(series.some((s) => s.kind === 'other')).toBe(false)
  })

  it('keeps the busy time of the day apart from the sum of the segments', () => {
    const cats = [cat('a', 'Спорт')]
    const { columns } = buildChart(
      [
        day('2026-10-14', 60, [
          ['a', 60],
          ['a', 0],
        ]),
      ],
      cats,
      labels,
    )
    expect(columns[0]!.busy).toBe(60)
  })

  it('names a category that is no longer in the list instead of failing', () => {
    const { series } = buildChart([day('2026-10-14', 30, [['gone', 30]])], [], labels)
    expect(series[0]!.name).toBe('—')
  })

  it('has no series for a period without time', () => {
    const { series, columns } = buildChart([day('2026-10-14', 0, [])], [], labels)
    expect(series).toEqual([])
    expect(columns).toEqual([
      { date: '2026-10-14', endDate: undefined, total: 0, busy: 0, segments: [] },
    ])
  })

  it('shows weeks instead of days for a long period', () => {
    const cats = [cat('a', 'Спорт')]
    const days: StatsDay[] = []
    for (let i = 0; i < 70; i++) {
      const date = new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10)
      days.push(day(date, 30, [['a', 30]]))
    }
    const { columns } = buildChart(days, cats, labels)
    expect(columns.length).toBeLessThan(15)
    expect(columns.reduce((s, c) => s + c.total, 0)).toBe(70 * 30)
    // The first week starts on the first day of the period, not on the Monday before it,
    // and the last one ends with the period.
    expect(columns[0]!.date).toBe('2026-01-01')
    expect(columns[1]!.date).toBe('2026-01-05')
    expect(columns[1]!.endDate).toBe('2026-01-11')
    expect(columns.at(-1)!.endDate).toBe('2026-03-11')
  })
})

describe('groupByWeek', () => {
  it('sums days into their Monday weeks, categories too', () => {
    const days: StatsDay[] = [
      { date: '2026-10-12', minutes: 60, by_category: [{ category_id: 'a', minutes: 60 }] },
      {
        date: '2026-10-18',
        minutes: 30,
        by_category: [
          { category_id: 'a', minutes: 20 },
          { category_id: null, minutes: 10 },
        ],
      },
      { date: '2026-10-19', minutes: 15, by_category: [{ category_id: 'a', minutes: 15 }] },
    ]
    const weeks = groupByWeek(days)
    expect(weeks.map((w) => [w.date, w.minutes])).toEqual([
      ['2026-10-12', 90],
      ['2026-10-19', 15],
    ])
    expect(weeks[0]!.by_category).toEqual([
      { category_id: 'a', minutes: 80 },
      { category_id: null, minutes: 10 },
    ])
  })
})

describe('statsRows', () => {
  const cats = [
    cat('sport', 'Спорт'),
    cat('run', 'Бег', 'sport'),
    cat('swim', 'Плавание', 'sport'),
    cat('work', 'Работа'),
    cat('idle', 'Пусто'),
  ]

  it('lists the tree with the largest first and leaves out categories without time', () => {
    const minutes = new Map([
      ['sport', 100],
      ['run', 60],
      ['swim', 70],
      ['work', 120],
    ])
    expect(statsRows(cats, minutes).map((r) => [r.category.name, r.depth, r.minutes])).toEqual([
      ['Работа', 0, 120],
      ['Спорт', 0, 100],
      ['Плавание', 1, 70],
      ['Бег', 1, 60],
    ])
  })

  it('shows a category whose parent is not in the list at the top', () => {
    const rows = statsRows([cat('a', 'Сирота', 'missing')], new Map([['a', 10]]))
    expect(rows.map((r) => r.depth)).toEqual([0])
  })

  it('is empty without data', () => {
    expect(statsRows(cats, new Map())).toEqual([])
  })
})
