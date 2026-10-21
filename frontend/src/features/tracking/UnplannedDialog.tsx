import { useState } from 'react'
import { useCreateUnplanned } from '@/api/instances'
import type { Category } from '@/api/types'
import { Dialog } from '@/components/Dialog'
import { CategoryPicker } from '@/features/categories/CategoryPicker'
import { taskErrorMessage } from '@/features/calendar/messages'
import { usePlatform } from '@/platform/context'
import {
  defaultUnplanned,
  toUnplannedRequest,
  validateUnplanned,
  type UnplannedDraft,
  type UnplannedMode,
} from './unplanned'

interface UnplannedDialogProps {
  categories: readonly Category[]
  tz: string
  now: Date
  /** The draft to start from, e.g. the times selected in the grid. */
  initial?: UnplannedDraft
  onDone: () => void
  onCancel: () => void
}

const fieldClass = 'mt-1 w-full rounded-xl border border-separator bg-surface px-3 py-2'

/** A task that was never planned: start a timer, or add it back-dated with its fact (FR-5.7). */
export function UnplannedDialog({
  categories,
  tz,
  now,
  initial,
  onDone,
  onCancel,
}: UnplannedDialogProps) {
  const platform = usePlatform()
  const create = useCreateUnplanned()
  const [draft, setDraft] = useState<UnplannedDraft>(() => initial ?? defaultUnplanned(now, tz))
  const [error, setError] = useState<string | null>(null)

  const errors = validateUnplanned(draft, tz)
  const canSave = Object.keys(errors).length === 0 && !create.isPending

  async function save() {
    setError(null)
    try {
      await create.mutateAsync(toUnplannedRequest(draft, tz))
      platform.haptic.notify('success')
      onDone()
    } catch (e) {
      platform.haptic.notify('error')
      setError(taskErrorMessage(e))
    }
  }

  return (
    <Dialog title="Дело вне плана" onClose={onCancel}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault()
          if (canSave) void save()
        }}
      >
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

        <p className="text-sm text-hint">
          Дело, которого не было в плане: оно сразу попадёт в факт и в статистику.
        </p>

        <div role="radiogroup" aria-label="Как добавить" className="space-y-1">
          {(
            [
              ['timer', 'Запустить таймер сейчас'],
              ['past', 'Добавить задним числом'],
            ] as [UnplannedMode, string][]
          ).map(([mode, label]) => (
            <label key={mode} className="flex items-center gap-2">
              <input
                type="radio"
                name="unplanned-mode"
                checked={draft.mode === mode}
                onChange={() => setDraft({ ...draft, mode })}
              />
              {label}
            </label>
          ))}
        </div>

        {draft.mode === 'past' && (
          <>
            <label className="block">
              <span>Началось</span>
              <input
                type="datetime-local"
                className={fieldClass}
                value={draft.start}
                onChange={(e) => setDraft({ ...draft, start: e.target.value })}
              />
            </label>
            {errors.start && <p className="text-sm text-danger">{errors.start}</p>}
            <label className="block">
              <span>Закончилось</span>
              <input
                type="datetime-local"
                className={fieldClass}
                value={draft.end}
                onChange={(e) => setDraft({ ...draft, end: e.target.value })}
              />
            </label>
            {errors.end && <p className="text-sm text-danger">{errors.end}</p>}
          </>
        )}

        <fieldset>
          <legend>Категории</legend>
          <div className="mt-1 max-h-40 overflow-y-auto rounded-xl border border-separator bg-surface px-3 py-1">
            <CategoryPicker
              categories={categories}
              value={draft.categoryIds}
              onChange={(categoryIds) => setDraft({ ...draft, categoryIds })}
            />
          </div>
        </fieldset>

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
          {draft.mode === 'timer' ? 'Запустить' : 'Добавить'}
        </button>
      </form>
    </Dialog>
  )
}
