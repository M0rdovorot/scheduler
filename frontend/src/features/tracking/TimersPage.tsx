import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { useRunningInstances, useStopInstance } from '@/api/instances'
import { useMe } from '@/api/me'
import type { Instance } from '@/api/types'
import { useCalendarStore } from '@/features/calendar/calendarStore'
import { formatTime, toLocalInput } from '@/features/calendar/localTime'
import { taskErrorMessage } from '@/features/calendar/messages'
import { useNow } from '@/lib/useNow'
import { usePlatform } from '@/platform/context'
import { formatElapsed, isTooLong, maxTimerHours } from './fact'

/** Every timer that is running, from any day, with its running time and a Stop button. */
export function TimersPage() {
  const { data: me } = useMe()
  const { data: timers, isPending, isError, refetch } = useRunningInstances()
  const now = useNow(1000)

  return (
    <main className="mx-auto max-w-md p-4">
      <h1 className="text-xl font-semibold">Таймеры</h1>

      {isPending && <p className="mt-3 text-hint">Загрузка…</p>}
      {isError && (
        <p role="alert" className="mt-3 text-danger">
          Не удалось загрузить таймеры.{' '}
          <button type="button" className="underline" onClick={() => void refetch()}>
            Повторить
          </button>
        </p>
      )}
      {timers && timers.length === 0 && (
        <p className="mt-3 text-hint">
          Нет запущенных таймеров. Запустить его можно в карточке дела кнопкой «Старт».
        </p>
      )}

      <ul className="mt-3 space-y-3">
        {timers?.map((timer) => (
          <TimerCard key={timer.id} timer={timer} tz={me?.timezone ?? 'UTC'} now={now} />
        ))}
      </ul>

      <nav className="mt-6">
        <Link to="/" className="text-link">
          В календарь
        </Link>
      </nav>
    </main>
  )
}

function TimerCard({ timer, tz, now }: { timer: Instance; tz: string; now: Date }) {
  const platform = usePlatform()
  const navigate = useNavigate()
  const stop = useStopInstance()
  const { setAnchor, setView } = useCalendarStore()
  const [error, setError] = useState<string | null>(null)

  const startedAt = new Date(timer.actual_start!)
  const long = isTooLong(startedAt, now)
  const startLocal = toLocalInput(startedAt, tz)
  const today = toLocalInput(now, tz).slice(0, 10)
  const startedDay = startLocal.slice(0, 10)

  async function onStop() {
    setError(null)
    try {
      await stop.mutateAsync(timer.id)
      platform.haptic.notify('success')
    } catch (e) {
      platform.haptic.notify('error')
      setError(taskErrorMessage(e))
    }
  }

  return (
    <li data-timer={timer.id} className="rounded-xl bg-surface p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-medium">{timer.title}</p>
          <p className="text-sm text-hint">
            с {formatTime(startedAt, tz)}
            {startedDay !== today && `, ${startedDay.slice(8)}.${startedDay.slice(5, 7)}`}
          </p>
        </div>
        <span className="text-xl font-semibold" data-testid="elapsed" aria-label="Время работы">
          {formatElapsed(now.getTime() - startedAt.getTime())}
        </span>
      </div>

      {long && (
        <p className="mt-2 text-sm text-danger" data-testid="too-long">
          Идёт больше {maxTimerHours} часов: в статистику входят только первые {maxTimerHours}.
          Остановите таймер или поправьте факт в карточке дела.
        </p>
      )}

      <div className="mt-3 flex gap-2">
        <button
          type="button"
          disabled={stop.isPending}
          onClick={() => void onStop()}
          className="rounded-xl bg-accent px-4 py-2 text-sm text-accent-fg disabled:opacity-50"
        >
          Стоп
        </button>
        <button
          type="button"
          onClick={() => {
            setAnchor(startedDay)
            setView('day')
            void navigate('/')
          }}
          className="rounded-xl bg-bg px-4 py-2 text-sm"
        >
          Открыть в календаре
        </button>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      )}
    </li>
  )
}
