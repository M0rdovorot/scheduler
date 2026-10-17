import { useId, useState, type FormEvent } from 'react'
import { useMe, useUpdateSettings } from '@/api/me'
import type { SlotMinutes, User, ViewMode } from '@/api/types'
import { listTimeZones } from '@/lib/timezone'
import { GlobalReminders } from '@/features/reminders/GlobalReminders'
import { usePlatform } from '@/platform/context'
import {
  buildSettingsPatch,
  draftFromUser,
  maxThresholdMinutes,
  slotOptions,
  validateDraft,
  viewOptions,
} from './draft'

export function SettingsPage() {
  const { data: user, isPending, isError } = useMe()

  return (
    <main className="mx-auto max-w-md p-4">
      <h1 className="text-xl font-semibold">Настройки</h1>
      {isPending && <p className="mt-3 text-hint">Загрузка…</p>}
      {isError && <p className="mt-3 text-danger">Не удалось загрузить настройки</p>}
      {user && <SettingsForm user={user} />}
      {user && <GlobalReminders />}
    </main>
  )
}

const fieldClass = 'mt-1 w-full rounded-xl border border-separator bg-surface px-3 py-2'

function slotLabel(minutes: SlotMinutes) {
  return minutes === 60 ? '1 час' : `${minutes} мин`
}

function SettingsForm({ user }: { user: User }) {
  const platform = usePlatform()
  const update = useUpdateSettings()
  const [draft, setDraft] = useState(() => draftFromUser(user))
  const [saved, setSaved] = useState(false)
  const timeZoneListId = useId()

  const errors = validateDraft(draft)
  const patch = buildSettingsPatch(user, draft)
  const canSave =
    Object.keys(errors).length === 0 && Object.keys(patch).length > 0 && !update.isPending

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!canSave) return
    setSaved(false)
    update.mutate(patch, {
      onSuccess: () => {
        platform.haptic.notify('success')
        setSaved(true)
      },
      onError: () => platform.haptic.notify('error'),
    })
  }

  function change(next: Partial<typeof draft>) {
    setSaved(false)
    setDraft({ ...draft, ...next })
  }

  return (
    <form onSubmit={onSubmit} className="mt-4 space-y-4">
      <label className="block">
        <span>Размер слота</span>
        <select
          className={fieldClass}
          value={draft.slotMinutes}
          onChange={(e) => change({ slotMinutes: Number(e.target.value) as SlotMinutes })}
        >
          {slotOptions.map((m) => (
            <option key={m} value={m}>
              {slotLabel(m)}
            </option>
          ))}
        </select>
      </label>

      <label className="block">
        <span>Вид календаря по умолчанию</span>
        <select
          className={fieldClass}
          value={draft.defaultView}
          onChange={(e) => change({ defaultView: e.target.value as ViewMode })}
        >
          {viewOptions.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>

      <label className="block">
        <span>Порог отклонения, минут</span>
        <input
          className={fieldClass}
          inputMode="numeric"
          value={draft.deviationThreshold}
          onChange={(e) => change({ deviationThreshold: e.target.value })}
          aria-invalid={errors.deviationThreshold !== undefined}
        />
        <span className="text-sm text-hint">
          Опоздание или затяжка меньше порога не считаются отклонением (0–{maxThresholdMinutes})
        </span>
        {errors.deviationThreshold && (
          <span className="block text-sm text-danger">{errors.deviationThreshold}</span>
        )}
      </label>

      <label className="block">
        <span>Часовой пояс</span>
        <input
          className={fieldClass}
          list={timeZoneListId}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          value={draft.timezone}
          onChange={(e) => change({ timezone: e.target.value })}
          aria-invalid={errors.timezone !== undefined}
        />
        <datalist id={timeZoneListId}>
          {listTimeZones().map((tz) => (
            <option key={tz} value={tz} />
          ))}
        </datalist>
        {errors.timezone && <span className="block text-sm text-danger">{errors.timezone}</span>}
      </label>

      {update.isError && (
        <p role="alert" className="text-danger">
          {update.error.message}
        </p>
      )}
      {saved && (
        <p role="status" className="text-hint">
          Сохранено
        </p>
      )}

      <button
        type="submit"
        disabled={!canSave}
        className="w-full rounded-xl bg-accent px-4 py-3 text-accent-fg disabled:opacity-50"
      >
        Сохранить
      </button>
    </form>
  )
}
