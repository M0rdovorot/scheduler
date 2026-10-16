import { useMemo, useRef } from 'react'
import type { Category, Instance, SlotMinutes } from '@/api/types'
import { isUnmarked } from '@/features/tracking/fact'
import { blocksForDay, type ShowMode } from './blocks'
import { instanceColor } from './categoryColor'
import type { Day } from './dates'
import { EventBlock } from './EventBlock'
import { dayHeightPx, formatMinutes, minBlockMinutes, pxPerMinute, slotBackground } from './grid'
import { layoutColumns } from './layout'
import { minutesPerDay } from './segments'
import { useSlotSelection, type SlotSelection } from './useSlotSelection'

interface DayColumnProps {
  day: Day
  tz: string
  slot: SlotMinutes
  mode: ShowMode
  now: Date
  instances: readonly Instance[]
  categoriesById: ReadonlyMap<string, Category>
  habitColors: ReadonlyMap<string, string>
  /** Minutes from midnight of this day for the "now" line; null on other days. */
  nowMin: number | null
  /** Narrow column: see EventBlock. */
  dense: boolean
  onSelect: (day: Day, selection: SlotSelection) => void
  onOpen: (instance: Instance) => void
}

const lineColor = 'color-mix(in srgb, var(--app-hint) 18%, transparent)'
const hourLineColor = 'color-mix(in srgb, var(--app-hint) 40%, transparent)'

export function DayColumn({
  day,
  tz,
  slot,
  mode,
  now,
  instances,
  categoriesById,
  habitColors,
  nowMin,
  dense,
  onSelect,
  onOpen,
}: DayColumnProps) {
  const ref = useRef<HTMLDivElement>(null)
  const ppm = pxPerMinute(slot)

  const { selection, handlers } = useSlotSelection({
    slot,
    columnRef: ref,
    onFinish: (range) => onSelect(day, range),
  })

  const placed = useMemo(() => {
    // Very short tasks are drawn taller so that they can still be tapped.
    const visualEnd = (b: { seg: { startMin: number; endMin: number } }) =>
      Math.min(minutesPerDay, Math.max(b.seg.endMin, b.seg.startMin + minBlockMinutes))
    const blocks = blocksForDay(instances, day, tz, mode, now)
    const placement = layoutColumns(
      blocks.map((b) => ({ id: b.key, startMin: b.seg.startMin, endMin: visualEnd(b) })),
    )
    return blocks.map((block) => ({
      block,
      visualEnd: visualEnd(block),
      place: placement.get(block.key) ?? { column: 0, columns: 1 },
    }))
  }, [instances, day, tz, mode, now])

  return (
    <div
      ref={ref}
      data-day={day}
      className="relative min-w-0 flex-1 touch-pan-y select-none border-l border-separator [-webkit-touch-callout:none]"
      style={{ height: dayHeightPx(slot), ...slotBackground(slot, lineColor, hourLineColor) }}
      {...handlers}
    >
      {placed.map(({ block, visualEnd, place }) => {
        const { instance, stripe } = block
        const color = instanceColor(instance, categoriesById, habitColors)
        const left = `calc(${(place.column / place.columns) * 100}% + 1px)`
        return (
          <div key={`${block.kind}-${block.key}`}>
            <EventBlock
              block={block}
              color={color}
              top={block.seg.startMin * ppm}
              height={(visualEnd - block.seg.startMin) * ppm}
              column={place.column}
              columns={place.columns}
              unmarked={block.kind === 'plan' && isUnmarked(instance, now)}
              dense={dense}
              onOpen={onOpen}
            />
            {stripe && (
              <span
                aria-hidden="true"
                data-fact-stripe={instance.id}
                className={`pointer-events-none absolute z-[5] w-[5px] rounded-sm ${instance.status === 'in_progress' ? 'animate-pulse' : ''}`}
                style={{
                  top: stripe.startMin * ppm,
                  height: Math.max((stripe.endMin - stripe.startMin) * ppm, 3),
                  left,
                  background: color,
                  boxShadow: '0 0 0 1px var(--app-bg)',
                }}
              />
            )}
          </div>
        )
      })}

      {selection && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 rounded-md border-2 border-accent bg-accent/25 text-xs"
          style={{
            top: selection.startMin * ppm,
            height: (selection.endMin - selection.startMin) * ppm,
          }}
        >
          <span className="px-1">
            {formatMinutes(selection.startMin)}–{formatMinutes(selection.endMin)}
          </span>
        </div>
      )}

      {nowMin !== null && (
        <div
          aria-hidden="true"
          data-now-line
          className="pointer-events-none absolute inset-x-0 z-10 h-0.5 bg-danger"
          style={{ top: nowMin * ppm }}
        >
          <span className="absolute -left-1 -top-[3px] size-2 rounded-full bg-danger" />
        </div>
      )}
    </div>
  )
}
