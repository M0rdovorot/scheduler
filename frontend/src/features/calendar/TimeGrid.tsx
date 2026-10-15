import { useEffect, useMemo, useRef } from 'react'
import type { Category, Instance, SlotMinutes } from '@/api/types'
import { weekdayLabel, type Day } from './dates'
import { DayColumn } from './DayColumn'
import { dayHeightPx, pxPerMinute } from './grid'
import { segmentOnDay, wallMinutes } from './segments'
import type { SlotSelection } from './useSlotSelection'

interface TimeGridProps {
  days: readonly Day[]
  today: Day
  now: Date
  tz: string
  slot: SlotMinutes
  instances: readonly Instance[]
  categoriesById: ReadonlyMap<string, Category>
  onSelect: (day: Day, selection: SlotSelection) => void
  onOpen: (instance: Instance) => void
  onOpenDay: (day: Day) => void
}

const gutter = 'w-11 shrink-0'

export function TimeGrid({
  days,
  today,
  now,
  tz,
  slot,
  instances,
  categoriesById,
  onSelect,
  onOpen,
  onOpenDay,
}: TimeGridProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const ppm = pxPerMinute(slot)

  // Start an hour above the current time when today is visible, else at 07:00.
  const nowMin = days.includes(today) ? wallMinutes(now, today, tz) : null
  const initialMinute = nowMin !== null ? Math.max(0, nowMin - 60) : 7 * 60
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = initialMinute * ppm
    // Only when the grid scale changes, not on every tick of the clock.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ppm])

  const byDay = useMemo(() => {
    // Hand each column only the tasks that can touch it.
    const map = new Map<Day, Instance[]>()
    for (const day of days) map.set(day, [])
    for (const instance of instances) {
      const start = new Date(instance.planned_start)
      const end = new Date(instance.planned_end)
      for (const day of days) {
        if (segmentOnDay(start, end, day, tz)) map.get(day)?.push(instance)
      }
    }
    return map
  }, [days, instances, tz])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex border-b border-separator" role="row">
        <div className={gutter} />
        {days.map((day) => (
          <button
            key={day}
            type="button"
            onClick={() => onOpenDay(day)}
            aria-label={`Открыть день ${day}`}
            className={`min-w-0 flex-1 py-1 text-center text-xs ${day === today ? 'font-semibold text-accent' : 'text-hint'}`}
          >
            <span className="block capitalize">{weekdayLabel(day)}</span>
            <span className="block text-base">{Number(day.slice(8))}</span>
          </button>
        ))}
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="flex" style={{ height: dayHeightPx(slot) }}>
          <div className={`${gutter} relative`} aria-hidden="true">
            {Array.from({ length: 24 }, (_, hour) => (
              <span
                key={hour}
                className="absolute right-1 -translate-y-1/2 text-[10px] text-hint"
                style={{ top: hour * 60 * ppm }}
              >
                {hour === 0 ? '' : `${String(hour).padStart(2, '0')}:00`}
              </span>
            ))}
          </div>
          {days.map((day) => (
            <DayColumn
              key={day}
              day={day}
              tz={tz}
              slot={slot}
              instances={byDay.get(day) ?? []}
              categoriesById={categoriesById}
              nowMin={day === today ? nowMin : null}
              onSelect={onSelect}
              onOpen={onOpen}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
