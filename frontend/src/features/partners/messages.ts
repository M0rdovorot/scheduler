import { ApiError } from '@/api/errors'

/** A user-facing (Russian) explanation of a failed partner request. */
export function partnerErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'invite_invalid':
        return 'Приглашение недействительно: оно просрочено или уже использовано. Попросите новую ссылку'
      case 'own_invite':
        return 'Это ваше приглашение. Отправьте ссылку другому человеку'
      case 'already_partners':
        return 'Вы уже партнёры'
    }
    if (error.status === 404) return 'Партнёр не найден. Возможно, связь уже разорвана'
    if (error.field === 'to') return 'Период указан неверно: не больше 100 дней'
  }
  return 'Не удалось выполнить действие. Попробуйте ещё раз'
}
