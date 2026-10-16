import { useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { useArchiveHabit, useDeleteHabit, useHabitStats, useSetMark } from '@/api/habits'
import { useMe } from '@/api/me'
import type { Habit } from '@/api/types'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { Dialog } from '@/components/Dialog'
import { fullDayLabel, todayIn } from '@/features/calendar/dates'
import { useNow } from '@/lib/useNow'
import { usePlatform } from '@/platform/context'
import { HabitForm } from './HabitForm'
import { frequencyLabel, progressLabel, streakLabel, weekdayNames } from './format'
import { buildHeatmap, heatmapRange, monthNames, type HeatCell } from './heatmap'
import { habitErrorMessage } from './messages'
import { parseValue } from './marks'

const levelPercent = [8, 30, 50, 72, 100] as const

export function HabitPage() {
  const { id = '' } = useParams()
  const { data: me } = useMe()
  const tz = me?.timezone ?? 'UTC'
  // The range follows the date: a page left open past midnight moves on to the new day.
  const today = todayIn(tz, useNow(60_000))
  const range = useMemo(() => heatmapRange(today), [today])
  const stats = useHabitStats(id, range.from, range.to)
  const [dialog, setDialog] = useState<'edit' | 'delete' | { day: HeatCell } | null>(null)

  if (stats.isError && !stats.data) {
    return (
      <main className="mx-auto max-w-md p-4">
        <p role="alert" className="text-danger">
          Не удалось загрузить привычку. Возможно, она удалена.
        </p>
        <Link to="/habits" className="mt-3 block text-link">
          К привычкам
        </Link>
      </main>
    )
  }
  if (!stats.data) {
    return (
      <main className="mx-auto max-w-md p-4">
        <p className="text-hint">Загрузка…</p>
      </main>
    )
  }

  const { habit, streaks } = stats.data
  const weekly = habit.frequency === 'times_per_week'
  const heat = buildHeatmap(stats.data.days, habit.target_value, stats.data.today, weekly)

  return (
    <main className="mx-auto max-w-md p-4 pb-10">
      <Link to="/habits" className="text-link">
        ← Привычки
      </Link>

      <div className="mt-2 flex items-start gap-3">
        <span
          aria-hidden="true"
          className="mt-2 size-4 shrink-0 rounded-full"
          style={{ background: habit.color }}
        />
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold">{habit.title}</h1>
          <p className="text-sm text-hint">
            {frequencyLabel(habit)}
            {habit.kind === 'quantity' &&
              ` · цель ${habit.target_value}${habit.unit ? ` ${habit.unit}` : ''}`}
            {habit.placement &&
              ` · в календаре: ${habit.placement.time}, ${habit.placement.duration_minutes} мин`}
            {habit.archived_at && ' · в архиве'}
          </p>
        </div>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-2">
        <Tile id="current" label="Серия" value={streakLabel(streaks.current, streaks.unit)} />
        <Tile id="best" label="Лучшая серия" value={streakLabel(streaks.best, streaks.unit)} />
        <Tile id="p30" label="За 30 дней" value={percent(stats.data.percent_30)} />
        <Tile id="p90" label="За 90 дней" value={percent(stats.data.percent_90)} />
        <Tile id="pall" label="За всё время" value={percent(stats.data.percent_all)} />
      </dl>
      <p className="mt-1 text-xs text-hint">
        {weekly
          ? 'Серия — недели подряд, в которых цель набрана.'
          : 'Серия — запланированные дни подряд; незапланированные её не прерывают.'}
      </p>

      <section className="mt-5" aria-label="Тепловая карта">
        <h2 className="font-semibold">Последние {heat.weeks.length} недель</h2>
        <Heatmap habit={habit} heat={heat} onPick={(day) => setDialog({ day })} />
      </section>

      <div className="mt-6 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => setDialog('edit')}
          className="rounded-xl bg-surface px-4 py-2"
        >
          Изменить
        </button>
        <ArchiveButton habit={habit} />
        <button
          type="button"
          onClick={() => setDialog('delete')}
          className="rounded-xl bg-surface px-4 py-2 text-danger"
        >
          Удалить
        </button>
      </div>

      {dialog === 'edit' && <HabitForm habit={habit} onClose={() => setDialog(null)} />}
      {dialog === 'delete' && <DeleteDialog habit={habit} onClose={() => setDialog(null)} />}
      {typeof dialog === 'object' && dialog !== null && (
        <DayDialog habit={habit} cell={dialog.day} onClose={() => setDialog(null)} />
      )}
    </main>
  )
}

const percent = (value: number | null) => (value === null ? '—' : `${value}%`)

function Tile({ id, label, value }: { id: string; label: string; value: string }) {
  return (
    <div data-tile={id} className="rounded-xl bg-surface p-3">
      <dt className="text-xs text-hint">{label}</dt>
      <dd className="text-xl font-semibold">{value}</dd>
    </div>
  )
}

function Heatmap({
  habit,
  heat,
  onPick,
}: {
  habit: Habit
  heat: ReturnType<typeof buildHeatmap>
  onPick: (cell: HeatCell) => void
}) {
  const columns = heat.weeks.length
  return (
    <div className="mt-2 flex gap-1.5" data-testid="heatmap">
      <div
        aria-hidden="true"
        className="grid shrink-0 grid-rows-[auto_repeat(7,1fr)] gap-[3px] pr-0.5 text-[10px] text-hint"
      >
        <span className="h-3" />
        {weekdayNames.map((name, i) => (
          <span key={name} className="flex items-center">
            {i % 2 === 0 ? name : ''}
          </span>
        ))}
      </div>
      <div
        className="grid min-w-0 flex-1 gap-[3px]"
        style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
      >
        {heat.weeks.map((_, week) => {
          const label = heat.monthStarts.find((m) => m.week === week)
          return (
            <span
              key={`m${week}`}
              aria-hidden="true"
              className="h-3 overflow-visible whitespace-nowrap text-[10px] leading-3 text-hint"
              style={{ gridColumn: week + 1, gridRow: 1 }}
            >
              {label ? monthNames[label.month - 1] : ''}
            </span>
          )
        })}
        {heat.weeks.flatMap((cells, week) =>
          cells.map((cell, row) =>
            cell === null ? (
              <span key={`e${week}-${row}`} style={{ gridColumn: week + 1, gridRow: row + 2 }} />
            ) : (
              <button
                key={cell.date}
                type="button"
                disabled={cell.future}
                data-cell={cell.date}
                data-level={cell.level}
                aria-label={cellLabel(habit, cell)}
                title={cellLabel(habit, cell)}
                onClick={() => onPick(cell)}
                className={`aspect-square w-full rounded-[3px] border ${
                  cell.future || cell.off ? 'border-dashed border-separator' : 'border-transparent'
                }`}
                style={{
                  gridColumn: week + 1,
                  gridRow: row + 2,
                  background: cell.future
                    ? 'transparent'
                    : cell.off
                      ? 'transparent'
                      : `color-mix(in srgb, ${habit.color} ${levelPercent[cell.level]}%, var(--app-surface))`,
                }}
              />
            ),
          ),
        )}
      </div>
    </div>
  )
}

function cellLabel(habit: Habit, cell: HeatCell): string {
  const date = fullDayLabel(cell.date)
  if (cell.future) return `${date}: ещё не наступил`
  if (habit.kind === 'quantity')
    return `${date}: ${progressLabel(habit, cell.value)}${cell.done ? ', выполнено' : ''}`
  return `${date}: ${cell.done ? 'выполнено' : cell.off ? 'не по расписанию' : 'не выполнено'}`
}

function ArchiveButton({ habit }: { habit: Habit }) {
  const archive = useArchiveHabit()
  const platform = usePlatform()
  const [error, setError] = useState<string | null>(null)
  const archived = habit.archived_at !== null
  return (
    <>
      <button
        type="button"
        disabled={archive.isPending}
        onClick={() => {
          setError(null)
          archive.mutate(
            { id: habit.id, archived: !archived },
            {
              onSuccess: () => platform.haptic.notify('success'),
              onError: (e) => {
                platform.haptic.notify('error')
                setError(habitErrorMessage(e))
              },
            },
          )
        }}
        className="rounded-xl bg-surface px-4 py-2 disabled:opacity-50"
      >
        {archived ? 'Вернуть из архива' : 'В архив'}
      </button>
      {error && (
        <p role="alert" className="w-full text-sm text-danger">
          {error}
        </p>
      )}
    </>
  )
}

function DeleteDialog({ habit, onClose }: { habit: Habit; onClose: () => void }) {
  const remove = useDeleteHabit()
  const navigate = useNavigate()
  const [error, setError] = useState<string | null>(null)
  return (
    <ConfirmDialog
      title="Удалить привычку?"
      confirmLabel="Удалить"
      pending={remove.isPending}
      error={error}
      onCancel={onClose}
      onConfirm={() => {
        setError(null)
        remove.mutate(habit.id, {
          onSuccess: () => void navigate('/habits', { replace: true }),
          onError: (e) => setError(habitErrorMessage(e)),
        })
      }}
    >
      «{habit.title}» исчезнет вместе со всеми отметками и уйдёт из календаря. Дела, которые вы уже
      отметили выполненными, останутся в календаре. Если хотите сохранить историю, лучше отправьте
      привычку в архив.
    </ConfirmDialog>
  )
}

/** Sets the value of one day, also for a day in the past. */
function DayDialog({
  habit,
  cell,
  onClose,
}: {
  habit: Habit
  cell: HeatCell
  onClose: () => void
}) {
  const platform = usePlatform()
  const setMark = useSetMark()
  const [text, setText] = useState(String(cell.value))
  const [error, setError] = useState<string | null>(null)
  const parsed = parseValue(text, habit.kind)

  async function save(value: number) {
    setError(null)
    try {
      await setMark.mutateAsync({ id: habit.id, date: cell.date, value })
      platform.haptic.notify('success')
      onClose()
    } catch (e) {
      platform.haptic.notify('error')
      setError(habitErrorMessage(e))
    }
  }

  return (
    <Dialog title={fullDayLabel(cell.date)} onClose={onClose}>
      {habit.kind === 'boolean' ? (
        <div className="flex gap-2">
          <button
            type="button"
            aria-pressed={cell.value > 0}
            disabled={setMark.isPending}
            onClick={() => void save(1)}
            className="flex-1 rounded-xl bg-surface px-4 py-3 aria-pressed:bg-accent aria-pressed:text-accent-fg"
          >
            Выполнено
          </button>
          <button
            type="button"
            aria-pressed={cell.value === 0}
            disabled={setMark.isPending}
            onClick={() => void save(0)}
            className="flex-1 rounded-xl bg-surface px-4 py-3 aria-pressed:bg-accent aria-pressed:text-accent-fg"
          >
            Не выполнено
          </button>
        </div>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (parsed !== null) void save(parsed)
          }}
          className="space-y-3"
        >
          <label className="block">
            <span>
              Значение{habit.unit ? `, ${habit.unit}` : ''} (цель {habit.target_value})
            </span>
            <input
              inputMode="numeric"
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              className="mt-1 w-full rounded-xl border border-separator bg-surface px-3 py-2"
            />
          </label>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 rounded-xl bg-surface px-4 py-3"
            >
              Отмена
            </button>
            <button
              type="submit"
              disabled={parsed === null || setMark.isPending}
              className="flex-1 rounded-xl bg-accent px-4 py-3 text-accent-fg disabled:opacity-50"
            >
              Сохранить
            </button>
          </div>
        </form>
      )}
      {error && (
        <p role="alert" className="mt-3 text-danger">
          {error}
        </p>
      )}
    </Dialog>
  )
}
