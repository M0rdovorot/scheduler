import { useEffect, useRef, useState, type PointerEvent, type RefObject } from 'react'
import type { SlotMinutes } from '@/api/types'
import { selectionRange, slotStartAt } from './grid'

/** Hold time before a touch starts selecting; a quicker touch scrolls the grid. */
export const longPressMs = 350
/** A touch that moves farther than this before the hold ends is a scroll. */
const scrollSlopPx = 8

export interface SlotSelection {
  startMin: number
  endMin: number
}

interface Options {
  slot: SlotMinutes
  /** The element whose top edge is minute 0 (the day column). */
  columnRef: RefObject<HTMLElement | null>
  onFinish: (selection: SlotSelection) => void
}

/**
 * Selecting slots in a day column (FR-3.2): with a mouse press and drag, on a
 * touch screen press and hold, then drag. A tap on an empty slot with the mouse
 * selects that one slot; a short touch only scrolls.
 */
export function useSlotSelection({ slot, columnRef, onFinish }: Options) {
  const [selection, setSelection] = useState<SlotSelection | null>(null)
  const gesture = useRef({
    active: false,
    timer: 0,
    originX: 0,
    originY: 0,
    firstSlot: 0,
    lastSlot: 0,
  })
  const onFinishRef = useRef(onFinish)
  useEffect(() => {
    onFinishRef.current = onFinish
  })

  const slotAt = (clientY: number) => {
    const top = columnRef.current?.getBoundingClientRect().top ?? 0
    return slotStartAt(clientY - top, slot)
  }

  const begin = (target: Element, pointerId: number, firstSlot: number) => {
    const g = gesture.current
    g.active = true
    g.firstSlot = g.lastSlot = firstSlot
    target.setPointerCapture?.(pointerId)
    setSelection(selectionRange(firstSlot, firstSlot, slot))
  }

  const reset = () => {
    window.clearTimeout(gesture.current.timer)
    gesture.current.timer = 0
    gesture.current.active = false
    setSelection(null)
  }

  // While a selection is being dragged on a touch screen the grid must not scroll.
  // React's touch handlers are passive, so this needs a native listener.
  useEffect(() => {
    const el = columnRef.current
    if (!el) return
    const block = (e: TouchEvent) => {
      if (gesture.current.active && e.cancelable) e.preventDefault()
    }
    el.addEventListener('touchmove', block, { passive: false })
    return () => el.removeEventListener('touchmove', block)
  }, [columnRef])

  useEffect(() => () => window.clearTimeout(gesture.current.timer), [])

  return {
    selection,
    handlers: {
      onPointerDown(e: PointerEvent<HTMLElement>) {
        if (e.pointerType === 'mouse' && e.button !== 0) return
        // Tasks handle their own taps.
        if ((e.target as Element).closest('[data-task]')) return

        const g = gesture.current
        const first = slotAt(e.clientY)
        if (e.pointerType === 'mouse') {
          begin(e.currentTarget, e.pointerId, first)
          return
        }
        g.originX = e.clientX
        g.originY = e.clientY
        const target = e.currentTarget
        const pointerId = e.pointerId
        g.timer = window.setTimeout(() => {
          g.timer = 0
          begin(target, pointerId, first)
        }, longPressMs)
      },
      onPointerMove(e: PointerEvent<HTMLElement>) {
        const g = gesture.current
        if (g.active) {
          const current = slotAt(e.clientY)
          if (current !== g.lastSlot) {
            g.lastSlot = current
            setSelection(selectionRange(g.firstSlot, current, slot))
          }
        } else if (
          Math.abs(e.clientX - g.originX) > scrollSlopPx ||
          Math.abs(e.clientY - g.originY) > scrollSlopPx
        ) {
          window.clearTimeout(g.timer)
          g.timer = 0
        }
      },
      onPointerUp() {
        const g = gesture.current
        window.clearTimeout(g.timer)
        g.timer = 0
        if (!g.active) return
        const result = selectionRange(g.firstSlot, g.lastSlot, slot)
        g.active = false
        setSelection(null)
        onFinishRef.current(result)
      },
      onPointerCancel: reset,
      onContextMenu(e: { preventDefault: () => void }) {
        // A long press must not open the browser's context menu.
        if (gesture.current.active || gesture.current.timer) e.preventDefault()
      },
    },
  }
}
