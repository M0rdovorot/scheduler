import { useMemo, useRef } from 'react'
import type { Category, Instance, SlotMinutes } from '@/api/types'
import { primaryCategory, noCategoryColor } from './categoryColor'
import type { Day } from './dates'
import { EventBlock } from './EventBlock'
import { dayHeightPx, formatMinutes, minBlockMinutes, pxPerMinute, slotBackground } from './grid'
import { layoutColumns } from './layout'
import { minutesPerDay, segmentOnDay } from './segments'
import { useSlotSelection, type SlotSelection } from './useSlotSelection'

interface DayColumnProps {
  day: Day
  tz: string
  slot: SlotMinutes
  instances: readonly Instance[]
  categoriesById: ReadonlyMap<string, Category>
  /** Minutes from midnight of this day for the "now" line; null on other days. */
  nowMin: number | null
  onSelect: (day: Day, selection: SlotSelection) => void
  onOpen: (instance: Instance) => void
}

const lineColor = 'color-mix(in srgb, var(--app-hint) 18%, transparent)'
const hourLineColor = 'color-mix(in srgb, var(--app-hint) 40%, transparent)'

export function DayColumn({
  day,
  tz,
  slot,
  instances,
  categoriesById,
  nowMin,
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

  const blocks = useMemo(() => {
    const segments = instances.flatMap((instance) => {
      const seg = segmentOnDay(
        new Date(instance.planned_start),
        new Date(instance.planned_end),
        day,
        tz,
      )
      if (!seg) return []
      // Very short tasks are drawn taller so that they can still be tapped.
      const visualEnd = Math.min(
        minutesPerDay,
        Math.max(seg.endMin, seg.startMin + minBlockMinutes),
      )
      return [{ instance, seg, visualEnd }]
    })
    const placement = layoutColumns(
      segments.map(({ instance, seg, visualEnd }) => ({
        id: instance.id,
        startMin: seg.startMin,
        endMin: visualEnd,
      })),
    )
    return segments.map(({ instance, seg, visualEnd }) => ({
      instance,
      seg,
      visualEnd,
      place: placement.get(instance.id) ?? { column: 0, columns: 1 },
    }))
  }, [instances, day, tz])

  return (
    <div
      ref={ref}
      data-day={day}
      className="relative min-w-0 flex-1 touch-pan-y select-none border-l border-separator [-webkit-touch-callout:none]"
      style={{ height: dayHeightPx(slot), ...slotBackground(slot, lineColor, hourLineColor) }}
      {...handlers}
    >
      {blocks.map(({ instance, seg, visualEnd, place }) => {
        const category = primaryCategory(instance.category_ids, categoriesById)
        return (
          <EventBlock
            key={instance.id}
            instance={instance}
            title={instance.title}
            color={category?.color ?? noCategoryColor}
            top={seg.startMin * ppm}
            height={(visualEnd - seg.startMin) * ppm}
            column={place.column}
            columns={place.columns}
            startMin={seg.startMin}
            endMin={seg.endMin}
            continuesBefore={seg.continuesBefore}
            continuesAfter={seg.continuesAfter}
            onOpen={onOpen}
          />
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
