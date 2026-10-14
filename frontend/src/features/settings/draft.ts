import type { SettingsPatch, SlotMinutes, User, ViewMode } from '@/api/types'
import { isValidTimeZone } from '@/lib/timezone'

export const slotOptions: readonly SlotMinutes[] = [5, 10, 15, 30, 60]

export const viewOptions: readonly { value: ViewMode; label: string }[] = [
  { value: 'day', label: 'День' },
  { value: 'three_days', label: '3 дня' },
  { value: 'week', label: 'Неделя' },
]

export const maxThresholdMinutes = 1440

/** Form state; the threshold stays a string while the user is typing. */
export interface SettingsDraft {
  timezone: string
  slotMinutes: SlotMinutes
  defaultView: ViewMode
  deviationThreshold: string
}

export type DraftErrors = Partial<Record<'timezone' | 'deviationThreshold', string>>

export function draftFromUser(user: User): SettingsDraft {
  return {
    timezone: user.timezone,
    slotMinutes: user.slot_minutes,
    defaultView: user.default_view,
    deviationThreshold: String(user.deviation_threshold_minutes),
  }
}

export function validateDraft(draft: SettingsDraft): DraftErrors {
  const errors: DraftErrors = {}
  if (!isValidTimeZone(draft.timezone.trim())) {
    errors.timezone = 'Укажите часовой пояс из списка, например Europe/Moscow'
  }
  const threshold = parseThreshold(draft.deviationThreshold)
  if (threshold === null) {
    errors.deviationThreshold = `Целое число минут от 0 до ${maxThresholdMinutes}`
  }
  return errors
}

function parseThreshold(text: string): number | null {
  if (!/^\d+$/.test(text.trim())) return null
  const n = Number(text)
  return n <= maxThresholdMinutes ? n : null
}

/** Only the fields that differ from the saved user. The draft must be valid. */
export function buildSettingsPatch(user: User, draft: SettingsDraft): SettingsPatch {
  const patch: SettingsPatch = {}
  const timezone = draft.timezone.trim()
  if (timezone !== user.timezone) patch.timezone = timezone
  if (draft.slotMinutes !== user.slot_minutes) patch.slot_minutes = draft.slotMinutes
  if (draft.defaultView !== user.default_view) patch.default_view = draft.defaultView
  const threshold = parseThreshold(draft.deviationThreshold)
  if (threshold !== null && threshold !== user.deviation_threshold_minutes) {
    patch.deviation_threshold_minutes = threshold
  }
  return patch
}
