import type { SlotMinutes } from '@/api/types'
import { minutesPerDay } from './segments'

/** Height of one slot in pixels; coarser slots get taller rows per hour of day. */
const slotHeightPx: Record<SlotMinutes, number> = { 5: 16, 10: 20, 15: 24, 30: 28, 60: 36 }

export function pxPerMinute(slot: SlotMinutes): number {
  return slotHeightPx[slot] / slot
}

/** Height of a whole day column. */
export function dayHeightPx(slot: SlotMinutes): number {
  return minutesPerDay * pxPerMinute(slot)
}

/** Start of the slot under the pointer: the y offset in the column snapped down. */
export function slotStartAt(y: number, slot: SlotMinutes): number {
  const minutes = y / pxPerMinute(slot)
  const index = Math.floor(minutes / slot)
  const lastIndex = minutesPerDay / slot - 1
  return Math.min(Math.max(index, 0), lastIndex) * slot
}

/** The slots between two slot starts (any order), end exclusive. */
export function selectionRange(a: number, b: number, slot: SlotMinutes) {
  const startMin = Math.min(a, b)
  const endMin = Math.min(Math.max(a, b) + slot, minutesPerDay)
  return { startMin, endMin }
}

/**
 * CSS for the slot lines: two repeating gradients (one line per slot, a
 * stronger one per hour), so the column is a single element however many slots
 * it has. Call with the colors as CSS values.
 */
export function slotBackground(slot: SlotMinutes, line: string, strongLine: string) {
  const slotPx = slotHeightPx[slot]
  const hourPx = 60 * pxPerMinute(slot)
  const gradient = (color: string) => `linear-gradient(to bottom, ${color} 1px, transparent 1px)`
  const layers = slot === 60 ? [strongLine] : [strongLine, line]
  return {
    backgroundImage: layers.map(gradient).join(', '),
    backgroundSize: slot === 60 ? `100% ${hourPx}px` : `100% ${hourPx}px, 100% ${slotPx}px`,
  }
}

/** Minimum drawn height of a task, so that very short ones stay tappable. */
export const minBlockMinutes = 20

/** The minute (from local midnight) as "HH:MM", with 1440 shown as "24:00". */
export function formatMinutes(min: number): string {
  const h = Math.floor(min / 60)
  const m = Math.round(min % 60)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}
