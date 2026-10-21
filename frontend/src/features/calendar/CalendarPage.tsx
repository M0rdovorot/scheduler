import { useCallback, useMemo, useState } from 'react'
import { useCategories } from '@/api/categories'
import { useHabits } from '@/api/habits'
import { useInstances, useRunningInstances } from '@/api/instances'
import { useMe } from '@/api/me'
import { useNow } from '@/lib/useNow'
import type { Category } from '@/api/types'
import { UnplannedDialog } from '@/features/tracking/UnplannedDialog'
import {
  pastUnplanned,
  unplannedForSelection,
  type UnplannedDraft,
} from '@/features/tracking/unplanned'
import { effectiveMode } from './blocks'
import { CalendarHeader } from './CalendarHeader'
import { useCalendarStore } from './calendarStore'
import { dayRange, rangeLabel, shiftAnchor, todayIn, visibleDays, type Day } from './dates'
import { TaskForm, type TaskFormTarget } from './TaskForm'
import { TimeGrid } from './TimeGrid'
import { draftForSelection, draftStartingNow } from './taskDraft'
import type { SlotSelection } from './useSlotSelection'

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
  const {
    view: chosenView,
    anchor: chosenAnchor,
    mode: chosenMode,
    setView,
    setAnchor,
    setMode,
  } = useCalendarStore()
  const view = chosenView ?? defaultView
  const anchor = chosenAnchor ?? today
  // In the week view "both" is shown as the plan; the choice itself is kept for the other views.
  const mode = effectiveMode(chosenMode, view)

  const days = useMemo(() => visibleDays(view, anchor), [view, anchor])
  const { from, to } = useMemo(() => dayRange(days, tz), [days, tz])
  const instances = useInstances(from, to)
  const categories = useCategories()
  const running = useRunningInstances()
  const [target, setTarget] = useState<TaskFormTarget | null>(null)
  // A task outside the plan: from the menu, or in "fact" mode from the grid and the "+" button.
  const [unplanned, setUnplanned] = useState<{ initial?: UnplannedDraft } | null>(null)

  const categoriesById = useMemo(
    () => new Map<string, Category>((categories.data ?? []).map((c) => [c.id, c])),
    [categories.data],
  )

  const habits = useHabits()
  const habitColors = useMemo(
    () => new Map<string, string>((habits.data ?? []).map((h) => [h.id, h.color])),
    [habits.data],
  )

  const closeForm = useCallback(() => setTarget(null), [])

  const openSelection = (day: Day, range: SlotSelection) => {
    // Where the grid shows what happened, what is added there is a fact.
    if (mode === 'fact') {
      setUnplanned({ initial: unplannedForSelection(day, range.startMin, range.endMin, now, tz) })
      return
    }
    setTarget({
      mode: 'create',
      compact: true,
      draft: draftForSelection(day, range.startMin, range.endMin),
    })
  }

  return (
    <div className="flex h-screen-safe flex-col">
      <CalendarHeader
        title={rangeLabel(days, Number(today.slice(0, 4)))}
        pickedDay={anchor}
        onPickDay={setAnchor}
        view={view}
        onViewChange={setView}
        mode={mode}
        onModeChange={setMode}
        onUnplanned={() => setUnplanned({})}
        runningCount={running.data?.length ?? 0}
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
        mode={mode}
        instances={instances.data ?? []}
        categoriesById={categoriesById}
        habitColors={habitColors}
        onSelect={openSelection}
        onOpen={(instance) => setTarget({ mode: 'edit', id: instance.id })}
        onOpenDay={(day) => {
          setAnchor(day)
          setView('day')
        }}
      />

      <button
        type="button"
        aria-label={mode === 'fact' ? 'Новое дело в факте' : 'Новое дело'}
        onClick={() => {
          if (mode === 'fact') {
            setUnplanned({ initial: pastUnplanned(now, tz) })
            return
          }
          setTarget({
            mode: 'create',
            compact: false,
            draft: draftStartingNow(new Date(), today, slot, tz),
          })
        }}
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
          now={now}
          onGoToDay={(day) => {
            setAnchor(day)
            setView('day')
          }}
          onClose={closeForm}
        />
      )}

      {unplanned && (
        <UnplannedDialog
          categories={categories.data ?? []}
          tz={tz}
          now={now}
          initial={unplanned.initial}
          onDone={() => setUnplanned(null)}
          onCancel={() => setUnplanned(null)}
        />
      )}
    </div>
  )
}
