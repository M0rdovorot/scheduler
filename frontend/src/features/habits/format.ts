import type { Habit, HabitStreaks } from '@/api/types'

/** Russian plural form: plural(1, ['день','дня','дней']) = 'день'. */
export function plural(n: number, forms: readonly [string, string, string]): string {
  const abs = Math.abs(n) % 100
  const last = abs % 10
  if (abs > 10 && abs < 20) return forms[2]
  if (last === 1) return forms[0]
  if (last >= 2 && last <= 4) return forms[1]
  return forms[2]
}

/** ISO weekdays 1..7 as short names. */
export const weekdayNames = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'] as const

/** "Каждый день", "Пн, Ср, Пт", "3 раза в неделю". */
export function frequencyLabel(
  habit: Pick<Habit, 'frequency' | 'weekdays' | 'times_per_week'>,
): string {
  switch (habit.frequency) {
    case 'daily':
      return 'Каждый день'
    case 'weekdays':
      return [...habit.weekdays]
        .sort((a, b) => a - b)
        .map((d) => weekdayNames[d - 1])
        .join(', ')
    case 'times_per_week': {
      const n = habit.times_per_week ?? 0
      return `${n} ${plural(n, ['раз', 'раза', 'раз'])} в неделю`
    }
  }
}

/** "5 дней", "1 день", "2 недели". */
export function streakLabel(count: number, unit: HabitStreaks['unit']): string {
  const forms: [string, string, string] =
    unit === 'week' ? ['неделя', 'недели', 'недель'] : ['день', 'дня', 'дней']
  return `${count} ${plural(count, forms)}`
}

/** "3 из 8 стаканов" for a quantity; empty for a yes/no habit. */
export function progressLabel(
  habit: Pick<Habit, 'kind' | 'target_value' | 'unit'>,
  value: number,
): string {
  if (habit.kind !== 'quantity') return ''
  return `${value} из ${habit.target_value}${habit.unit ? ` ${habit.unit}` : ''}`
}

/** "На этой неделе: 2 из 3". */
export function weekProgressLabel(done: number, goal: number): string {
  return `На этой неделе: ${done} из ${goal}`
}
