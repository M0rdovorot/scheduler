import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { useCreateTask, useDeleteInstance, useSeries, useUpdateInstance } from '@/api/instances'
import type { Category, Instance, Scope, Series } from '@/api/types'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { Dialog } from '@/components/Dialog'
import { CategoryPicker } from '@/features/categories/CategoryPicker'
import { RepeatEditor } from '@/features/recurrence/RepeatEditor'
import { describeRepeat, fromRRule } from '@/features/recurrence/repeat'
import { ScopeDialog, type ScopeOption } from '@/features/recurrence/ScopeDialog'
import { statusLabels } from '@/features/tracking/fact'
import { RescheduleDialog } from '@/features/tracking/RescheduleDialog'
import { TrackingPanel } from '@/features/tracking/TrackingPanel'
import { usePlatform } from '@/platform/context'
import type { Day } from './dates'
import { formatTimeRange, fromLocalInput, toLocalInput } from './localTime'
import { taskErrorMessage } from './messages'
import {
  dayOf,
  draftFromInstance,
  toCreateRequest,
  toUpdateRequest,
  validateTaskDraft,
  type TaskDraft,
} from './taskDraft'

export type TaskFormTarget =
  /** `compact` is the short form for a selection in the grid (FR-3.2). */
  { mode: 'create'; draft: TaskDraft; compact: boolean } | { mode: 'edit'; id: string }

interface TaskFormProps {
  target: TaskFormTarget
  /** Tasks currently loaded; an edited task is looked up here by id. */
  instances: readonly Instance[]
  categories: readonly Category[]
  tz: string
  /** The current time, for "not marked" and for a running timer. */
  now: Date
  /** Jumps to a day (the links between a task and its reschedule). */
  onGoToDay: (day: Day) => void
  onClose: () => void
}

const fieldClass = 'mt-1 w-full rounded-xl border border-separator bg-surface px-3 py-2'

/**
 * Create/edit dialog. An edited task is read from the live list, so a background
 * refresh is never shown stale, and the dialog closes if the task disappears (for
 * an occurrence of a series that also happens after the series is rewritten, when
 * its occurrences are created again with new ids).
 */
export function TaskForm({
  target,
  instances,
  categories,
  tz,
  now,
  onGoToDay,
  onClose,
}: TaskFormProps) {
  const editing = target.mode === 'edit' ? instances.find((i) => i.id === target.id) : undefined
  const gone = target.mode === 'edit' && !editing
  const series = useSeries(editing?.series_id ?? null)

  useEffect(() => {
    if (gone) onClose()
  }, [gone, onClose])

  if (gone) return null

  if (editing?.series_id && !series.data) {
    return (
      <Dialog title="Дело" onClose={onClose}>
        {series.isError ? (
          <p role="alert" className="text-danger">
            Не удалось загрузить данные серии
          </p>
        ) : (
          <p className="text-hint">Загрузка…</p>
        )}
      </Dialog>
    )
  }

  return (
    <TaskFormBody
      editing={editing}
      series={series.data}
      initialDraft={target.mode === 'create' ? target.draft : undefined}
      startCompact={target.mode === 'create' && target.compact}
      categories={categories}
      tz={tz}
      now={now}
      onGoToDay={onGoToDay}
      onClose={onClose}
    />
  )
}

interface TaskFormBodyProps {
  editing: Instance | undefined
  series: Series | undefined
  initialDraft: TaskDraft | undefined
  startCompact: boolean
  categories: readonly Category[]
  tz: string
  now: Date
  onGoToDay: (day: Day) => void
  onClose: () => void
}

function TaskFormBody({
  editing,
  series,
  initialDraft,
  startCompact,
  categories,
  tz,
  now,
  onGoToDay,
  onClose,
}: TaskFormBodyProps) {
  const platform = usePlatform()
  const create = useCreateTask()
  const update = useUpdateInstance()
  const remove = useDeleteInstance()

  // The saved rule of the series, in editor form; null if it has a shape the editor cannot show.
  const savedRepeat = useMemo(
    () => (series ? fromRRule(series.rrule, dayOf(series.start_local), tz) : null),
    [series, tz],
  )
  const ruleUnsupported = series !== undefined && savedRepeat === null

  const [draft, setDraft] = useState<TaskDraft>(() =>
    editing ? draftFromInstance(editing, tz, savedRepeat) : (initialDraft as TaskDraft),
  )
  const [compact, setCompact] = useState(startCompact)
  const [error, setError] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [dialog, setDialog] = useState<'save-scope' | 'delete' | 'reschedule' | null>(null)

  const inSeries = editing?.series_id != null
  // A task outside the plan has a title, description and categories, but no planned time.
  const unplanned = editing !== undefined && editing.planned_start === null
  const errors = validateTaskDraft(draft, tz, !unplanned)
  const patch = editing ? toUpdateRequest(editing, draft, tz, savedRepeat) : null
  const busy = create.isPending || update.isPending || remove.isPending
  // A new rule needs the series and a new date needs this occurrence alone: both at once fit nothing.
  const ruleChanged = patch?.recurrence !== undefined
  const dateChanged =
    editing?.planned_start != null
      ? dayOf(draft.start) !== dayOf(toLocalInput(new Date(editing.planned_start), tz))
      : false
  const conflict = inSeries && ruleChanged && dateChanged
  const canSave =
    Object.keys(errors).length === 0 &&
    !busy &&
    !conflict &&
    (patch === null || Object.keys(patch).length > 0)

  async function run(action: () => Promise<unknown>, fail: (message: string | null) => void) {
    fail(null)
    try {
      await action()
      platform.haptic.notify('success')
      onClose()
    } catch (e) {
      platform.haptic.notify('error')
      fail(taskErrorMessage(e))
    }
  }

  function save(scope: Scope) {
    if (!editing || !patch) return
    // The rule belongs to the series, never to one occurrence.
    const body = scope === 'this' ? { ...patch, recurrence: undefined } : patch
    void run(() => update.mutateAsync({ id: editing.id, scope, ...body }), setError)
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!canSave) return
    if (!editing) {
      void run(() => create.mutateAsync(toCreateRequest(draft, tz)), setError)
    } else if (inSeries) {
      setError(null)
      setDialog('save-scope')
    } else {
      save('this')
    }
  }

  const start = fromLocalInput(draft.start, tz)
  const end = fromLocalInput(draft.end, tz)

  const saveOptions: ScopeOption[] = [
    {
      scope: 'this',
      label: 'Только это дело',
      disabledReason: ruleChanged ? 'Правило повтора меняется только для серии' : undefined,
    },
    {
      scope: 'following',
      label: 'Это и следующие',
      disabledReason: dateChanged ? 'Дату можно менять только у одного дела' : undefined,
    },
    {
      scope: 'all',
      label: 'Все дела серии',
      disabledReason: dateChanged ? 'Дату можно менять только у одного дела' : undefined,
    },
  ]
  const deleteOptions: ScopeOption[] = [
    { scope: 'this', label: 'Только это дело' },
    { scope: 'following', label: 'Это и следующие' },
    { scope: 'all', label: 'Все дела серии' },
  ]

  const showRepeat = !compact && (!editing || inSeries)

  // A task with a status other than planned carries a fact; deleting it drops the fact too.
  const marked = editing !== undefined && editing.status !== 'planned'
  const markedWarning = editing
    ? `Дело отмечено («${statusLabels[editing.status]}»). Оно будет удалено вместе с фактом и пропадёт из статистики.`
    : ''

  return (
    <>
      <Dialog title={editing ? 'Дело' : 'Новое дело'} onClose={onClose}>
        {editing && (
          <TrackingPanel
            instance={editing}
            tz={tz}
            now={now}
            onClose={onClose}
            onReschedule={() => setDialog('reschedule')}
            onGoToDay={(day) => {
              onGoToDay(day)
              onClose()
            }}
          />
        )}
        <form onSubmit={onSubmit} className="space-y-4">
          <div>
            <label className="block">
              <span>Название</span>
              <input
                className={fieldClass}
                value={draft.title}
                autoFocus
                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              />
            </label>
            {errors.title && (
              <span className={`block text-sm ${draft.title === '' ? 'text-hint' : 'text-danger'}`}>
                {errors.title}
              </span>
            )}
          </div>

          {compact ? (
            <div className="flex items-center justify-between gap-2">
              <span aria-label="Время">{start && end ? formatTimeRange(start, end, tz) : '—'}</span>
              <button type="button" className="text-link" onClick={() => setCompact(false)}>
                Подробнее
              </button>
            </div>
          ) : (
            <>
              <label className="block">
                <span>Описание</span>
                <textarea
                  className={fieldClass}
                  rows={3}
                  value={draft.description}
                  onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                />
                {errors.description && (
                  <span className="block text-sm text-danger">{errors.description}</span>
                )}
              </label>

              {!unplanned && (
                <>
                  <label className="block">
                    <span>Начало</span>
                    <input
                      type="datetime-local"
                      className={fieldClass}
                      value={draft.start}
                      onChange={(e) => setDraft({ ...draft, start: e.target.value })}
                    />
                    {errors.start && (
                      <span className="block text-sm text-danger">{errors.start}</span>
                    )}
                  </label>

                  <label className="block">
                    <span>Конец</span>
                    <input
                      type="datetime-local"
                      className={fieldClass}
                      value={draft.end}
                      onChange={(e) => setDraft({ ...draft, end: e.target.value })}
                    />
                    {errors.end && <span className="block text-sm text-danger">{errors.end}</span>}
                  </label>
                </>
              )}

              {showRepeat && !ruleUnsupported && (
                <RepeatEditor
                  value={draft.repeat}
                  startDay={dayOf(draft.start)}
                  onChange={(repeat) => setDraft({ ...draft, repeat })}
                />
              )}
              {inSeries && ruleUnsupported && series && (
                <p className="text-sm text-hint">Правило повтора: {series.rrule}</p>
              )}
              {inSeries && !ruleUnsupported && savedRepeat && !showRepeat && (
                <p className="text-sm text-hint">
                  {describeRepeat(savedRepeat, dayOf(draft.start))}
                </p>
              )}

              <fieldset>
                <legend>Категории</legend>
                <div className="mt-1 max-h-48 overflow-y-auto rounded-xl border border-separator bg-surface px-3 py-1">
                  <CategoryPicker
                    categories={categories}
                    value={draft.categoryIds}
                    onChange={(categoryIds) => setDraft({ ...draft, categoryIds })}
                  />
                </div>
              </fieldset>
            </>
          )}

          {conflict && (
            <p role="alert" className="text-sm text-danger">
              Нельзя менять дату и правило повтора одновременно: сохраните сначала одно, потом
              другое
            </p>
          )}

          {error && dialog === null && (
            <p role="alert" className="text-danger">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={!canSave}
            className="w-full rounded-xl bg-accent px-4 py-3 text-accent-fg disabled:opacity-50"
          >
            {editing ? 'Сохранить' : 'Создать'}
          </button>
        </form>

        {editing && (
          <div className="mt-4 border-t border-separator pt-4">
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setError(null)
                setDeleteError(null)
                setDialog('delete')
              }}
              className="w-full rounded-xl bg-surface px-4 py-3 text-danger disabled:opacity-50"
            >
              Удалить
            </button>
          </div>
        )}
      </Dialog>

      {dialog === 'save-scope' && (
        <ScopeDialog
          title="Применить изменения"
          options={saveOptions}
          pending={update.isPending}
          error={error}
          onChoose={save}
          onCancel={() => {
            setDialog(null)
            setError(null)
          }}
        />
      )}

      {editing && dialog === 'delete' && !inSeries && (
        <ConfirmDialog
          title="Удалить дело?"
          confirmLabel="Удалить"
          pending={remove.isPending}
          error={deleteError}
          onCancel={() => {
            setDialog(null)
            setDeleteError(null)
          }}
          onConfirm={() => void run(() => remove.mutateAsync({ id: editing.id }), setDeleteError)}
        >
          <p>Дело «{editing.title}» будет удалено.</p>
          {marked && (
            <p className="mt-2" data-testid="marked-warning">
              {markedWarning}
            </p>
          )}
        </ConfirmDialog>
      )}

      {editing && dialog === 'delete' && inSeries && (
        <ScopeDialog
          title="Удалить повторяющееся дело"
          options={deleteOptions}
          note={marked ? `${markedWarning} Это относится к выбранному делу.` : undefined}
          danger
          pending={remove.isPending}
          error={deleteError}
          onChoose={(scope) =>
            void run(() => remove.mutateAsync({ id: editing.id, scope }), setDeleteError)
          }
          onCancel={() => {
            setDialog(null)
            setDeleteError(null)
          }}
        />
      )}

      {editing && dialog === 'reschedule' && (
        <RescheduleDialog
          instance={editing}
          tz={tz}
          onDone={onClose}
          onCancel={() => setDialog(null)}
        />
      )}
    </>
  )
}
