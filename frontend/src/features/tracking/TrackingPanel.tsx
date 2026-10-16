import { useState } from 'react'
import {
  useCompleteInstance,
  useStartInstance,
  useStopInstance,
  useUpdateTracking,
} from '@/api/instances'
import type { Instance } from '@/api/types'
import type { Day } from '@/features/calendar/dates'
import { formatTime, formatTimeRange, toLocalInput } from '@/features/calendar/localTime'
import { taskErrorMessage } from '@/features/calendar/messages'
import { usePlatform } from '@/platform/context'
import {
  actionsFor,
  deviationText,
  factInterval,
  isUnmarked,
  planInterval,
  statusLabels,
  statusMarks,
} from './fact'
import {
  buildTrackingPatch,
  commentError,
  draftFromInstance,
  validateFactDraft,
  type FactDraft,
  type FactStatus,
} from './factDraft'

interface TrackingPanelProps {
  instance: Instance
  tz: string
  now: Date
  /** Closes the card after an action that changed the task. */
  onClose: () => void
  onReschedule: () => void
  /** Jumps to a day, for the links of a reschedule. */
  onGoToDay: (day: Day) => void
}

const fieldClass = 'mt-1 w-full rounded-xl border border-separator bg-bg px-3 py-2'
const button = 'rounded-xl px-3 py-2 text-sm disabled:opacity-50'

const factStatuses: readonly { value: FactStatus; label: string }[] = [
  { value: 'done', label: 'Выполнено' },
  { value: 'partial', label: 'Частично' },
  { value: 'not_done', label: 'Не выполнено' },
  { value: 'in_progress', label: 'В процессе' },
]

/** Status, plan and fact, deviations, the comment and the tracking actions of a task. */
export function TrackingPanel({
  instance,
  tz,
  now,
  onClose,
  onReschedule,
  onGoToDay,
}: TrackingPanelProps) {
  const platform = usePlatform()
  const complete = useCompleteInstance()
  const start = useStartInstance()
  const stop = useStopInstance()
  const update = useUpdateTracking()

  const [error, setError] = useState<string | null>(null)
  const [editingFact, setEditingFact] = useState(false)
  const [factDraft, setFactDraft] = useState<FactDraft>(() => draftFromInstance(instance, tz, now))
  const [comment, setComment] = useState(instance.comment)

  const actions = actionsFor(instance)
  const plan = planInterval(instance)
  const fact = factInterval(instance, now)
  const busy = complete.isPending || start.isPending || stop.isPending || update.isPending

  async function run(action: () => Promise<unknown>, closeAfter = true) {
    setError(null)
    try {
      await action()
      platform.haptic.notify('success')
      if (closeAfter) onClose()
    } catch (e) {
      platform.haptic.notify('error')
      setError(taskErrorMessage(e))
    }
  }

  const factErrors = validateFactDraft(factDraft, tz)
  const factPatch = buildTrackingPatch(instance, factDraft, tz)
  const canSaveFact =
    Object.keys(factErrors).length === 0 && Object.keys(factPatch).length > 0 && !busy

  const commentProblem = commentError(comment)
  const canSaveComment = comment !== instance.comment && commentProblem === null && !busy

  const dayOf = (iso: string) => toLocalInput(new Date(iso), tz).slice(0, 10)
  const link = (label: string, target: NonNullable<Instance['rescheduled_to']>) => (
    <p className="text-sm">
      {label} {formatTimeRange(new Date(target.planned_start), new Date(target.planned_end), tz)}{' '}
      <button
        type="button"
        className="text-link"
        onClick={() => onGoToDay(dayOf(target.planned_start))}
      >
        Перейти
      </button>
    </p>
  )

  return (
    <section aria-label="Отслеживание" className="mb-4 space-y-3 rounded-xl bg-surface p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium" data-testid="status">
          {statusMarks[instance.status] && (
            <span aria-hidden="true">{statusMarks[instance.status]} </span>
          )}
          {statusLabels[instance.status]}
        </span>
        {plan === null && <span className="text-xs text-hint">вне плана</span>}
        {isUnmarked(instance, now) && <span className="text-xs text-hint">не отмечено</span>}
      </div>

      <dl className="space-y-0.5 text-sm">
        {plan && (
          <div className="flex gap-2">
            <dt className="w-14 text-hint">План</dt>
            <dd>{formatTimeRange(plan.start, plan.end, tz)}</dd>
          </div>
        )}
        <div className="flex gap-2">
          <dt className="w-14 text-hint">Факт</dt>
          <dd data-testid="fact">
            {!fact
              ? '—'
              : instance.actual_end
                ? formatTimeRange(fact.start, fact.end, tz)
                : `с ${formatTime(fact.start, tz)}, идёт`}
          </dd>
        </div>
      </dl>

      {instance.deviations.length > 0 && (
        <ul className="space-y-0.5 text-sm" aria-label="Отклонения">
          {instance.deviations.map((d) => (
            <li key={d.kind}>{deviationText(d)}</li>
          ))}
        </ul>
      )}

      {instance.rescheduled_to && link('Перенесено на', instance.rescheduled_to)}
      {instance.rescheduled_from && link('Перенесено с', instance.rescheduled_from)}

      {(actions.complete ||
        actions.start ||
        actions.stop ||
        actions.reschedule ||
        actions.removeMark) && (
        <div className="flex flex-wrap gap-2">
          {actions.complete && (
            <button
              type="button"
              disabled={busy}
              className={`${button} bg-accent text-accent-fg`}
              onClick={() => void run(() => complete.mutateAsync(instance.id))}
            >
              Выполнено
            </button>
          )}
          {actions.start && (
            <button
              type="button"
              disabled={busy}
              className={`${button} bg-bg`}
              onClick={() => void run(() => start.mutateAsync(instance.id))}
            >
              Старт
            </button>
          )}
          {actions.stop && (
            <button
              type="button"
              disabled={busy}
              className={`${button} bg-accent text-accent-fg`}
              onClick={() => void run(() => stop.mutateAsync(instance.id))}
            >
              Стоп
            </button>
          )}
          {actions.reschedule && (
            <button
              type="button"
              disabled={busy}
              className={`${button} bg-bg`}
              onClick={onReschedule}
            >
              Перенести
            </button>
          )}
          {actions.removeMark && (
            <button
              type="button"
              disabled={busy}
              className={`${button} bg-bg`}
              onClick={() =>
                void run(() => update.mutateAsync({ id: instance.id, status: 'planned' }))
              }
            >
              Снять отметку
            </button>
          )}
        </div>
      )}

      {actions.editFact && (
        <div>
          <button
            type="button"
            className="text-sm text-link"
            aria-expanded={editingFact}
            onClick={() => setEditingFact(!editingFact)}
          >
            {editingFact ? 'Скрыть правку факта' : 'Править факт'}
          </button>

          {editingFact && (
            <form
              className="mt-2 space-y-3"
              onSubmit={(e) => {
                e.preventDefault()
                if (canSaveFact)
                  void run(() => update.mutateAsync({ id: instance.id, ...factPatch }), false)
              }}
            >
              <label className="block text-sm">
                <span>Статус</span>
                <select
                  className={fieldClass}
                  value={factDraft.status}
                  onChange={(e) =>
                    setFactDraft({ ...factDraft, status: e.target.value as FactStatus })
                  }
                >
                  {factStatuses.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>

              {factDraft.status !== 'not_done' && (
                <>
                  <label className="block text-sm">
                    <span>Начало факта</span>
                    <input
                      type="datetime-local"
                      className={fieldClass}
                      value={factDraft.start}
                      onChange={(e) => setFactDraft({ ...factDraft, start: e.target.value })}
                    />
                  </label>
                  {factErrors.start && <p className="text-sm text-danger">{factErrors.start}</p>}
                  {factDraft.status !== 'in_progress' && (
                    <>
                      <label className="block text-sm">
                        <span>Конец факта</span>
                        <input
                          type="datetime-local"
                          className={fieldClass}
                          value={factDraft.end}
                          onChange={(e) => setFactDraft({ ...factDraft, end: e.target.value })}
                        />
                      </label>
                      {factErrors.end && <p className="text-sm text-danger">{factErrors.end}</p>}
                    </>
                  )}
                </>
              )}
              <button
                type="submit"
                disabled={!canSaveFact}
                className={`${button} bg-accent text-accent-fg`}
              >
                Сохранить факт
              </button>
            </form>
          )}
        </div>
      )}

      {actions.editFact && (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (canSaveComment)
              void run(() => update.mutateAsync({ id: instance.id, comment }), false)
          }}
        >
          <label className="block text-sm">
            <span>Комментарий: почему всё пошло не по плану</span>
            <textarea
              className={fieldClass}
              rows={2}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
            />
          </label>
          {commentProblem && <p className="text-sm text-danger">{commentProblem}</p>}
          <button type="submit" disabled={!canSaveComment} className={`${button} bg-bg`}>
            Сохранить комментарий
          </button>
        </form>
      )}

      {!actions.editFact && instance.comment && (
        <p className="text-sm">
          <span className="text-hint">Комментарий: </span>
          {instance.comment}
        </p>
      )}

      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </section>
  )
}
