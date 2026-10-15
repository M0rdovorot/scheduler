import { describe, expect, it } from 'vitest'
import type { SlotMinutes } from '@/api/types'
import {
  dayHeightPx,
  formatMinutes,
  pxPerMinute,
  selectionRange,
  slotBackground,
  slotStartAt,
} from './grid'

const slots: SlotMinutes[] = [5, 10, 15, 30, 60]

describe('pxPerMinute / dayHeightPx', () => {
  it('makes a slot an integer number of pixels, for every slot size', () => {
    for (const slot of slots) {
      const px = pxPerMinute(slot) * slot
      expect(Number.isInteger(px)).toBe(true)
      expect(px).toBeGreaterThanOrEqual(16)
    }
  })

  it('gives finer slots more pixels per minute', () => {
    const values = slots.map(pxPerMinute)
    expect([...values].sort((a, b) => b - a)).toEqual(values)
  })

  it('keeps the whole day height consistent', () => {
    expect(dayHeightPx(30)).toBe(48 * 28)
    expect(dayHeightPx(5)).toBe(288 * 16)
  })
})

describe('slotStartAt', () => {
  it('snaps a pointer offset down to the start of its slot', () => {
    const ppm = pxPerMinute(30) // 28 / 30
    expect(slotStartAt(0, 30)).toBe(0)
    expect(slotStartAt(27, 30)).toBe(0)
    expect(slotStartAt(28, 30)).toBe(30)
    expect(slotStartAt(10 * 60 * ppm, 30)).toBe(600)
    expect(slotStartAt(10 * 60 * ppm + 1, 30)).toBe(600)
  })

  it('works for every slot size', () => {
    for (const slot of slots) {
      const y = 9 * 60 * pxPerMinute(slot) + 1
      expect(slotStartAt(y, slot)).toBe(540)
    }
  })

  it('clamps outside the column', () => {
    expect(slotStartAt(-50, 15)).toBe(0)
    expect(slotStartAt(1e9, 15)).toBe(1440 - 15)
    expect(slotStartAt(1e9, 60)).toBe(1380)
  })
})

describe('selectionRange', () => {
  it('selects one slot when pressed and released on it', () => {
    expect(selectionRange(600, 600, 30)).toEqual({ startMin: 600, endMin: 630 })
  })

  it('includes both end slots, in either drag direction', () => {
    expect(selectionRange(600, 660, 30)).toEqual({ startMin: 600, endMin: 690 })
    expect(selectionRange(660, 600, 30)).toEqual({ startMin: 600, endMin: 690 })
  })

  it('stops at the end of the day', () => {
    expect(selectionRange(1410, 1410, 30)).toEqual({ startMin: 1410, endMin: 1440 })
  })
})

describe('slotBackground', () => {
  it('draws hour and slot lines with two repeating layers', () => {
    const bg = slotBackground(30, 'rgba(0,0,0,.1)', 'rgba(0,0,0,.3)')
    expect(bg.backgroundSize).toBe('100% 56px, 100% 28px')
    expect(bg.backgroundImage.match(/linear-gradient/g)).toHaveLength(2)
  })

  it('needs only the hour layer for one-hour slots', () => {
    const bg = slotBackground(60, 'a', 'b')
    expect(bg.backgroundSize).toBe('100% 36px')
    expect(bg.backgroundImage.match(/linear-gradient/g)).toHaveLength(1)
  })

  it('aligns the hour layer with the hour height', () => {
    for (const slot of slots) {
      const hourPx = 60 * pxPerMinute(slot)
      expect(slotBackground(slot, 'a', 'b').backgroundSize.startsWith(`100% ${hourPx}px`)).toBe(
        true,
      )
    }
  })
})

describe('formatMinutes', () => {
  it.each([
    [0, '00:00'],
    [75, '01:15'],
    [600, '10:00'],
    [1440, '24:00'],
  ])('%i → %s', (min, want) => {
    expect(formatMinutes(min)).toBe(want)
  })
})
