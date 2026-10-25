import { describe, expect, it } from 'vitest'
import type { Instance } from '@/api/types'
import { defaultReschedule, toRescheduleRequest, validateReschedule } from './reschedule'

const tz = 'Europe/Moscow'
const task: Instance = {
  id: 't',
  title: 'Спорт',
  description: '',
  planned_start: '2026-10-14T07:00:00Z', // 10:00
  planned_end: '2026-10-14T08:30:00Z', // 11:30
  actual_start: null,
  actual_end: null,
  status: 'planned',
  comment: '',
  category_ids: [],
  series_id: null,
  habit_id: null,
  rescheduled_from: null,
  rescheduled_to: null,
  deviations: [],
  visibility: 'private',
}

describe('defaultReschedule', () => {
  it('suggests the same time the next day, the same length', () => {
    expect(defaultReschedule(task, tz)).toEqual({
      start: '2026-10-15T10:00',
      end: '2026-10-15T11:30',
      comment: '',
    })
  })

  it('rolls over month ends', () => {
    const t = {
      ...task,
      planned_start: '2026-10-31T07:00:00Z',
      planned_end: '2026-10-31T08:00:00Z',
    }
    expect(defaultReschedule(t, tz).start).toBe('2026-11-01T10:00')
  })

  it('keeps a task that ends after midnight consistent', () => {
    const t = {
      ...task,
      planned_start: '2026-10-14T19:00:00Z',
      planned_end: '2026-10-14T22:00:00Z',
    } // 22:00-01:00
    expect(defaultReschedule(t, tz)).toMatchObject({
      start: '2026-10-15T22:00',
      end: '2026-10-16T01:00',
    })
  })
})

describe('validateReschedule', () => {
  const ok = defaultReschedule(task, tz)

  it('accepts the suggestion', () => {
    expect(validateReschedule(ok, tz)).toEqual({})
  })

  it('needs both times and an end after the start', () => {
    expect(validateReschedule({ ...ok, start: '' }, tz).start).toBeDefined()
    expect(validateReschedule({ ...ok, end: '' }, tz).end).toBeDefined()
    expect(validateReschedule({ ...ok, end: ok.start }, tz).end).toBeDefined()
  })

  it('limits the reason', () => {
    expect(validateReschedule({ ...ok, comment: 'я'.repeat(2001) }, tz).comment).toBeDefined()
    expect(validateReschedule({ ...ok, comment: 'я'.repeat(2000) }, tz)).toEqual({})
  })
})

describe('toRescheduleRequest', () => {
  it('sends UTC instants and the trimmed reason', () => {
    expect(
      toRescheduleRequest({ ...defaultReschedule(task, tz), comment: ' совещание ' }, tz),
    ).toEqual({
      planned_start: '2026-10-15T07:00:00.000Z',
      planned_end: '2026-10-15T08:30:00.000Z',
      comment: 'совещание',
    })
  })

  it('leaves the reason out when empty', () => {
    expect(toRescheduleRequest(defaultReschedule(task, tz), tz)).not.toHaveProperty('comment')
  })
})
