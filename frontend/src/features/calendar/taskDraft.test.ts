import { describe, expect, it } from 'vitest'
import type { Instance } from '@/api/types'
import {
  draftForSelection,
  draftFromInstance,
  draftStartingNow,
  localAt,
  toCreateRequest,
  toUpdateRequest,
  validateTaskDraft,
} from './taskDraft'

const tz = 'Europe/Moscow'

const instance: Instance = {
  id: 't1',
  title: 'Планёрка',
  description: 'обсудить',
  planned_start: '2026-10-14T07:00:00Z', // 10:00 Moscow
  planned_end: '2026-10-14T08:30:00Z',
  actual_start: null,
  actual_end: null,
  status: 'planned',
  comment: '',
  category_ids: ['c1', 'c2'],
  series_id: null,
  rescheduled_from: null,
  rescheduled_to: null,
  deviations: [],
}

describe('localAt', () => {
  it('writes minutes from midnight as a datetime-local value', () => {
    expect(localAt('2026-10-14', 0)).toBe('2026-10-14T00:00')
    expect(localAt('2026-10-14', 615)).toBe('2026-10-14T10:15')
  })

  it('rolls into the next day for 24:00 and beyond (a task across midnight)', () => {
    expect(localAt('2026-10-14', 1440)).toBe('2026-10-15T00:00')
    expect(localAt('2026-10-31', 1500)).toBe('2026-11-01T01:00')
  })
})

describe('draftForSelection', () => {
  it('fills the times from the selected slots', () => {
    expect(draftForSelection('2026-10-14', 600, 690)).toEqual({
      title: '',
      description: '',
      start: '2026-10-14T10:00',
      end: '2026-10-14T11:30',
      categoryIds: [],
      repeat: null,
    })
  })

  it('ends at midnight of the next day when the selection reaches the end of the day', () => {
    expect(draftForSelection('2026-10-14', 1410, 1440).end).toBe('2026-10-15T00:00')
  })
})

describe('draftStartingNow', () => {
  it('starts at the next slot boundary and lasts one hour', () => {
    // 10:07 Moscow with 15-minute slots → 10:15.
    const now = new Date('2026-10-14T07:07:00Z')
    const draft = draftStartingNow(now, '2026-10-14', 15, tz)
    expect(draft.start).toBe('2026-10-14T10:15')
    expect(draft.end).toBe('2026-10-14T11:15')
  })

  it('keeps a time that is already on a boundary', () => {
    const draft = draftStartingNow(new Date('2026-10-14T07:00:00Z'), '2026-10-14', 30, tz)
    expect(draft.start).toBe('2026-10-14T10:00')
  })

  it('moves to the next day after the last slot', () => {
    const now = new Date('2026-10-14T20:50:00Z') // 23:50 Moscow
    const draft = draftStartingNow(now, '2026-10-14', 30, tz)
    expect(draft.start).toBe('2026-10-15T00:00')
    expect(draft.end).toBe('2026-10-15T01:00')
  })
})

describe('validateTaskDraft', () => {
  const ok = draftFromInstance(instance, tz)

  it('accepts a saved task', () => {
    expect(validateTaskDraft(ok, tz)).toEqual({})
  })

  it('requires a title', () => {
    expect(validateTaskDraft({ ...ok, title: '   ' }, tz).title).toBeDefined()
    expect(validateTaskDraft({ ...ok, title: 'я'.repeat(200) }, tz).title).toBeUndefined()
    expect(validateTaskDraft({ ...ok, title: 'я'.repeat(201) }, tz).title).toBeDefined()
  })

  it('limits the description', () => {
    expect(
      validateTaskDraft({ ...ok, description: 'я'.repeat(5000) }, tz).description,
    ).toBeUndefined()
    expect(
      validateTaskDraft({ ...ok, description: 'я'.repeat(5001) }, tz).description,
    ).toBeDefined()
  })

  it('requires valid times and an end after the start', () => {
    expect(validateTaskDraft({ ...ok, start: '' }, tz).start).toBeDefined()
    expect(validateTaskDraft({ ...ok, end: 'x' }, tz).end).toBeDefined()
    expect(validateTaskDraft({ ...ok, end: ok.start }, tz).end).toBeDefined()
    expect(validateTaskDraft({ ...ok, end: '2026-10-14T09:59' }, tz).end).toBeDefined()
  })

  it('rejects an implausible year (a mistyped date)', () => {
    expect(
      validateTaskDraft({ ...ok, start: '2062-10-14T10:00', end: '2062-10-14T11:00' }, tz),
    ).toEqual({})
    expect(
      validateTaskDraft({ ...ok, start: '1999-12-31T10:00', end: '2000-01-01T00:00' }, tz).start,
    ).toBeDefined()
    expect(validateTaskDraft({ ...ok, end: '2101-01-01T00:00' }, tz).end).toBeDefined()
    expect(
      validateTaskDraft({ ...ok, start: '0026-10-14T10:00', end: '0026-10-14T11:00' }, tz).start,
    ).toBeDefined()
  })

  it('allows a task across midnight', () => {
    const night = { ...ok, start: '2026-10-14T22:00', end: '2026-10-15T06:00' }
    expect(validateTaskDraft(night, tz)).toEqual({})
  })
})

describe('toCreateRequest', () => {
  it('sends trimmed title and instants in UTC', () => {
    const draft = { ...draftFromInstance(instance, tz), title: '  Планёрка ' }
    expect(toCreateRequest(draft, tz)).toEqual({
      title: 'Планёрка',
      description: 'обсудить',
      planned_start: '2026-10-14T07:00:00.000Z',
      planned_end: '2026-10-14T08:30:00.000Z',
      category_ids: ['c1', 'c2'],
    })
  })

  it('refuses an invalid draft', () => {
    expect(() => toCreateRequest({ ...draftFromInstance(instance, tz), start: '' }, tz)).toThrow()
  })
})

describe('toUpdateRequest', () => {
  const draft = draftFromInstance(instance, tz)

  it('is empty when nothing changed', () => {
    expect(toUpdateRequest(instance, draft, tz)).toEqual({})
  })

  it('contains only what changed', () => {
    expect(
      toUpdateRequest(instance, { ...draft, title: ' Новое ', end: '2026-10-14T12:00' }, tz),
    ).toEqual({
      title: 'Новое',
      planned_end: '2026-10-14T09:00:00.000Z',
    })
  })

  it('clears the description with an empty string', () => {
    expect(toUpdateRequest(instance, { ...draft, description: '' }, tz)).toEqual({
      description: '',
    })
  })

  it('treats categories as a set: order does not matter, removal is an empty array', () => {
    expect(toUpdateRequest(instance, { ...draft, categoryIds: ['c2', 'c1'] }, tz)).toEqual({})
    expect(toUpdateRequest(instance, { ...draft, categoryIds: [] }, tz)).toEqual({
      category_ids: [],
    })
    expect(toUpdateRequest(instance, { ...draft, categoryIds: ['c1'] }, tz)).toEqual({
      category_ids: ['c1'],
    })
  })

  it('compares instants, so an equivalent time written otherwise is no change', () => {
    const withSeconds = { ...instance, planned_start: '2026-10-14T07:00:00.000Z' }
    expect(toUpdateRequest(withSeconds, draftFromInstance(withSeconds, tz), tz)).toEqual({})
  })
})

describe('repeat rules in drafts', () => {
  const ok = draftFromInstance(instance, tz)
  const weekly = {
    freq: 'weekly' as const,
    interval: 1,
    weekdays: [2],
    monthly: 'monthday' as const,
    end: { kind: 'never' as const },
  }

  it('sends the rule with a new task', () => {
    const request = toCreateRequest({ ...ok, repeat: weekly }, tz)
    expect(request.recurrence).toEqual({ rrule: 'FREQ=WEEKLY;BYDAY=WE' })
    expect(toCreateRequest(ok, tz).recurrence).toBeUndefined()
  })

  it('builds the rule from the date of the first slot', () => {
    const monthly = { ...weekly, freq: 'monthly' as const, weekdays: [] }
    const draft = { ...ok, start: '2026-10-14T10:00', end: '2026-10-14T11:00', repeat: monthly }
    expect(toCreateRequest(draft, tz).recurrence).toEqual({ rrule: 'FREQ=MONTHLY;BYMONTHDAY=14' })
  })

  it('reports an invalid rule', () => {
    const errors = validateTaskDraft({ ...ok, repeat: { ...weekly, weekdays: [] } }, tz)
    expect(errors.repeat?.weekdays).toBeDefined()
    expect(validateTaskDraft({ ...ok, repeat: weekly }, tz)).toEqual({})
  })

  it('includes the rule in an update only when it changed', () => {
    const draft = draftFromInstance(instance, tz, weekly)
    expect(toUpdateRequest(instance, draft, tz, weekly)).toEqual({})
    const changed = { ...draft, repeat: { ...weekly, interval: 2 } }
    expect(toUpdateRequest(instance, changed, tz, weekly)).toEqual({
      recurrence: { rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=WE' },
    })
    // Turning the editor off for a series is not possible: no rule means no change.
    expect(toUpdateRequest(instance, { ...draft, repeat: null }, tz, weekly)).toEqual({})
  })
})
