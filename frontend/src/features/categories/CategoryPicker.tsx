import { useMemo, useId } from 'react'
import type { Category } from '@/api/types'
import { buildTree, flattenTree } from './tree'

interface CategoryPickerProps {
  categories: readonly Category[]
  value: readonly string[]
  onChange: (ids: string[]) => void
  label?: string
}

/**
 * Multi-select of categories shown as a tree (FR-2.7, FR-2.3: a task has any
 * number of categories). Archived categories are hidden unless already selected,
 * so that an old task keeps showing what it was filed under.
 */
export function CategoryPicker({
  categories,
  value,
  onChange,
  label = 'Категории',
}: CategoryPickerProps) {
  const groupId = useId()
  // Build the tree from the visible categories only: a selected archived child
  // whose archived parent is hidden then sits at the top level instead of
  // hanging, indented, under an unrelated row.
  const rows = useMemo(
    () =>
      flattenTree(
        buildTree(categories.filter((c) => c.archived_at === null || value.includes(c.id))),
      ),
    [categories, value],
  )

  function toggle(id: string, checked: boolean) {
    onChange(checked ? [...value, id] : value.filter((v) => v !== id))
  }

  if (rows.length === 0) {
    return <p className="text-hint">Категорий пока нет</p>
  }

  return (
    <div role="group" aria-labelledby={groupId}>
      <span id={groupId} className="sr-only">
        {label}
      </span>
      <ul>
        {rows.map(({ category, depth }) => (
          <li key={category.id} style={{ paddingLeft: depth * 20 }}>
            <label className="flex items-center gap-2 py-1.5">
              <input
                type="checkbox"
                checked={value.includes(category.id)}
                onChange={(e) => toggle(category.id, e.target.checked)}
              />
              <span
                aria-hidden="true"
                className="size-3 shrink-0 rounded-full"
                style={{ backgroundColor: category.color }}
              />
              <span className={category.archived_at ? 'text-hint' : ''}>
                {category.name}
                {category.archived_at && ' (в архиве)'}
              </span>
            </label>
          </li>
        ))}
      </ul>
    </div>
  )
}
