import { useState } from 'react'
import { useDeleteReminders, useReminderLevel, useSetReminders } from '@/api/reminders'
import type { ReminderLevel, ReminderScope } from '@/api/types'
import { Dialog } from '@/components/Dialog'
import { usePlatform } from '@/platform/context'
import { reminderErrorMessage } from './messages'
import { RulesEditor } from './RulesEditor'
import {
  draftFromRule,
  ruleLabel,
  rulesFromDrafts,
  sourceLabels,
  validateDrafts,
  type RuleDraft,
} from './rules'

type Mode = 'inherit' | 'custom' | 'off'

interface ReminderDialogProps {
  scope: ReminderScope
  id: string
  /** What the reminders are for, in the title. */
  subject: string
  onClose: () => void
}

/** The reminders of one category, series, occurrence or habit, in a dialog. */
export function ReminderDialog({ scope, id, subject, onClose }: ReminderDialogProps) {
  const level = useReminderLevel(scope, id)
  return (
    <Dialog title={`Напоминания: ${subject}`} onClose={onClose}>
      {level.isPending && <p className="text-hint">Загрузка…</p>}
      {level.isError && (
        <p role="alert" className="text-danger">
          Не удалось загрузить настройки.{' '}
          <button type="button" className="underline" onClick={() => void level.refetch()}>
            Повторить
          </button>
        </p>
      )}
      {level.data && <LevelForm scope={scope} id={id} level={level.data} onClose={onClose} />}
    </Dialog>
  )
}

function modeOf(level: ReminderLevel, habit: boolean): Mode {
  if (level.override === null) return 'inherit'
  if (level.override.enabled) return 'custom'
  // A habit has no "off": no reminders is what it has by default.
  return habit ? 'inherit' : 'off'
}

function LevelForm({
  scope,
  id,
  level,
  onClose,
}: {
  scope: ReminderScope
  id: string
  level: ReminderLevel
  onClose: () => void
}) {
  const platform = usePlatform()
  const set = useSetReminders()
  const remove = useDeleteReminders()
  const [mode, setMode] = useState<Mode>(() => modeOf(level, scope === 'habit'))
  // A new set of its own starts from what applies now: a change is easier than a blank page.
  const [drafts, setDrafts] = useState<RuleDraft[]>(() =>
    (level.override?.enabled ? level.override.rules : level.effective.rules).map(draftFromRule),
  )
  const [error, setError] = useState<string | null>(null)

  const habit = scope === 'habit'
  const errors = mode === 'custom' ? validateDrafts(drafts) : {}
  const busy = set.isPending || remove.isPending
  const canSave = Object.keys(errors).length === 0 && !busy

  async function save() {
    setError(null)
    try {
      if (mode === 'inherit') {
        if (level.override !== null) await remove.mutateAsync({ scope, id })
      } else {
        await set.mutateAsync({
          scope,
          id,
          enabled: mode === 'custom',
          rules: mode === 'custom' ? rulesFromDrafts(drafts) : [],
        })
      }
      platform.haptic.notify('success')
      onClose()
    } catch (e) {
      platform.haptic.notify('error')
      setError(reminderErrorMessage(e))
    }
  }

  const choices: { mode: Mode; label: string }[] = habit
    ? [
        { mode: 'inherit', label: 'Не напоминать' },
        { mode: 'custom', label: 'Напоминать в заданное время' },
      ]
    : [
        { mode: 'inherit', label: 'Как обычно' },
        { mode: 'custom', label: 'Свои напоминания' },
        { mode: 'off', label: 'Без напоминаний' },
      ]

  return (
    <div className="space-y-3">
      <div role="radiogroup" aria-label="Режим напоминаний" className="space-y-1">
        {choices.map((c) => (
          <label key={c.mode} className="flex items-center gap-2 rounded-xl bg-surface px-3 py-2">
            <input
              type="radio"
              name="reminder-mode"
              checked={mode === c.mode}
              onChange={() => setMode(c.mode)}
            />
            {c.label}
          </label>
        ))}
      </div>

      {mode === 'inherit' && !habit && (
        <div className="text-sm text-hint" data-testid="effective">
          {level.effective.rules.length === 0 ? (
            <p>Сейчас напоминаний нет ({sourceLabels[level.effective.source]}).</p>
          ) : (
            <>
              <p>Сейчас действуют {sourceLabels[level.effective.source]}:</p>
              <ul className="mt-1 list-disc pl-5">
                {level.effective.rules.map((r, i) => (
                  <li key={i}>{ruleLabel(r)}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
      {mode === 'off' && (
        <p className="text-sm text-hint">Бот не будет напоминать, пока вы не вернёте настройки.</p>
      )}
      {mode === 'custom' && (
        <RulesEditor scope={scope} drafts={drafts} errors={errors} onChange={setDrafts} />
      )}

      {error && (
        <p role="alert" className="text-danger">
          {error}
        </p>
      )}
      <div className="flex gap-2 pt-1">
        <button type="button" onClick={onClose} className="flex-1 rounded-xl bg-surface px-4 py-3">
          Отмена
        </button>
        <button
          type="button"
          disabled={!canSave}
          onClick={() => void save()}
          className="flex-1 rounded-xl bg-accent px-4 py-3 text-accent-fg disabled:opacity-50"
        >
          Сохранить
        </button>
      </div>
    </div>
  )
}
