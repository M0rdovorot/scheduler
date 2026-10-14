import { useEffect, useState, type FormEvent } from 'react'
import {
  useArchiveCategory,
  useCreateCategory,
  useDeleteCategory,
  useMoveCategory,
  useUnarchiveCategory,
  useUpdateCategory,
} from '@/api/categories'
import type { Category } from '@/api/types'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { Dialog } from '@/components/Dialog'
import { usePlatform } from '@/platform/context'
import { ColorPicker } from './ColorPicker'
import {
  diffDraft,
  draftFromCategory,
  hasChanges,
  maxNameLength,
  validateDraft,
  type CategoryDraft,
} from './form'
import { categoryErrorMessage } from './messages'
import { defaultColor } from './palette'
import { countDescendants, findNode, parentOptions, type CategoryNode } from './tree'

export type FormTarget = { mode: 'create'; parentId: string | null } | { mode: 'edit'; id: string }

interface CategoryFormProps {
  target: FormTarget
  forest: readonly CategoryNode[]
  onClose: () => void
}

const fieldClass = 'mt-1 w-full rounded-xl border border-separator bg-surface px-3 py-2'

/**
 * Create/edit dialog. An edited category is looked up in the live list by id, so
 * background refreshes (and changes from another device) are never shown stale.
 */
export function CategoryForm({ target, forest, onClose }: CategoryFormProps) {
  const editing = target.mode === 'edit' ? findNode(forest, target.id)?.category : undefined
  const gone = target.mode === 'edit' && !editing

  // The category was deleted elsewhere: nothing left to edit.
  useEffect(() => {
    if (gone) onClose()
  }, [gone, onClose])

  if (gone) return null
  return (
    <CategoryFormBody
      initialParentId={target.mode === 'create' ? target.parentId : null}
      editing={editing}
      forest={forest}
      onClose={onClose}
    />
  )
}

interface CategoryFormBodyProps {
  initialParentId: string | null
  editing: Category | undefined
  forest: readonly CategoryNode[]
  onClose: () => void
}

function CategoryFormBody({ initialParentId, editing, forest, onClose }: CategoryFormBodyProps) {
  const platform = usePlatform()
  const create = useCreateCategory()
  const update = useUpdateCategory()
  const move = useMoveCategory()
  const archive = useArchiveCategory()
  const unarchive = useUnarchiveCategory()
  const remove = useDeleteCategory()

  const [draft, setDraft] = useState<CategoryDraft>(() =>
    editing
      ? draftFromCategory(editing)
      : { name: '', color: defaultColor, parentId: initialParentId ?? '' },
  )
  const [error, setError] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  const errors = validateDraft(draft)
  const changes = editing ? diffDraft(editing, draft) : null
  const busy = [create, update, move, archive, unarchive, remove].some((m) => m.isPending)
  const canSave =
    Object.keys(errors).length === 0 && !busy && (changes === null || hasChanges(changes))

  const options = parentOptions(forest, editing?.id ?? null)
  // An archived category keeps its (archived) parent; show it instead of a blank select.
  const currentParent = editing?.parent_id
  const extraParent =
    currentParent && !options.some((o) => o.category.id === currentParent)
      ? findNode(forest, currentParent)?.category
      : undefined

  const node = editing ? findNode(forest, editing.id) : undefined
  const descendants = node ? countDescendants(node) : 0

  async function run(
    action: () => Promise<unknown>,
    setFailure: (message: string | null) => void = setError,
  ) {
    setFailure(null)
    try {
      await action()
      platform.haptic.notify('success')
      onClose()
    } catch (e) {
      platform.haptic.notify('error')
      setFailure(categoryErrorMessage(e))
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!canSave) return
    void run(async () => {
      if (!editing || !changes) {
        await create.mutateAsync({
          name: draft.name.trim(),
          color: draft.color.toLowerCase(),
          parent_id: draft.parentId || null,
        })
        return
      }
      // The move goes first: it is the step the server can still refuse (cycle,
      // archived parent); name and color were already checked, so a half-applied
      // save is unlikely.
      if (changes.move) {
        await move.mutateAsync({ id: editing.id, parentId: changes.move.parentId })
      }
      if (Object.keys(changes.update).length > 0) {
        await update.mutateAsync({ id: editing.id, ...changes.update })
      }
    })
  }

  return (
    <>
      <Dialog title={editing ? 'Категория' : 'Новая категория'} onClose={onClose}>
        <form onSubmit={onSubmit} className="space-y-4">
          <label className="block">
            <span>Название</span>
            <input
              className={fieldClass}
              value={draft.name}
              maxLength={maxNameLength * 4}
              autoFocus
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              aria-invalid={errors.name !== undefined && draft.name !== ''}
            />
          </label>

          <div>
            <span>Цвет</span>
            <div className="mt-1">
              <ColorPicker
                value={draft.color}
                onChange={(color) => setDraft({ ...draft, color })}
              />
            </div>
          </div>

          <label className="block">
            <span>Родительская категория</span>
            <select
              className={fieldClass}
              value={draft.parentId}
              onChange={(e) => setDraft({ ...draft, parentId: e.target.value })}
            >
              <option value="">Без родителя (верхний уровень)</option>
              {extraParent && <option value={extraParent.id}>{extraParent.name} (в архиве)</option>}
              {options.map(({ category, depth }) => (
                <option key={category.id} value={category.id}>
                  {'  '.repeat(depth)}
                  {category.name}
                </option>
              ))}
            </select>
          </label>

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
          <div className="mt-4 flex gap-2 border-t border-separator pt-4">
            {editing.archived_at ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => void run(() => unarchive.mutateAsync(editing.id))}
                className="flex-1 rounded-xl bg-surface px-4 py-3 disabled:opacity-50"
              >
                Вернуть из архива
              </button>
            ) : (
              <button
                type="button"
                disabled={busy}
                onClick={() => void run(() => archive.mutateAsync(editing.id))}
                className="flex-1 rounded-xl bg-surface px-4 py-3 disabled:opacity-50"
              >
                В архив
              </button>
            )}
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setError(null)
                setConfirmingDelete(true)
              }}
              className="flex-1 rounded-xl bg-surface px-4 py-3 text-danger disabled:opacity-50"
            >
              Удалить
            </button>
          </div>
        )}
        {editing && !editing.archived_at && descendants > 0 && (
          <p className="mt-2 text-sm text-hint">Подкатегории ({descendants}) тоже уйдут в архив.</p>
        )}
      </Dialog>

      {editing && confirmingDelete && (
        <ConfirmDialog
          title="Удалить категорию?"
          confirmLabel="Удалить"
          pending={remove.isPending}
          error={deleteError}
          onCancel={() => {
            setConfirmingDelete(false)
            setDeleteError(null)
          }}
          onConfirm={() => void run(() => remove.mutateAsync(editing.id), setDeleteError)}
        >
          <p>Категория «{editing.name}» будет удалена и снята со всех дел. Сами дела останутся.</p>
          {descendants > 0 && (
            <p className="mt-2">Подкатегории ({descendants}) тоже будут удалены.</p>
          )}
        </ConfirmDialog>
      )}
    </>
  )
}
