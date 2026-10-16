import { ApiError } from '@/api/errors'

/** A user-facing (Russian) explanation of a failed task request. */
export function taskErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'series_date_change') {
      return 'Для всей серии нельзя менять дату. Выберите «Только это дело» или оставьте прежнюю дату'
    }
    if (error.code === 'instance_marked') {
      return 'Дело уже отмечено: его нельзя удалить из серии. Это можно будет сделать после этапа отслеживания'
    }
    if (error.code === 'no_occurrences') return 'По этому правилу нет ни одного повтора'
    if (error.field === 'recurrence') return 'Некорректное правило повтора'
    if (error.field === 'scope') return 'Эта правка не подходит для разового дела'
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
