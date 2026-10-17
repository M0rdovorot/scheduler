import { ApiError } from '@/api/errors'

/** A user-facing (Russian) explanation of a failed reminder request. */
export function reminderErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 404) return 'Не найдено. Возможно, это уже удалено'
    if (error.field === 'quiet_hours') return 'Тихие часы: время начала и конца должны различаться'
    if (error.field === 'rules') return 'Одно из напоминаний указано неверно или их больше 20'
  }
  return 'Не удалось сохранить. Попробуйте ещё раз'
}
