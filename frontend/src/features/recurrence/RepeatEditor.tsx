import { useId } from 'react'
import type { Day } from '@/features/calendar/dates'
import { weekdayIndex } from '@/features/calendar/dates'
import {
  defaultRepeat,
  describeRepeat,
  maxCount,
  maxInterval,
  monthlyModes,
  nthWeekdayOfMonth,
  validateRepeat,
  weekdayShortNames,
  withFreq,
  type Freq,
  type MonthlyMode,
  type Repeat,
} from './repeat'

interface RepeatEditorProps {
  /** null: the task does not repeat. */
  value: Repeat | null
  /** The date of the first occurrence slot; monthly modes and the end date depend on it. */
  startDay: Day
  onChange: (value: Repeat | null) => void
}

const fieldClass = 'rounded-xl border border-separator bg-surface px-3 py-2'

const freqOptions: readonly { value: Freq | ''; label: string }[] = [
  { value: '', label: 'Не повторять' },
  { value: 'daily', label: 'Каждый день' },
  { value: 'weekly', label: 'Каждую неделю' },
  { value: 'monthly', label: 'Каждый месяц' },
  { value: 'yearly', label: 'Каждый год' },
]

const intervalUnits: Record<Freq, string> = {
  daily: 'дн.',
  weekly: 'нед.',
  monthly: 'мес.',
  yearly: 'лет',
}

const endOptions = [
  { value: 'never', label: 'Никогда' },
  { value: 'until', label: 'До даты' },
  { value: 'count', label: 'После числа повторов' },
] as const

function monthlyLabel(mode: MonthlyMode, startDay: Day): string {
  const weekday = weekdayShortNames[weekdayIndex(startDay)] ?? ''
  switch (mode) {
    case 'monthday':
      return `${Number(startDay.slice(8))}-го числа`
    case 'nth':
      return `${nthWeekdayOfMonth(startDay)}-й ${weekday} месяца`
    case 'last':
      return `последний ${weekday} месяца`
  }
}

/** The repeat rule editor (FR-4.1): frequency, interval, weekdays or monthly mode, and the end. */
export function RepeatEditor({ value, startDay, onChange }: RepeatEditorProps) {
  const ids = { freq: useId(), interval: useId(), endKind: useId(), endValue: useId() }
  const errors = value ? validateRepeat(value, startDay) : {}

  const update = (patch: Partial<Repeat>) => value && onChange({ ...value, ...patch })

  return (
    <fieldset className="space-y-3">
      <legend className="sr-only">Повтор</legend>

      <label className="block" htmlFor={ids.freq}>
        <span>Повтор</span>
      </label>
      <select
        id={ids.freq}
        className={`${fieldClass} w-full`}
        value={value?.freq ?? ''}
        onChange={(e) => {
          const freq = e.target.value as Freq | ''
          if (freq === '') onChange(null)
          else onChange(value ? withFreq(value, freq, startDay) : defaultRepeat(freq, startDay))
        }}
      >
        {freqOptions.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>

      {value && (
        <>
          <div className="flex items-center gap-2">
            <label htmlFor={ids.interval}>Каждые</label>
            <input
              id={ids.interval}
              type="number"
              inputMode="numeric"
              min={1}
              max={maxInterval}
              className={`${fieldClass} w-20`}
              value={Number.isNaN(value.interval) ? '' : value.interval}
              onChange={(e) =>
                update({ interval: e.target.value === '' ? NaN : Number(e.target.value) })
              }
              aria-invalid={errors.interval !== undefined}
            />
            <span>{intervalUnits[value.freq]}</span>
          </div>
          {errors.interval && <p className="text-sm text-danger">{errors.interval}</p>}

          {value.freq === 'weekly' && (
            <div>
              <div role="group" aria-label="Дни недели" className="flex gap-1">
                {weekdayShortNames.map((name, index) => {
                  const on = value.weekdays.includes(index)
                  return (
                    <button
                      key={name}
                      type="button"
                      aria-pressed={on}
                      onClick={() =>
                        update({
                          weekdays: (on
                            ? value.weekdays.filter((d) => d !== index)
                            : [...value.weekdays, index]
                          ).sort((a, b) => a - b),
                        })
                      }
                      className="h-9 flex-1 rounded-lg bg-surface text-sm aria-pressed:bg-accent aria-pressed:text-accent-fg"
                    >
                      {name}
                    </button>
                  )
                })}
              </div>
              {errors.weekdays && <p className="mt-1 text-sm text-danger">{errors.weekdays}</p>}
            </div>
          )}

          {value.freq === 'monthly' && (
            <div role="radiogroup" aria-label="День месяца" className="space-y-1">
              {monthlyModes(startDay).map((mode) => (
                <label key={mode} className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="monthly-mode"
                    checked={value.monthly === mode}
                    onChange={() => update({ monthly: mode })}
                  />
                  {monthlyLabel(mode, startDay)}
                </label>
              ))}
            </div>
          )}

          <div className="flex items-center gap-2">
            <label htmlFor={ids.endKind}>Закончить</label>
            <select
              id={ids.endKind}
              className={`${fieldClass} flex-1`}
              value={value.end.kind}
              onChange={(e) => {
                const kind = e.target.value as 'never' | 'until' | 'count'
                if (kind === 'never') update({ end: { kind } })
                if (kind === 'count') update({ end: { kind, count: 10 } })
                if (kind === 'until') update({ end: { kind, day: startDay } })
              }}
            >
              {endOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>

          {value.end.kind === 'until' && (
            <input
              id={ids.endValue}
              type="date"
              aria-label="Дата окончания"
              className={`${fieldClass} w-full`}
              value={value.end.day}
              onChange={(e) => update({ end: { kind: 'until', day: e.target.value } })}
            />
          )}
          {value.end.kind === 'count' && (
            <div className="flex items-center gap-2">
              <input
                id={ids.endValue}
                type="number"
                inputMode="numeric"
                min={1}
                max={maxCount}
                aria-label="Число повторов"
                className={`${fieldClass} w-24`}
                value={Number.isNaN(value.end.count) ? '' : value.end.count}
                onChange={(e) =>
                  update({
                    end: {
                      kind: 'count',
                      count: e.target.value === '' ? NaN : Number(e.target.value),
                    },
                  })
                }
              />
              <span>повторов</span>
            </div>
          )}
          {errors.end && <p className="text-sm text-danger">{errors.end}</p>}

          <p className="text-sm text-hint" data-testid="repeat-summary">
            {describeRepeat(value, startDay)}
          </p>
        </>
      )}
    </fieldset>
  )
}
