import { useCallback, useEffect, useMemo, useState } from 'react'
import { useCategories } from '@/api/categories'
import { useInstances } from '@/api/instances'
import { useMe } from '@/api/me'
import type { Category } from '@/api/types'
import { CalendarHeader } from './CalendarHeader'
import { useCalendarStore } from './calendarStore'
import { dayRange, rangeLabel, shiftAnchor, todayIn, visibleDays, type Day } from './dates'
import { TaskForm, type TaskFormTarget } from './TaskForm'
import { TimeGrid } from './TimeGrid'
import { draftForSelection, draftStartingNow } from './taskDraft'
import type { SlotSelection } from './useSlotSelection'

/** The current time, refreshed every 30 seconds for the "now" line. */
function useNow(): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 30_000)
    return () => window.clearInterval(id)
  }, [])
  return now
}

export function CalendarPage() {
  const { data: me } = useMe()
  if (!me) return null
  return <Calendar tz={me.timezone} slot={me.slot_minutes} defaultView={me.default_view} />
}

interface CalendarProps {
  tz: string
  slot: 5 | 10 | 15 | 30 | 60
  defaultView: 'day' | 'three_days' | 'week'
}

function Calendar({ tz, slot, defaultView }: CalendarProps) {
  const now = useNow()
  const today = todayIn(tz, now)
  const { view: chosenView, anchor: chosenAnchor, setView, setAnchor } = useCalendarStore()
  const view = chosenView ?? defaultView
  const anchor = chosenAnchor ?? today

  const days = useMemo(() => visibleDays(view, anchor), [view, anchor])
  const { from, to } = useMemo(() => dayRange(days, tz), [days, tz])
  const instances = useInstances(from, to)
  const categories = useCategories()
  const [target, setTarget] = useState<TaskFormTarget | null>(null)

  const categoriesById = useMemo(
    () => new Map<string, Category>((categories.data ?? []).map((c) => [c.id, c])),
    [categories.data],
  )

  const closeForm = useCallback(() => setTarget(null), [])

  const openSelection = (day: Day, range: SlotSelection) =>
    setTarget({
      mode: 'create',
      compact: true,
      draft: draftForSelection(day, range.startMin, range.endMin),
    })

  return (
    <div className="flex h-screen-safe flex-col">
      <CalendarHeader
        title={rangeLabel(days, Number(today.slice(0, 4)))}
        pickedDay={anchor}
        onPickDay={setAnchor}
        view={view}
        onViewChange={setView}
        onPrev={() => setAnchor(shiftAnchor(view, anchor, -1))}
        onNext={() => setAnchor(shiftAnchor(view, anchor, 1))}
        onToday={() => setAnchor(null)}
      />

      {instances.isError && (
        <p role="alert" className="px-3 pb-2 text-sm text-danger">
          Не удалось загрузить дела.{' '}
          <button type="button" className="underline" onClick={() => void instances.refetch()}>
            Повторить
          </button>
        </p>
      )}

      <TimeGrid
        days={days}
        today={today}
        now={now}
        tz={tz}
        slot={slot}
        instances={instances.data ?? []}
        categoriesById={categoriesById}
        onSelect={openSelection}
        onOpen={(instance) => setTarget({ mode: 'edit', id: instance.id })}
        onOpenDay={(day) => {
          setAnchor(day)
          setView('day')
        }}
      />

      <button
        type="button"
        aria-label="Новое дело"
        onClick={() =>
          setTarget({
            mode: 'create',
            compact: false,
            draft: draftStartingNow(new Date(), today, slot, tz),
          })
        }
        className="fixed bottom-[max(1rem,var(--safe-bottom))] right-4 z-20 size-14 rounded-full bg-accent text-3xl leading-none text-accent-fg shadow-lg"
      >
        +
      </button>

      {target && (
        <TaskForm
          target={target}
          instances={instances.data ?? []}
          categories={categories.data ?? []}
          tz={tz}
          onClose={closeForm}
        />
      )}
    </div>
  )
}
