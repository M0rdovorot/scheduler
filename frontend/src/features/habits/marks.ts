import type { HabitKind } from '@/api/types'

/** The step of the "+" and "−" buttons of a quantity: 1 for small goals, larger for big ones. */
export function stepFor(target: number): number {
  if (target <= 20) return 1
  if (target <= 100) return 5
  if (target <= 500) return 10
  return 50
}

/** The value after a tap on a yes/no habit: done becomes not done and the other way round. */
export function toggled(value: number): number {
  return value > 0 ? 0 : 1
}

/** The value after "+" (direction 1) or "−" (-1); it never goes below zero. */
export function stepped(value: number, target: number, direction: 1 | -1): number {
  return Math.max(0, value + direction * stepFor(target))
}

/** The value written in an input: a whole number from 0, or null when it is not one. */
export function parseValue(text: string, kind: HabitKind): number | null {
  const trimmed = text.trim()
  if (!/^\d{1,7}$/.test(trimmed)) return null
  const n = Number(trimmed)
  if (n > 1_000_000) return null
  if (kind === 'boolean' && n > 1) return null
  return n
}
