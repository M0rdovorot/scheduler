import { useMemo, useState } from 'react'
import { Link } from 'react-router'
import { useMe } from '@/api/me'
import { useFreeTime, usePartners } from '@/api/partners'
import { dayRange, fullDayLabel, todayIn } from '@/features/calendar/dates'
import { useNow } from '@/lib/useNow'
import {
  daysFrom,
  formatDuration,
  formatSlot,
  freeByDay,
  parseTimeOfDay,
  type FreeFilter,
} from './freeTime'
import { partnerErrorMessage } from './messages'

const spans = [1, 3, 7, 14, 30] as const
const lengths = [30, 60, 120, 180] as const
const fieldClass = 'mt-1 w-full rounded-xl border border-separator bg-surface px-3 py-2'

const spanWord = (n: number) => (n === 1 ? 'день' : n < 5 ? 'дня' : 'дней')
const lengthLabel = (m: number) => (m < 60 ? `${m} мин` : `${m / 60} ч`)

/** When the user and the chosen partners are all free (FR-11.6). */
export function FreeTimePage() {
  const { data: me } = useMe()
  if (!me) return null
  return <FreeTime tz={me.timezone} />
}

function FreeTime({ tz }: { tz: string }) {
  const now = useNow(60_000)
  const today = todayIn(tz, now)
  const partners = usePartners()

  const [chosen, setChosen] = useState<readonly string[]>([])
  const [first, setFirst] = useState<string | null>(null)
  const [span, setSpan] = useState<number>(7)
  const [minMinutes, setMinMinutes] = useState<number>(60)
  const [fromText, setFromText] = useState('09:00')
  const [toText, setToText] = useState('21:00')

  const start = first ?? today
  const days = useMemo(() => daysFrom(start, span), [start, span])
  const { from, to } = useMemo(() => dayRange(days, tz), [days, tz])
  const fromMin = parseTimeOfDay(fromText)
  const toMin = parseTimeOfDay(toText)
  const hoursOk = fromMin !== null && toMin !== null && fromMin < toMin

  const free = useFreeTime(chosen, from, to, minMinutes, chosen.length > 0)
  const shown = useMemo(() => {
    if (!free.data || fromMin === null || toMin === null || !hoursOk) return []
    const filter: FreeFilter = { minMinutes, fromMin, toMin }
    return freeByDay(free.data, days, tz, filter)
  }, [free.data, days, tz, minMinutes, fromMin, toMin, hoursOk])

  const toggle = (id: string) =>
    setChosen((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]))

  return (
    <main className="mx-auto max-w-md p-4">
      <h1 className="text-xl font-semibold">Свободное время</h1>

      <fieldset className="mt-3">
        <legend>С кем</legend>
        {partners.isPending && <p className="text-hint">Загрузка…</p>}
        {partners.data?.length === 0 && (
          <p className="text-hint">
            Партнёров нет.{' '}
            <Link to="/partners" className="text-link">
              Пригласить
            </Link>
          </p>
        )}
        <div className="mt-1 space-y-1">
          {partners.data?.map((p) => (
            <label key={p.id} className="flex items-center gap-2 rounded-xl bg-surface px-3 py-2">
              <input
                type="checkbox"
                checked={chosen.includes(p.id)}
                onChange={() => toggle(p.id)}
              />
              {p.display_name}
            </label>
          ))}
        </div>
      </fieldset>

      <div className="mt-3 grid grid-cols-2 gap-3">
        <label className="block">
          <span>С даты</span>
          <input
            type="date"
            className={fieldClass}
            value={start}
            onChange={(e) => e.target.value && setFirst(e.target.value)}
          />
        </label>
        <label className="block">
          <span>На сколько</span>
          <select
            className={fieldClass}
            value={span}
            onChange={(e) => setSpan(Number(e.target.value))}
          >
            {spans.map((n) => (
              <option key={n} value={n}>
                {n} {spanWord(n)}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className="mt-3 block">
        <span>Не короче</span>
        <select
          className={fieldClass}
          value={minMinutes}
          onChange={(e) => setMinMinutes(Number(e.target.value))}
        >
          {lengths.map((m) => (
            <option key={m} value={m}>
              {lengthLabel(m)}
            </option>
          ))}
        </select>
      </label>

      <div className="mt-3 grid grid-cols-2 gap-3">
        <label className="block">
          <span>Искать с</span>
          <input
            type="time"
            className={fieldClass}
            value={fromText}
            onChange={(e) => setFromText(e.target.value)}
          />
        </label>
        <label className="block">
          <span>до</span>
          <input
            type="time"
            className={fieldClass}
            value={toText}
            onChange={(e) => setToText(e.target.value)}
          />
        </label>
      </div>
      {!hoursOk && (
        <p role="alert" className="mt-2 text-sm text-danger">
          Укажите часы так, чтобы «С» было раньше «До»
        </p>
      )}

      <section className="mt-4" aria-live="polite">
        {chosen.length === 0 && (
          <p className="text-hint">
            Выберите, с кем искать время. Без партнёров показано только ваше свободное время.
          </p>
        )}
        {free.isError && (
          <p role="alert" className="text-danger">
            {partnerErrorMessage(free.error)}{' '}
            <button type="button" className="underline" onClick={() => void free.refetch()}>
              Повторить
            </button>
          </p>
        )}
        {free.isFetching && !free.data && <p className="text-hint">Ищем…</p>}
        {free.data && hoursOk && shown.length === 0 && (
          <p className="text-hint">В этот период общего свободного времени нет.</p>
        )}
        <ul className="space-y-3">
          {shown.map(({ day, slots }) => (
            <li key={day}>
              <h2 className="font-medium">{fullDayLabel(day)}</h2>
              <ul className="mt-1 space-y-1">
                {slots.map((s) => (
                  <li
                    key={s.startMin}
                    className="flex justify-between rounded-xl bg-surface px-3 py-2"
                  >
                    <span>{formatSlot(s)}</span>
                    <span className="text-hint">{formatDuration(s.endMin - s.startMin)}</span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </section>

      <nav className="mt-6 flex gap-4">
        <Link to="/partners" className="text-link">
          Партнёры
        </Link>
        <Link to="/" className="text-link">
          На главную
        </Link>
      </nav>
    </main>
  )
}
