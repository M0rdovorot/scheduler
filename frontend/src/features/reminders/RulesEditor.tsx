import type { ReminderKind, ReminderScope } from '@/api/types'
import { kindsFor, maxRules, newDraft, taskKinds, type RuleDraft, type Unit } from './rules'

interface RulesEditorProps {
  scope: ReminderScope | 'global'
  drafts: readonly RuleDraft[]
  errors: Record<number, string>
  onChange: (drafts: RuleDraft[]) => void
}

const fieldClass = 'rounded-xl border border-separator bg-surface px-2 py-2 text-sm'

const units: { value: Unit; label: string }[] = [
  { value: 'minute', label: 'мин' },
  { value: 'hour', label: 'ч' },
  { value: 'day', label: 'дн' },
]

/** The list of reminders of a level: a kind and an amount (or a time of day for a habit). */
export function RulesEditor({ scope, drafts, errors, onChange }: RulesEditorProps) {
  const kinds = taskKinds.filter((k) => kindsFor(scope).includes(k.kind))
  const patch = (i: number, change: Partial<RuleDraft>) =>
    onChange(drafts.map((d, j) => (j === i ? { ...d, ...change } : d)))

  return (
    <div>
      <ul className="space-y-2" data-testid="rules">
        {drafts.map((d, i) => (
          <li key={i} data-rule={i}>
            <div className="flex items-center gap-2">
              {d.kind === 'habit_time' ? (
                <>
                  <span className="flex-1">Напомнить в</span>
                  <input
                    type="time"
                    aria-label="Время напоминания"
                    className={fieldClass}
                    value={d.time}
                    onChange={(e) => patch(i, { time: e.target.value })}
                  />
                </>
              ) : (
                <>
                  <select
                    aria-label="Вид напоминания"
                    className={`min-w-0 flex-1 ${fieldClass}`}
                    value={d.kind}
                    onChange={(e) => patch(i, { kind: e.target.value as ReminderKind })}
                  >
                    {kinds.map((k) => (
                      <option key={k.kind} value={k.kind}>
                        {k.label}
                      </option>
                    ))}
                  </select>
                  <input
                    inputMode="numeric"
                    aria-label="Сколько"
                    aria-invalid={errors[i] !== undefined}
                    className={`w-14 shrink-0 ${fieldClass}`}
                    value={d.amount}
                    onChange={(e) => patch(i, { amount: e.target.value })}
                  />
                  <select
                    aria-label="Единица"
                    className={`shrink-0 ${fieldClass}`}
                    value={d.unit}
                    onChange={(e) => patch(i, { unit: e.target.value as Unit })}
                  >
                    {units.map((u) => (
                      <option key={u.value} value={u.value}>
                        {u.label}
                      </option>
                    ))}
                  </select>
                </>
              )}
              <button
                type="button"
                aria-label="Убрать напоминание"
                onClick={() => onChange(drafts.filter((_, j) => j !== i))}
                className="shrink-0 rounded-lg px-2 py-1 text-danger"
              >
                ✕
              </button>
            </div>
            {errors[i] && <p className="text-sm text-danger">{errors[i]}</p>}
          </li>
        ))}
      </ul>
      {drafts.length === 0 && <p className="text-sm text-hint">Напоминаний нет.</p>}
      <button
        type="button"
        disabled={drafts.length >= maxRules}
        onClick={() => onChange([...drafts, newDraft(scope)])}
        className="mt-2 rounded-xl bg-surface px-3 py-2 text-sm disabled:opacity-50"
      >
        + Напоминание
      </button>
    </div>
  )
}
