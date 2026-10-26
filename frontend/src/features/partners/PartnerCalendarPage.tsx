import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router'
import { useMe } from '@/api/me'
import { usePartnerBusy, usePartners } from '@/api/partners'
import type { Category, ViewMode } from '@/api/types'
import { ApiError } from '@/api/errors'
import {
  dayRange,
  rangeLabel,
  shiftAnchor,
  todayIn,
  visibleDays,
  type Day,
} from '@/features/calendar/dates'
import { TimeGrid } from '@/features/calendar/TimeGrid'
import { useNow } from '@/lib/useNow'
import { busyInstances } from './busyInstances'
import { partnerErrorMessage } from './messages'

const views: readonly { value: ViewMode; label: string }[] = [
  { value: 'day', label: 'День' },
  { value: 'three_days', label: '3 дня' },
  { value: 'week', label: 'Неделя' },
]

const noCategories: ReadonlyMap<string, Category> = new Map()
const noColors: ReadonlyMap<string, string> = new Map()
const ignore = () => undefined

/** The calendar of a partner: when they are busy, and by name only where they allow it. */
export function PartnerCalendarPage() {
  const { id = '' } = useParams()
  const { data: me } = useMe()
  if (!me) return null
  return <PartnerCalendar id={id} tz={me.timezone} slot={me.slot_minutes} view={me.default_view} />
}

interface PartnerCalendarProps {
  id: string
  tz: string
  slot: 5 | 10 | 15 | 30 | 60
  view: ViewMode
}

function PartnerCalendar({ id, tz, slot, view: defaultView }: PartnerCalendarProps) {
  const now = useNow()
  const today = todayIn(tz, now)
  const [view, setView] = useState<ViewMode>(defaultView)
  const [anchor, setAnchor] = useState<Day | null>(null)
  const day = anchor ?? today

  const days = useMemo(() => visibleDays(view, day), [view, day])
  const { from, to } = useMemo(() => dayRange(days, tz), [days, tz])
  const busy = usePartnerBusy(id, from, to)
  const partners = usePartners()
  const name = partners.data?.find((p) => p.id === id)?.display_name

  const instances = useMemo(() => busyInstances(busy.data ?? []), [busy.data])
  const gone = busy.error instanceof ApiError && busy.error.status === 404

  const iconButton = 'size-9 rounded-xl bg-surface text-lg leading-none'
  return (
    <div className="flex h-screen-safe flex-col">
      <header className="space-y-2 px-3 pb-2 pt-3">
        <div className="flex items-center justify-between gap-2">
          <h1 className="min-w-0 truncate text-base font-semibold">{name ?? 'Партнёр'}</h1>
          <Link to="/partners" className="shrink-0 rounded-xl bg-surface px-3 py-2 text-sm">
            Партнёры
          </Link>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-label="Назад"
            className={iconButton}
            onClick={() => setAnchor(shiftAnchor(view, day, -1))}
          >
            ‹
          </button>
          <button
            type="button"
            aria-label="Вперёд"
            className={iconButton}
            onClick={() => setAnchor(shiftAnchor(view, day, 1))}
          >
            ›
          </button>
          <div className="relative min-w-0 flex-1">
            <p className="truncate text-base font-semibold">
              {rangeLabel(days, Number(today.slice(0, 4)))}
            </p>
            <input
              type="date"
              aria-label="Выбрать дату"
              value={day}
              onChange={(e) => e.target.value && setAnchor(e.target.value)}
              className="absolute inset-0 size-full cursor-pointer opacity-0"
            />
          </div>
          <button
            type="button"
            className="rounded-xl bg-surface px-3 py-2 text-sm"
            onClick={() => setAnchor(null)}
          >
            Сегодня
          </button>
        </div>
        <div
          role="radiogroup"
          aria-label="Вид календаря"
          className="flex rounded-xl bg-surface p-0.5"
        >
          {views.map((v) => (
            <button
              key={v.value}
              type="button"
              role="radio"
              aria-checked={view === v.value}
              onClick={() => setView(v.value)}
              className="flex-1 rounded-[10px] py-1.5 text-sm aria-checked:bg-bg aria-checked:font-semibold aria-checked:shadow-sm"
            >
              {v.label}
            </button>
          ))}
        </div>
      </header>

      {gone && (
        <p role="alert" className="px-3 pb-2 text-sm text-danger">
          {partnerErrorMessage(busy.error)}{' '}
          <Link to="/partners" className="underline">
            К партнёрам
          </Link>
        </p>
      )}
      {busy.isError && !gone && (
        <p role="alert" className="px-3 pb-2 text-sm text-danger">
          Не удалось загрузить календарь.{' '}
          <button type="button" className="underline" onClick={() => void busy.refetch()}>
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
        mode="plan"
        instances={instances}
        categoriesById={noCategories}
        habitColors={noColors}
        readOnly
        onSelect={ignore}
        onOpen={ignore}
        onOpenDay={(d) => {
          setAnchor(d)
          setView('day')
        }}
      />
    </div>
  )
}
