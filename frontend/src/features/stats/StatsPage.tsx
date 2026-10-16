import { useMemo, useState } from 'react'
import { Link } from 'react-router'
import { useCategories } from '@/api/categories'
import { useStats } from '@/api/instances'
import { useMe } from '@/api/me'
import type { Instance, StatsReport } from '@/api/types'
import { todayIn } from '@/features/calendar/dates'
import { formatTime } from '@/features/calendar/localTime'
import { deviationText, maxTimerHours, statusLabels } from '@/features/tracking/fact'
import { ChartLegend, ChartTable, DailyChart } from './DailyChart'
import { buildChart } from './chartData'
import { formatDuration } from './format'
import {
  customError,
  newPeriod,
  periodLabel,
  periodDays,
  periodRange,
  shiftPeriod,
  type Period,
  type PeriodKind,
} from './period'
import { statsRows } from './tree'

const kinds: { kind: PeriodKind; label: string }[] = [
  { kind: 'day', label: 'День' },
  { kind: 'week', label: 'Неделя' },
  { kind: 'month', label: 'Месяц' },
  { kind: 'custom', label: 'Период' },
]

export function StatsPage() {
  const { data: me } = useMe()
  const tz = me?.timezone ?? 'UTC'
  const today = todayIn(tz)
  const [period, setPeriod] = useState<Period>(() => newPeriod('week', today))

  const days = periodDays(period)
  const error = period.kind === 'custom' ? customError(period.customFrom, period.customTo) : null
  const range = useMemo(
    // An invalid custom range (a cleared date input) is never requested: fall back to the anchor.
    () => periodRange(error === null ? period : { ...period, kind: 'day' }, tz),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the period fields are the inputs
    [period.kind, period.anchor, period.customFrom, period.customTo, tz, error],
  )
  const stats = useStats(range.from, range.to, error === null && me !== undefined)
  const { data: categories } = useCategories()

  function pickKind(kind: PeriodKind) {
    if (kind === period.kind) return
    // Keep the dates in view: a custom range starts as the current period, and leaving
    // it continues from the range the user was looking at.
    if (kind === 'custom') {
      setPeriod({ ...period, kind, customFrom: days.first, customTo: days.last })
    } else if (period.kind === 'custom' && error === null) {
      setPeriod({ ...period, kind, anchor: period.customFrom })
    } else {
      setPeriod({ ...period, kind })
    }
  }

  const stale = stats.isPlaceholderData
  const report = stats.data

  return (
    <main className="mx-auto max-w-md p-4 pb-10">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Статистика</h1>
        <Link to="/" className="text-link">
          В календарь
        </Link>
      </div>

      <div role="tablist" aria-label="Период" className="mt-3 flex gap-1 rounded-xl bg-surface p-1">
        {kinds.map(({ kind, label }) => (
          <button
            key={kind}
            type="button"
            role="tab"
            aria-selected={period.kind === kind}
            onClick={() => pickKind(kind)}
            className={`flex-1 rounded-lg px-2 py-1.5 text-sm ${
              period.kind === kind ? 'bg-bg font-medium shadow-sm' : 'text-hint'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {period.kind === 'custom' ? (
        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            aria-label="Предыдущий период"
            disabled={error !== null}
            onClick={() => setPeriod(shiftPeriod(period, -1))}
            className="rounded-xl bg-surface px-3 py-2 disabled:opacity-40"
          >
            ‹
          </button>
          <input
            type="date"
            aria-label="С"
            value={period.customFrom}
            onChange={(e) => setPeriod({ ...period, customFrom: e.target.value })}
            className="min-w-0 flex-1 rounded-xl bg-surface px-2 py-2"
          />
          <input
            type="date"
            aria-label="По"
            value={period.customTo}
            onChange={(e) => setPeriod({ ...period, customTo: e.target.value })}
            className="min-w-0 flex-1 rounded-xl bg-surface px-2 py-2"
          />
          <button
            type="button"
            aria-label="Следующий период"
            disabled={error !== null}
            onClick={() => setPeriod(shiftPeriod(period, 1))}
            className="rounded-xl bg-surface px-3 py-2 disabled:opacity-40"
          >
            ›
          </button>
        </div>
      ) : (
        <div className="mt-3 flex items-center justify-between gap-2">
          <button
            type="button"
            aria-label="Предыдущий период"
            onClick={() => setPeriod(shiftPeriod(period, -1))}
            className="rounded-xl bg-surface px-4 py-2"
          >
            ‹
          </button>
          <p className="font-medium" data-testid="period-label">
            {periodLabel(period, Number(today.slice(0, 4)))}
          </p>
          <button
            type="button"
            aria-label="Следующий период"
            onClick={() => setPeriod(shiftPeriod(period, 1))}
            className="rounded-xl bg-surface px-4 py-2"
          >
            ›
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      )}

      {error === null && stats.isPending && <p className="mt-4 text-hint">Загрузка…</p>}
      {error === null && stats.isError && (
        <p role="alert" className="mt-4 text-danger">
          Не удалось загрузить статистику.{' '}
          <button type="button" className="underline" onClick={() => void stats.refetch()}>
            Повторить
          </button>
        </p>
      )}

      {report && error === null && (
        <div className={stale ? 'opacity-60' : ''} data-testid="stats-body" aria-busy={stale}>
          <Report
            report={report}
            categories={categories ?? []}
            tz={tz}
            singleDay={days.first === days.last}
          />
        </div>
      )}
    </main>
  )
}

function Report({
  report,
  categories,
  tz,
  singleDay,
}: {
  report: StatsReport
  categories: NonNullable<ReturnType<typeof useCategories>['data']>
  tz: string
  singleDay: boolean
}) {
  const [asTable, setAsTable] = useState(false)
  const chart = useMemo(
    () => buildChart(report.days, categories, { uncategorized: 'Без категории', other: 'Другое' }),
    [report.days, categories],
  )
  const rows = useMemo(
    () => statsRows(categories, new Map(report.categories.map((c) => [c.category_id, c.minutes]))),
    [report.categories, categories],
  )
  const topMinutes = rows.reduce((m, r) => Math.max(m, r.minutes), 0)
  const pvf = report.plan_vs_fact
  const empty =
    report.actual_minutes === 0 && report.planned_minutes === 0 && pvf.planned_count === 0

  return (
    <>
      {report.long_running_timers > 0 && (
        <p className="mt-3 rounded-xl bg-surface p-3 text-sm" data-testid="long-timers">
          Запущено слишком давно: таймеров — {report.long_running_timers}. В статистику идут только
          первые {maxTimerHours} ч каждого.{' '}
          <Link to="/timers" className="text-link">
            К таймерам
          </Link>
        </p>
      )}

      <section className="mt-4" aria-label="Итоги">
        <p className="text-sm text-hint">Факт</p>
        <p className="text-5xl font-semibold" data-testid="actual-total">
          {formatDuration(report.actual_minutes)}
        </p>
        <p className="mt-1 text-sm text-hint">
          План: {formatDuration(report.planned_minutes)}
          {report.unplanned_count > 0 &&
            ` · вне плана: ${formatDuration(report.unplanned_minutes)} (${report.unplanned_count})`}
        </p>

        <dl className="mt-3 grid grid-cols-2 gap-2">
          <Tile
            label="Выполнено"
            value={pvf.percent_done === null ? '—' : `${pvf.percent_done}%`}
            id="percent-done"
          />
          <Tile label="Начали позже" value={String(pvf.late_starts)} id="late-starts" />
          <Tile label="Затянулось" value={String(pvf.overran)} id="overran" />
          <Tile label="Не выполнено" value={String(pvf.not_done)} id="not-done" />
          <Tile label="Перенесено" value={String(pvf.rescheduled)} id="rescheduled" />
          <Tile label="Не отмечено" value={String(pvf.unmarked)} id="unmarked" />
        </dl>
        <p className="mt-2 text-sm text-hint">
          Дел в плане: {pvf.planned_count} — выполнено {pvf.done}, частично {pvf.partial}
          {pvf.in_progress > 0 && `, идёт ${pvf.in_progress}`}
          {pvf.upcoming > 0 && `, впереди ${pvf.upcoming}`}.
        </p>
      </section>

      {empty && (
        <p className="mt-6 text-hint" data-testid="stats-empty">
          За этот период ничего нет. Запланируйте дела в календаре и отмечайте, как всё прошло.
        </p>
      )}

      {!empty && !singleDay && chart.series.length > 0 && (
        <section className="mt-6" aria-label="Часы по дням">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">Часы по дням</h2>
            <button
              type="button"
              onClick={() => setAsTable((v) => !v)}
              className="text-sm text-link"
              aria-pressed={asTable}
            >
              {asTable ? 'График' : 'Таблица'}
            </button>
          </div>
          {asTable ? (
            <ChartTable columns={chart.columns} series={chart.series} />
          ) : (
            <>
              <DailyChart columns={chart.columns} series={chart.series} />
              <ChartLegend series={chart.series} />
            </>
          )}
        </section>
      )}

      {rows.length > 0 || report.uncategorized_minutes > 0 ? (
        <section className="mt-6" aria-label="Категории">
          <h2 className="font-semibold">Категории</h2>
          <ul className="mt-2 space-y-2" data-testid="category-rows">
            {rows.map(({ category, depth, minutes }) => (
              <li key={category.id} style={{ paddingLeft: depth * 16 }} data-category={category.id}>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="min-w-0 truncate">{category.name}</span>
                  <span className="shrink-0 text-sm">{formatDuration(minutes)}</span>
                </div>
                <div className="mt-1 h-1.5 rounded-full bg-surface" aria-hidden="true">
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${topMinutes > 0 ? (minutes / topMinutes) * 100 : 0}%`,
                      background: category.color,
                    }}
                  />
                </div>
              </li>
            ))}
            {report.uncategorized_minutes > 0 && (
              <li data-category="none">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-hint">Без категории</span>
                  <span className="shrink-0 text-sm">
                    {formatDuration(report.uncategorized_minutes)}
                  </span>
                </div>
              </li>
            )}
          </ul>
          <p className="mt-2 text-xs text-hint">
            Дело считается в каждой своей категории и во всех её родителях, поэтому строки в сумме
            могут давать больше общего времени.
          </p>
        </section>
      ) : null}

      {report.tasks.length > 0 && (
        <section className="mt-6" aria-label="Дела">
          <h2 className="font-semibold">Дела</h2>
          <ul className="mt-2 divide-y divide-separator" data-testid="task-rows">
            {report.tasks.map((task) => (
              <li key={task.title} className="flex items-baseline justify-between gap-2 py-1.5">
                <span className="min-w-0 truncate">
                  {task.title}
                  {task.count > 1 && <span className="text-hint"> ×{task.count}</span>}
                </span>
                <span className="shrink-0 text-sm">{formatDuration(task.minutes)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {report.deviations.length > 0 && (
        <section className="mt-6" aria-label="Отклонения">
          <h2 className="font-semibold">Отклонения</h2>
          <ul className="mt-2 space-y-2" data-testid="deviation-rows">
            {report.deviations.map((instance) => (
              <DeviationRow key={instance.id} instance={instance} tz={tz} />
            ))}
          </ul>
        </section>
      )}
    </>
  )
}

function Tile({ label, value, id }: { label: string; value: string; id: string }) {
  return (
    <div className="rounded-xl bg-surface p-3" data-tile={id}>
      <dt className="text-xs text-hint">{label}</dt>
      <dd className="text-xl font-semibold">{value}</dd>
    </div>
  )
}

function DeviationRow({ instance, tz }: { instance: Instance; tz: string }) {
  const when = instance.planned_start ?? instance.actual_start
  const date = when ? new Date(when) : null
  return (
    <li className="rounded-xl bg-surface p-3" data-deviation={instance.id}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="min-w-0 truncate font-medium">{instance.title}</span>
        {date && (
          <span className="shrink-0 text-xs text-hint">
            {date.toLocaleDateString('ru', { day: 'numeric', month: 'short', timeZone: tz })},{' '}
            {formatTime(date, tz)}
          </span>
        )}
      </div>
      <p className="text-sm text-hint">{statusLabels[instance.status]}</p>
      {instance.deviations.map((d) => (
        <p key={d.kind} className="text-sm">
          {deviationText(d)}
        </p>
      ))}
      {instance.comment && <p className="mt-1 text-sm italic">«{instance.comment}»</p>}
    </li>
  )
}
