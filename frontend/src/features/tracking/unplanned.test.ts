import { describe, expect, it } from 'vitest'
import { defaultUnplanned, toUnplannedRequest, validateUnplanned } from './unplanned'

const tz = 'Europe/Moscow'
const NOW = new Date('2026-10-14T09:00:40Z') // 12:00:40 Moscow

describe('defaultUnplanned', () => {
  it('is a timer, with the last half hour ready for the back-dated case', () => {
    expect(defaultUnplanned(NOW, tz)).toEqual({
      title: '',
      mode: 'timer',
      start: '2026-10-14T11:30',
      end: '2026-10-14T12:00',
      categoryIds: [],
    })
  })
})

describe('validateUnplanned', () => {
  const ok = { ...defaultUnplanned(NOW, tz), title: 'Звонок' }

  it('needs a title', () => {
    expect(validateUnplanned(ok, tz)).toEqual({})
    expect(validateUnplanned({ ...ok, title: '  ' }, tz).title).toBeDefined()
    expect(validateUnplanned({ ...ok, title: 'я'.repeat(201) }, tz).title).toBeDefined()
  })

  it('ignores the times for a timer', () => {
    expect(validateUnplanned({ ...ok, start: '', end: '' }, tz)).toEqual({})
  })

  it('needs a valid interval for a back-dated task', () => {
    const past = { ...ok, mode: 'past' as const }
    expect(validateUnplanned(past, tz)).toEqual({})
    expect(validateUnplanned({ ...past, start: '' }, tz).start).toBeDefined()
    expect(validateUnplanned({ ...past, end: '' }, tz).end).toBeDefined()
    expect(validateUnplanned({ ...past, end: past.start }, tz).end).toBeDefined()
  })
})

describe('toUnplannedRequest', () => {
  const draft = { ...defaultUnplanned(NOW, tz), title: ' Звонок ', categoryIds: ['c1'] }

  it('has no times for a timer', () => {
    expect(toUnplannedRequest(draft, tz)).toEqual({ title: 'Звонок', category_ids: ['c1'] })
  })

  it('sends the fact in UTC for a back-dated task', () => {
    expect(toUnplannedRequest({ ...draft, mode: 'past' }, tz)).toEqual({
      title: 'Звонок',
      category_ids: ['c1'],
      actual_start: '2026-10-14T08:30:00.000Z',
      actual_end: '2026-10-14T09:00:00.000Z',
    })
  })
})
