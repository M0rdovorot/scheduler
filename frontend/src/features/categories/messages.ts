import { ApiError } from '@/api/errors'

/** A user-facing (Russian) explanation of a failed category request. */
export function categoryErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'category_cycle':
        return 'Нельзя перенести категорию внутрь самой себя или своей подкатегории'
      case 'parent_archived':
        return 'Родительская категория в архиве'
    }
    if (error.status === 404) return 'Категория не найдена. Возможно, она уже удалена'
    if (error.field === 'name') return 'Название: от 1 до 100 символов'
    if (error.field === 'color') return 'Цвет должен быть в формате #rrggbb'
    if (error.field === 'parent_id') return 'Родительская категория не найдена'
  }
  return 'Не удалось выполнить действие. Попробуйте ещё раз'
}
