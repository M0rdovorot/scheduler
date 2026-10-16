import { useState } from 'react'
import { Link } from 'react-router'
import { useHabits, useHabitsToday, useSetMark } from '@/api/habits'
import type { Habit, HabitTodayItem } from '@/api/types'
import { fullDayLabel } from '@/features/calendar/dates'
import { usePlatform } from '@/platform/context'
import { HabitForm } from './HabitForm'
import { frequencyLabel, progressLabel, streakLabel, weekProgressLabel } from './format'
import { habitErrorMessage } from './messages'
import { parseValue, stepped, toggled } from './marks'

export function HabitsPage() {
  const today = useHabitsToday()
  const all = useHabits()
  const [creating, setCreating] = useState(false)

  const todayIds = new Set(today.data?.items.map((i) => i.habit.id))
  // Until today's list is here every habit would look like one that is not for today.
  const others = today.data
    ? (all.data ?? []).filter((h) => h.archived_at === null && !todayIds.has(h.id))
    : []
  const archived = (all.data ?? []).filter((h) => h.archived_at !== null)
  const empty = all.data !== undefined && all.data.length === 0

  return (
    <main className="mx-auto max-w-md p-4 pb-10">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Привычки</h1>
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="rounded-xl bg-accent px-3 py-2 text-accent-fg"
        >
          + Привычка
        </button>
      </div>

      {(today.isPending || all.isPending) && <p className="mt-3 text-hint">Загрузка…</p>}
      {(today.isError || all.isError) && (
        <p role="alert" className="mt-3 text-danger">
          Не удалось загрузить привычки.{' '}
          <button
            type="button"
            className="underline"
            onClick={() => {
              void today.refetch()
              void all.refetch()
            }}
          >
            Повторить
          </button>
        </p>
      )}

      {empty && (
        <p className="mt-3 text-hint">
          Привычек пока нет. Добавьте первую, например «Вода: 8 стаканов» или «Зарядка».
        </p>
      )}

      {today.data && today.data.items.length > 0 && (
        <section className="mt-4" aria-label="Сегодня">
          <h2 className="text-sm text-hint">Сегодня, {fullDayLabel(today.data.date)}</h2>
          <ul className="mt-2 space-y-2" data-testid="habits-today">
            {today.data.items.map((item) => (
              <TodayRow key={item.habit.id} item={item} date={today.data.date} />
            ))}
          </ul>
        </section>
      )}
      {today.data && today.data.items.length === 0 && !empty && all.data && (
        <p className="mt-3 text-hint">На сегодня привычек нет.</p>
      )}

      {others.length > 0 && (
        <section className="mt-6" aria-label="Не на сегодня">
          <h2 className="text-sm text-hint">Не на сегодня</h2>
          <ul className="mt-2 divide-y divide-separator">
            {others.map((h) => (
              <HabitLink key={h.id} habit={h} />
            ))}
          </ul>
        </section>
      )}

      {archived.length > 0 && (
        <details className="mt-6">
          <summary className="cursor-pointer text-sm text-hint">Архив ({archived.length})</summary>
          <ul className="mt-2 divide-y divide-separator">
            {archived.map((h) => (
              <HabitLink key={h.id} habit={h} />
            ))}
          </ul>
        </details>
      )}

      <nav className="mt-6">
        <Link to="/" className="text-link">
          В календарь
        </Link>
      </nav>

      {creating && <HabitForm onClose={() => setCreating(false)} />}
    </main>
  )
}

function HabitLink({ habit }: { habit: Habit }) {
  return (
    <li>
      <Link to={`/habits/${habit.id}`} className="flex items-center gap-3 py-2">
        <span
          aria-hidden="true"
          className="size-3 shrink-0 rounded-full"
          style={{ background: habit.color }}
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate">{habit.title}</span>
          <span className="block text-sm text-hint">{frequencyLabel(habit)}</span>
        </span>
      </Link>
    </li>
  )
}

/** A habit of today with the quick mark: a tap for yes/no, "−", "+" and a typed value for a quantity. */
function TodayRow({ item, date }: { item: HabitTodayItem; date: string }) {
  const { habit, value, done } = item
  const platform = usePlatform()
  const setMark = useSetMark()
  const [error, setError] = useState<string | null>(null)

  async function mark(next: number) {
    setError(null)
    try {
      await setMark.mutateAsync({ id: habit.id, date, value: next })
      platform.haptic.notify('success')
    } catch (e) {
      platform.haptic.notify('error')
      setError(habitErrorMessage(e))
    }
  }

  const weekly = habit.frequency === 'times_per_week'
  return (
    <li data-habit={habit.id} data-done={done} className="rounded-xl bg-surface p-3">
      <div className="flex items-center gap-3">
        {habit.kind === 'boolean' ? (
          <button
            type="button"
            aria-label={done ? `Снять отметку: ${habit.title}` : `Отметить: ${habit.title}`}
            aria-pressed={done}
            disabled={setMark.isPending}
            onClick={() => void mark(toggled(value))}
            className="flex size-11 shrink-0 items-center justify-center rounded-full border-2 text-xl disabled:opacity-50"
            style={{
              borderColor: habit.color,
              background: done ? habit.color : 'transparent',
              color: done ? '#fff' : 'transparent',
            }}
          >
            ✓
          </button>
        ) : (
          <span
            aria-hidden="true"
            className="size-3 shrink-0 rounded-full"
            style={{ background: habit.color }}
          />
        )}

        <div className="min-w-0 flex-1">
          <Link to={`/habits/${habit.id}`} className="block truncate font-medium">
            {habit.title}
          </Link>
          <p className="text-sm text-hint">
            {weekly
              ? weekProgressLabel(item.week_done, habit.times_per_week ?? 0)
              : frequencyLabel(habit)}
            {item.streaks.current > 0 &&
              ` · серия ${streakLabel(item.streaks.current, item.streaks.unit)}`}
          </p>
        </div>
      </div>

      {habit.kind === 'quantity' && (
        <QuantityControl
          habit={habit}
          value={value}
          done={done}
          disabled={setMark.isPending}
          onChange={(next) => void mark(next)}
        />
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      )}
    </li>
  )
}

function QuantityControl({
  habit,
  value,
  done,
  disabled,
  onChange,
}: {
  habit: Habit
  value: number
  done: boolean
  disabled: boolean
  onChange: (value: number) => void
}) {
  const [text, setText] = useState<string | null>(null)
  const shown = text ?? String(value)
  const invalid = text !== null && parseValue(text, habit.kind) === null

  function commit() {
    if (text === null) return
    const parsed = parseValue(text, habit.kind)
    setText(null)
    if (parsed !== null && parsed !== value) onChange(parsed)
  }

  return (
    <div className="mt-3">
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-label={`Меньше: ${habit.title}`}
          disabled={disabled || value === 0}
          onClick={() => onChange(stepped(value, habit.target_value, -1))}
          className="size-11 rounded-xl bg-bg text-xl disabled:opacity-40"
        >
          −
        </button>
        <input
          inputMode="numeric"
          aria-label={`Значение: ${habit.title}`}
          aria-invalid={invalid}
          value={shown}
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
            if (e.key === 'Escape') setText(null)
          }}
          className="h-11 w-20 rounded-xl border border-separator bg-bg text-center text-lg aria-invalid:border-danger"
        />
        <button
          type="button"
          aria-label={`Больше: ${habit.title}`}
          disabled={disabled}
          onClick={() => onChange(stepped(value, habit.target_value, 1))}
          className="size-11 rounded-xl bg-bg text-xl disabled:opacity-40"
        >
          +
        </button>
        <span className="min-w-0 flex-1 text-sm text-hint" data-testid="progress">
          {progressLabel(habit, value)}
          {done && ' ✓'}
        </span>
      </div>
      <div
        className="mt-2 h-1.5 rounded-full bg-bg"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={habit.target_value}
        aria-valuenow={Math.min(value, habit.target_value)}
        aria-label={`Прогресс: ${habit.title}`}
      >
        <div
          className="h-full rounded-full"
          style={{
            width: `${Math.min(100, (value / habit.target_value) * 100)}%`,
            background: habit.color,
          }}
        />
      </div>
    </div>
  )
}
