import { useState } from 'react'
import { useGlobalReminders, useSetGlobalReminders } from '@/api/reminders'
import type { GlobalReminders as Global } from '@/api/types'
import { usePlatform } from '@/platform/context'
import { reminderErrorMessage } from './messages'
import { RulesEditor } from './RulesEditor'
import {
  draftFromRule,
  quietDraft,
  quietError,
  quietFromDraft,
  rulesFromDrafts,
  validateDrafts,
  type QuietDraft,
  type RuleDraft,
} from './rules'

/** The master switch, the quiet hours and the default reminders (FR-9.2, FR-9.4, FR-9.7). */
export function GlobalReminders() {
  const { data, isPending, isError, refetch } = useGlobalReminders()
  return (
    <section className="mt-8 border-t border-separator pt-4" aria-label="Напоминания">
      <h2 className="text-lg font-semibold">Напоминания бота</h2>
      {isPending && <p className="mt-2 text-hint">Загрузка…</p>}
      {isError && (
        <p role="alert" className="mt-2 text-danger">
          Не удалось загрузить напоминания.{' '}
          <button type="button" className="underline" onClick={() => void refetch()}>
            Повторить
          </button>
        </p>
      )}
      {data && <GlobalForm saved={data} />}
    </section>
  )
}

function GlobalForm({ saved }: { saved: Global }) {
  const platform = usePlatform()
  const save = useSetGlobalReminders()
  const [enabled, setEnabled] = useState(saved.enabled)
  const [quiet, setQuiet] = useState<QuietDraft>(() => quietDraft(saved.quiet_hours))
  const [drafts, setDrafts] = useState<RuleDraft[]>(() => saved.rules.map(draftFromRule))
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  const ruleErrors = validateDrafts(drafts)
  const quietProblem = quietError(quiet)
  const canSave = Object.keys(ruleErrors).length === 0 && quietProblem === null && !save.isPending

  async function toggle(on: boolean) {
    setEnabled(on)
    setDone(false)
    setNotice(null)
    if (!on) return
    // The bot may write to the user only after they allow it (FR-9.7).
    const allowed = await platform.requestWriteAccess()
    if (!allowed && platform.kind === 'telegram') {
      setNotice(
        'Telegram не разрешил боту писать вам. Откройте чат с ботом и нажмите «Старт», затем включите напоминания снова.',
      )
    }
  }

  async function submit() {
    setError(null)
    setDone(false)
    try {
      await save.mutateAsync({
        enabled,
        quiet_hours: quietFromDraft(quiet),
        rules: rulesFromDrafts(drafts),
      })
      platform.haptic.notify('success')
      setDone(true)
    } catch (e) {
      platform.haptic.notify('error')
      setError(reminderErrorMessage(e))
    }
  }

  return (
    <div className="mt-3 space-y-4">
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={enabled} onChange={(e) => void toggle(e.target.checked)} />
        <span>Присылать напоминания</span>
      </label>
      {notice && (
        <p role="status" className="text-sm text-hint">
          {notice}
        </p>
      )}

      <div className={enabled ? '' : 'pointer-events-none opacity-50'} aria-disabled={!enabled}>
        <fieldset disabled={!enabled} className="space-y-4">
          <div>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={quiet.on}
                onChange={(e) => {
                  setDone(false)
                  setQuiet({ ...quiet, on: e.target.checked })
                }}
              />
              <span>Тихие часы</span>
            </label>
            {quiet.on && (
              <div className="mt-2 flex items-center gap-2">
                <input
                  type="time"
                  aria-label="Тихие часы с"
                  className="rounded-xl border border-separator bg-surface px-2 py-2"
                  value={quiet.start}
                  onChange={(e) => {
                    setDone(false)
                    setQuiet({ ...quiet, start: e.target.value })
                  }}
                />
                <span>до</span>
                <input
                  type="time"
                  aria-label="Тихие часы до"
                  className="rounded-xl border border-separator bg-surface px-2 py-2"
                  value={quiet.end}
                  onChange={(e) => {
                    setDone(false)
                    setQuiet({ ...quiet, end: e.target.value })
                  }}
                />
              </div>
            )}
            {quiet.on && (
              <p className="mt-1 text-sm text-hint">
                В это время бот не пишет; сообщения придут, когда оно закончится.
              </p>
            )}
            {quietProblem && <p className="text-sm text-danger">{quietProblem}</p>}
          </div>

          <div>
            <h3 className="font-medium">Для всех дел</h3>
            <p className="text-sm text-hint">
              Категория, дело или одно из дел серии могут задать свои напоминания.
            </p>
            <div className="mt-2">
              <RulesEditor
                scope="global"
                drafts={drafts}
                errors={ruleErrors}
                onChange={(next) => {
                  setDone(false)
                  setDrafts(next)
                }}
              />
            </div>
          </div>
        </fieldset>
      </div>

      {error && (
        <p role="alert" className="text-danger">
          {error}
        </p>
      )}
      <button
        type="button"
        disabled={!canSave}
        onClick={() => void submit()}
        className="w-full rounded-xl bg-accent px-4 py-3 text-accent-fg disabled:opacity-50"
      >
        Сохранить напоминания
      </button>
      {done && (
        <p role="status" className="text-sm text-hint">
          Сохранено
        </p>
      )}
    </div>
  )
}
