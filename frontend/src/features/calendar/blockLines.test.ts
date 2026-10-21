import { describe, expect, it } from 'vitest'
import type { Instance } from '@/api/types'
import type { Block } from './blocks'
import { detailLines, linesThatFit } from './blockLines'

const tz = 'Europe/Moscow'

const task = (over: Partial<Instance>): Instance => ({
  id: 't',
  title: 'Спорт',
  description: '',
  planned_start: '2026-10-14T06:00:00Z', // 09:00 in Moscow
  planned_end: '2026-10-14T07:00:00Z',
  actual_start: '2026-10-14T06:20:00Z',
  actual_end: '2026-10-14T07:30:00Z',
  status: 'done',
  comment: '',
  category_ids: [],
  series_id: null,
  habit_id: null,
  rescheduled_from: null,
  rescheduled_to: null,
  deviations: [],
  ...over,
})

const block = (instance: Instance, kind: Block['kind']): Block => ({
  key: instance.id,
  instance,
  kind,
  seg: { startMin: 560, endMin: 630, continuesBefore: false, continuesAfter: false },
  stripe: null,
})

describe('detailLines', () => {
  it('gives a plan block its time only', () => {
    expect(detailLines(block(task({}), 'plan'), '09:00–10:00', tz)).toEqual(['09:00–10:00'])
  })

  it('gives a fact block the fact, how it differs from the plan, and the plan', () => {
    const lines = detailLines(
      block(
        task({
          deviations: [
            { kind: 'started_late', minutes: 20 },
            { kind: 'finished_late', minutes: 30 },
          ],
        }),
        'fact',
      ),
      '09:20–10:30',
      tz,
    )
    expect(lines).toEqual(['09:20–10:30', 'начало +20 мин · конец +30 мин', 'план 09:00–10:00'])
  })

  it('shows "took longer" only when the start and the end were on time', () => {
    const both = task({
      deviations: [
        { kind: 'started_late', minutes: 20 },
        { kind: 'took_longer', minutes: 10 },
      ],
    })
    expect(detailLines(block(both, 'fact'), '09:20–10:30', tz)[1]).toBe('начало +20 мин')
    const only = task({ deviations: [{ kind: 'took_longer', minutes: 25 }] })
    expect(detailLines(block(only, 'fact'), '09:00–10:25', tz)[1]).toBe('дольше на 25 мин')
  })

  it('leaves out the deviations of a task that went as planned', () => {
    expect(detailLines(block(task({}), 'fact'), '09:00–10:00', tz)).toEqual([
      '09:00–10:00',
      'план 09:00–10:00',
    ])
  })

  it('says that a timer runs', () => {
    const running = task({ status: 'in_progress', actual_end: null })
    expect(detailLines(block(running, 'fact'), '09:20–11:00', tz)[1]).toBe('идёт')
  })

  it('marks a task outside the plan and gives it no plan line', () => {
    const free = task({ planned_start: null, planned_end: null })
    expect(detailLines(block(free, 'unplanned'), '08:00–08:20', tz)).toEqual([
      '08:00–08:20',
      'вне плана',
    ])
  })
})

describe('linesThatFit', () => {
  it.each([
    [27, 0],
    [40, 1],
    [55, 2],
    [66, 3],
    [90, 5],
  ])('a block %ipx tall has %i lines under the title', (height, lines) => {
    expect(linesThatFit(height, false)).toBe(lines)
  })

  it('has none in a narrow column', () => {
    expect(linesThatFit(200, true)).toBe(0)
  })
})
