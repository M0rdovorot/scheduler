import type { Category } from '@/api/types'

export const maxNameLength = 100

export interface CategoryDraft {
  name: string
  color: string
  /** Empty string: top level. */
  parentId: string
}

export type DraftErrors = Partial<Record<'name' | 'color', string>>

export function draftFromCategory(category: Category): CategoryDraft {
  return { name: category.name, color: category.color, parentId: category.parent_id ?? '' }
}

export function isHexColor(value: string): boolean {
  return /^#[0-9a-f]{6}$/i.test(value)
}

export function validateDraft(draft: CategoryDraft): DraftErrors {
  const errors: DraftErrors = {}
  const length = [...draft.name.trim()].length
  if (length < 1 || length > maxNameLength) {
    errors.name = `Название: от 1 до ${maxNameLength} символов`
  }
  if (!isHexColor(draft.color)) errors.color = 'Цвет в формате #rrggbb'
  return errors
}

export interface CategoryChanges {
  /** Fields for PATCH /categories/{id}; empty when name and color are unchanged. */
  update: { name?: string; color?: string }
  /** Set when the parent changed: the new parent id, or null for the top level. */
  move?: { parentId: string | null }
}

/** What has to be sent to the server to turn `original` into `draft`. */
export function diffDraft(original: Category, draft: CategoryDraft): CategoryChanges {
  const update: CategoryChanges['update'] = {}
  const name = draft.name.trim()
  if (name !== original.name) update.name = name
  const color = draft.color.toLowerCase()
  if (color !== original.color) update.color = color

  const changes: CategoryChanges = { update }
  if (draft.parentId !== (original.parent_id ?? '')) {
    changes.move = { parentId: draft.parentId || null }
  }
  return changes
}

export function hasChanges(changes: CategoryChanges): boolean {
  return Object.keys(changes.update).length > 0 || changes.move !== undefined
}
