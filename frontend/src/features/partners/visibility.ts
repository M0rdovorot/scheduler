import type { Visibility } from '@/api/types'

export const visibilityOptions: readonly { value: Visibility; label: string; hint: string }[] = [
  { value: 'private', label: 'Только я', hint: 'Партнёры видят, что время занято, но не название' },
  {
    value: 'granted',
    label: 'Разрешённые партнёры',
    hint: 'Название видят партнёры, которым вы открыли дела',
  },
  { value: 'partners', label: 'Все партнёры', hint: 'Название видят все ваши партнёры' },
]

export const visibilityLabels: Record<Visibility, string> = {
  private: 'Только я',
  granted: 'Разрешённые партнёры',
  partners: 'Все партнёры',
}
