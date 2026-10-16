import { useState } from 'react'
import { useRescheduleInstance } from '@/api/instances'
import type { Instance } from '@/api/types'
import { Dialog } from '@/components/Dialog'
import { taskErrorMessage } from '@/features/calendar/messages'
import { usePlatform } from '@/platform/context'
import {
  defaultReschedule,
  toRescheduleRequest,
  validateReschedule,
  type RescheduleDraft,
} from './reschedule'

interface RescheduleDialogProps {
  instance: Instance
  tz: string
  /** Called after the task was moved. */
  onDone: () => void
  onCancel: () => void
}

const fieldClass = 'mt-1 w-full rounded-xl border border-separator bg-surface px-3 py-2'

/** "Reschedule": a new time and the reason; the original stays as "rescheduled" (FR-5.4). */
export function RescheduleDialog({ instance, tz, onDone, onCancel }: RescheduleDialogProps) {
  const platform = usePlatform()
  const reschedule = useRescheduleInstance()
  const [draft, setDraft] = useState<RescheduleDraft>(() => defaultReschedule(instance, tz))
  const [error, setError] = useState<string | null>(null)

  const errors = validateReschedule(draft, tz)
  const canSave = Object.keys(errors).length === 0 && !reschedule.isPending

  async function save() {
    setError(null)
    try {
      await reschedule.mutateAsync({ id: instance.id, ...toRescheduleRequest(draft, tz) })
      platform.haptic.notify('success')
      onDone()
    } catch (e) {
      platform.haptic.notify('error')
      setError(taskErrorMessage(e))
    }
  }

  return (
    <Dialog title="Перенести дело" onClose={onCancel}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault()
          if (canSave) void save()
        }}
      >
        <p className="text-sm text-hint">
          Дело «{instance.title}» останется в календаре со статусом «перенесено», а на новое время
          появится такое же новое.
        </p>
        <label className="block">
          <span>Новое начало</span>
          <input
            type="datetime-local"
            className={fieldClass}
            value={draft.start}
            onChange={(e) => setDraft({ ...draft, start: e.target.value })}
          />
        </label>
        {errors.start && <p className="text-sm text-danger">{errors.start}</p>}
        <label className="block">
          <span>Новый конец</span>
          <input
            type="datetime-local"
            className={fieldClass}
            value={draft.end}
            onChange={(e) => setDraft({ ...draft, end: e.target.value })}
          />
        </label>
        {errors.end && <p className="text-sm text-danger">{errors.end}</p>}
        <label className="block">
          <span>Причина</span>
          <textarea
            className={fieldClass}
            rows={2}
            value={draft.comment}
            onChange={(e) => setDraft({ ...draft, comment: e.target.value })}
          />
        </label>
        {errors.comment && <p className="text-sm text-danger">{errors.comment}</p>}

        {error && (
          <p role="alert" className="text-danger">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={!canSave}
          className="w-full rounded-xl bg-accent px-4 py-3 text-accent-fg disabled:opacity-50"
        >
          Перенести
        </button>
      </form>
    </Dialog>
  )
}
