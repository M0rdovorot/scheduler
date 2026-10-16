import { describe, expect, it } from 'vitest'
import type { Instance } from '@/api/types'
import { buildTrackingPatch, commentError, draftFromInstance, validateFactDraft } from './factDraft'

const tz = 'Europe/Moscow'
const NOW = new Date('2026-10-14T09:00:00Z') // 12:00 Moscow

const base: Instance = {
  id: 't1',
  title: 'Спорт',
  description: '',
  planned_start: '2026-10-14T07:00:00Z', // 10:00
  planned_end: '2026-10-14T08:00:00Z', // 11:00
  actual_start: null,
  actual_end: null,
  status: 'planned',
  comment: '',
  category_ids: [],
  series_id: null,
  rescheduled_from: null,
  rescheduled_to: null,
  deviations: [],
}
const done: Instance = {
  ...base,
  status: 'done',
  actual_start: '2026-10-14T07:20:00Z',
  actual_end: '2026-10-14T08:30:00Z',
  comment: 'пробки',
}

describe('draftFromInstance', () => {
  it('starts a planned task from its plan, as done', () => {
    expect(draftFromInstance(base, tz, NOW)).toEqual({
      status: 'done',
      start: '2026-10-14T10:00',
      end: '2026-10-14T11:00',
    })
  })

  it('shows an existing fact and comment', () => {
    expect(draftFromInstance(done, tz, NOW)).toEqual({
      status: 'done',
      start: '2026-10-14T10:20',
      end: '2026-10-14T11:30',
    })
  })

  it('leaves the end empty for a running timer', () => {
    const running: Instance = {
      ...base,
      status: 'in_progress',
      actual_start: '2026-10-14T07:20:00Z',
    }
    expect(draftFromInstance(running, tz, NOW)).toMatchObject({
      status: 'in_progress',
      start: '2026-10-14T10:20',
      end: '',
    })
  })

  it('starts a task outside the plan from its fact', () => {
    const free: Instance = { ...done, planned_start: null, planned_end: null }
    expect(draftFromInstance(free, tz, NOW).start).toBe('2026-10-14T10:20')
  })
})

describe('validateFactDraft', () => {
  const ok = draftFromInstance(done, tz, NOW)

  it('accepts a saved fact', () => {
    expect(validateFactDraft(ok, tz)).toEqual({})
  })

  it('needs an end after the start for a finished task', () => {
    expect(validateFactDraft({ ...ok, end: '' }, tz).end).toBeDefined()
    expect(validateFactDraft({ ...ok, end: ok.start }, tz).end).toBeDefined()
    expect(validateFactDraft({ ...ok, end: '2026-10-14T10:00' }, tz).end).toBeDefined()
  })

  it('needs only a start for a running task and no times for "not done"', () => {
    expect(validateFactDraft({ ...ok, status: 'in_progress', end: '' }, tz)).toEqual({})
    expect(validateFactDraft({ ...ok, status: 'not_done', start: '', end: '' }, tz)).toEqual({})
  })

  it('needs a valid start', () => {
    expect(validateFactDraft({ ...ok, start: '' }, tz).start).toBeDefined()
  })
})

describe('commentError', () => {
  it('limits the comment to 2000 characters', () => {
    expect(commentError('я'.repeat(2000))).toBeNull()
    expect(commentError('я'.repeat(2001))).not.toBeNull()
    expect(commentError('')).toBeNull()
  })
})

describe('buildTrackingPatch', () => {
  it('marks a planned task as done with the times of the plan', () => {
    const draft = draftFromInstance(base, tz, NOW)
    expect(buildTrackingPatch(base, draft, tz)).toEqual({
      status: 'done',
      actual_start: '2026-10-14T07:00:00.000Z',
      actual_end: '2026-10-14T08:00:00.000Z',
    })
  })

  it('is empty when nothing changed', () => {
    expect(buildTrackingPatch(done, draftFromInstance(done, tz, NOW), tz)).toEqual({})
  })

  it('sends the changed times in UTC', () => {
    const draft = { ...draftFromInstance(done, tz, NOW), end: '2026-10-14T12:00' }
    expect(buildTrackingPatch(done, draft, tz)).toEqual({ actual_end: '2026-10-14T09:00:00.000Z' })
  })

  it('changes the status without touching the fact', () => {
    const draft = { ...draftFromInstance(done, tz, NOW), status: 'partial' as const }
    expect(buildTrackingPatch(done, draft, tz)).toEqual({ status: 'partial' })
  })

  it('sends no times for "not done"', () => {
    const draft = {
      ...draftFromInstance(base, tz, NOW),
      status: 'not_done' as const,
    }
    expect(buildTrackingPatch(base, draft, tz)).toEqual({ status: 'not_done' })
  })

  it('sends only the start for a running timer', () => {
    const running: Instance = {
      ...base,
      status: 'in_progress',
      actual_start: '2026-10-14T07:20:00Z',
    }
    const draft = { ...draftFromInstance(running, tz, NOW), start: '2026-10-14T10:30' }
    expect(buildTrackingPatch(running, draft, tz)).toEqual({
      actual_start: '2026-10-14T07:30:00.000Z',
    })
  })
})
