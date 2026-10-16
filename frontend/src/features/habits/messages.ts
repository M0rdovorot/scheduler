import { ApiError } from '@/api/errors'

/** A user-facing (Russian) explanation of a failed habit request. */
export function habitErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'habit_weekly_in_grid')
      return 'Привычку с целью «раз в неделю» нельзя поставить в календарь. Если она уже там, сначала уберите её из календаря'
    if (error.code === 'habit_archived') return 'Привычку из архива нельзя поставить в календарь'
    if (error.status === 404) return 'Привычка не найдена. Возможно, она уже удалена'
    switch (error.field) {
      case 'title':
        return 'Название: от 1 до 200 символов'
      case 'color':
        return 'Цвет должен быть в формате #rrggbb'
      case 'target_value':
        return 'Цель — целое число от 1 до 100000'
      case 'unit':
        return 'Единица измерения не длиннее 30 символов'
      case 'frequency':
        return 'Расписание неполное: выберите дни недели или число раз в неделю'
      case 'time':
        return 'Время — в формате 07:30'
      case 'duration_minutes':
        return 'Длительность — от 1 до 1440 минут'
      case 'date':
        return 'Нельзя отметить день, который ещё не наступил'
      case 'value':
        return 'Значение должно быть целым числом от 0; для «да/нет» — 0 или 1'
    }
  }
  return 'Не удалось выполнить действие. Попробуйте ещё раз'
}
