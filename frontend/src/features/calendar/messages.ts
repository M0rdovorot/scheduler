import { ApiError } from '@/api/errors'

/** A user-facing (Russian) explanation of a failed task request. */
export function taskErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 404) return 'Дело не найдено. Возможно, оно уже удалено'
    switch (error.field) {
      case 'title':
        return 'Название: от 1 до 200 символов'
      case 'description':
        return 'Описание не длиннее 5000 символов'
      case 'planned_end':
        return 'Конец должен быть позже начала'
      case 'category_ids':
        return 'Одна из категорий не найдена. Обновите список и попробуйте снова'
    }
  }
  return 'Не удалось выполнить действие. Попробуйте ещё раз'
}
