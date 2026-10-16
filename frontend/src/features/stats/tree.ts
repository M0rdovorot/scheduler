import type { Category } from '@/api/types'

export interface StatsRow {
  category: Category
  depth: number
  /** The time of the category including all its subcategories. */
  minutes: number
}

const collator = new Intl.Collator('ru', { sensitivity: 'base', numeric: true })

/**
 * The category tree with hours (FR-8.2, "shown as a tree"): only categories that have
 * time, siblings from the largest to the smallest. The time of a category already
 * includes its subcategories (a task counts once in each category of its categories and
 * their ancestors), so a row is never smaller than any of its children.
 */
export function statsRows(
  categories: readonly Category[],
  minutesById: ReadonlyMap<string, number>,
): StatsRow[] {
  const children = new Map<string | null, Category[]>()
  const known = new Set(categories.map((c) => c.id))
  for (const category of categories) {
    if ((minutesById.get(category.id) ?? 0) <= 0) continue
    // A parent that is missing from the list must not make the category vanish.
    const parent = category.parent_id && known.has(category.parent_id) ? category.parent_id : null
    const list = children.get(parent) ?? []
    list.push(category)
    children.set(parent, list)
  }

  const rows: StatsRow[] = []
  const visit = (parent: string | null, depth: number) => {
    const list = (children.get(parent) ?? []).sort(
      (a, b) =>
        (minutesById.get(b.id) ?? 0) - (minutesById.get(a.id) ?? 0) ||
        collator.compare(a.name, b.name),
    )
    for (const category of list) {
      rows.push({ category, depth, minutes: minutesById.get(category.id) ?? 0 })
      visit(category.id, depth + 1)
    }
  }
  visit(null, 0)
  return rows
}
