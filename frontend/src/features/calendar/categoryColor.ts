import type { Category, Instance } from '@/api/types'

const collator = new Intl.Collator('ru', { sensitivity: 'base', numeric: true })

/** Color for tasks with no category. */
export const noCategoryColor = '#78716c'

/**
 * The category whose color a task shows: the first by name among its
 * categories, so that the choice is stable. Unknown ids are ignored.
 */
export function primaryCategory(
  categoryIds: readonly string[],
  byId: ReadonlyMap<string, Category>,
): Category | undefined {
  return categoryIds
    .map((id) => byId.get(id))
    .filter((c): c is Category => c !== undefined)
    .sort((a, b) => collator.compare(a.name, b.name) || a.id.localeCompare(b.id))[0]
}

/**
 * The color of a task block: its first category by name; an occurrence of a habit with no
 * category takes the color of the habit; anything else is neutral.
 */
export function instanceColor(
  instance: Pick<Instance, 'category_ids' | 'habit_id'>,
  categoriesById: ReadonlyMap<string, Category>,
  habitColors: ReadonlyMap<string, string>,
): string {
  const category = primaryCategory(instance.category_ids, categoriesById)
  if (category) return category.color
  return (instance.habit_id && habitColors.get(instance.habit_id)) || noCategoryColor
}
