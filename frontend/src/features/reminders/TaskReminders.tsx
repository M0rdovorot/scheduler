import { useState } from 'react'
import type { Instance } from '@/api/types'
import { ScopeDialog } from '@/features/recurrence/ScopeDialog'
import { ReminderDialog } from './LevelEditor'

interface TaskRemindersProps {
  instance: Instance
  onClose: () => void
}

/**
 * The reminders of a task. For an occurrence of a series it first asks whether they are for
 * this one only or for the whole series (FR-9.2, levels three and four).
 */
export function TaskReminders({ instance, onClose }: TaskRemindersProps) {
  const [level, setLevel] = useState<'instance' | 'series' | null>(
    instance.series_id === null ? 'instance' : null,
  )

  if (level === null) {
    return (
      <ScopeDialog
        title="Напоминания"
        note="Для чего задать напоминания?"
        options={[
          { scope: 'this', label: 'Только для этого дела' },
          { scope: 'all', label: 'Для всех дел серии' },
        ]}
        onChoose={(scope) => setLevel(scope === 'this' ? 'instance' : 'series')}
        onCancel={onClose}
      />
    )
  }
  return (
    <ReminderDialog
      scope={level}
      id={level === 'series' ? instance.series_id! : instance.id}
      subject={instance.title}
      onClose={onClose}
    />
  )
}
