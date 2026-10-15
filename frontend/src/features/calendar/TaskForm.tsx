import { useEffect, useState, type FormEvent } from 'react'
import { useCreateTask, useDeleteInstance, useUpdateInstance } from '@/api/instances'
import type { Category, Instance } from '@/api/types'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { Dialog } from '@/components/Dialog'
import { usePlatform } from '@/platform/context'
import { CategoryPicker } from '@/features/categories/CategoryPicker'
import { fromLocalInput, formatTimeRange } from './localTime'
import { taskErrorMessage } from './messages'
import {
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
  onClose: () => void
}

const fieldClass = 'mt-1 w-full rounded-xl border border-separator bg-surface px-3 py-2'

/**
 * Create/edit dialog. An edited task is read from the live list, so a background
 * refresh is never shown stale, and the dialog closes if the task disappears.
 */
export function TaskForm({ target, instances, categories, tz, onClose }: TaskFormProps) {
  const editing = target.mode === 'edit' ? instances.find((i) => i.id === target.id) : undefined
  const gone = target.mode === 'edit' && !editing

  useEffect(() => {
    if (gone) onClose()
  }, [gone, onClose])

  if (gone) return null
  return (
    <TaskFormBody
      editing={editing}
      initialDraft={target.mode === 'create' ? target.draft : undefined}
      startCompact={target.mode === 'create' && target.compact}
      categories={categories}
      tz={tz}
      onClose={onClose}
    />
  )
}

interface TaskFormBodyProps {
  editing: Instance | undefined
  initialDraft: TaskDraft | undefined
  startCompact: boolean
  categories: readonly Category[]
  tz: string
  onClose: () => void
}

function TaskFormBody({
  editing,
  initialDraft,
  startCompact,
  categories,
  tz,
  onClose,
}: TaskFormBodyProps) {
  const platform = usePlatform()
  const create = useCreateTask()
  const update = useUpdateInstance()
  const remove = useDeleteInstance()

  const [draft, setDraft] = useState<TaskDraft>(() =>
    editing ? draftFromInstance(editing, tz) : (initialDraft as TaskDraft),
  )
  const [compact, setCompact] = useState(startCompact)
  const [error, setError] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  const errors = validateTaskDraft(draft, tz)
  const patch = editing ? toUpdateRequest(editing, draft, tz) : null
  const busy = create.isPending || update.isPending || remove.isPending
  const canSave =
    Object.keys(errors).length === 0 && !busy && (patch === null || Object.keys(patch).length > 0)

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

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!canSave) return
    void run(async () => {
      if (editing && patch) await update.mutateAsync({ id: editing.id, ...patch })
      else await create.mutateAsync(toCreateRequest(draft, tz))
    }, setError)
  }

  const start = fromLocalInput(draft.start, tz)
  const end = fromLocalInput(draft.end, tz)

  return (
    <>
      <Dialog title={editing ? 'Дело' : 'Новое дело'} onClose={onClose}>
        <form onSubmit={onSubmit} className="space-y-4">
          <label className="block">
            <span>Название</span>
            <input
              className={fieldClass}
              value={draft.title}
              autoFocus
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            />
          </label>

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

              <label className="block">
                <span>Начало</span>
                <input
                  type="datetime-local"
                  className={fieldClass}
                  value={draft.start}
                  onChange={(e) => setDraft({ ...draft, start: e.target.value })}
                />
                {errors.start && <span className="block text-sm text-danger">{errors.start}</span>}
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

          {error && (
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
                setConfirmingDelete(true)
              }}
              className="w-full rounded-xl bg-surface px-4 py-3 text-danger disabled:opacity-50"
            >
              Удалить
            </button>
          </div>
        )}
      </Dialog>

      {editing && confirmingDelete && (
        <ConfirmDialog
          title="Удалить дело?"
          confirmLabel="Удалить"
          pending={remove.isPending}
          error={deleteError}
          onCancel={() => {
            setConfirmingDelete(false)
            setDeleteError(null)
          }}
          onConfirm={() => void run(() => remove.mutateAsync(editing.id), setDeleteError)}
        >
          <p>Дело «{editing.title}» будет удалено.</p>
        </ConfirmDialog>
      )}
    </>
  )
}
