import { useState, type FormEvent } from 'react'
import { useClearPlacement, useCreateHabit, useSetPlacement, useUpdateHabit } from '@/api/habits'
import type { Habit } from '@/api/types'
import { Dialog } from '@/components/Dialog'
import { ColorPicker } from '@/features/categories/ColorPicker'
import { defaultColor } from '@/features/categories/palette'
import { usePlatform } from '@/platform/context'
import {
  canBeInGrid,
  draftFromHabit,
  emptyDraft,
  hasChanges,
  maxTitleLength,
  placementChange,
  toInput,
  toPatch,
  validateDraft,
  type HabitDraft,
} from './form'
import { weekdayNames } from './format'
import { habitErrorMessage } from './messages'

interface HabitFormProps {
  /** The habit to edit; without it a new habit is created. */
  habit?: Habit
  onClose: () => void
}

const fieldClass = 'mt-1 w-full rounded-xl border border-separator bg-surface px-3 py-2'

const frequencies = [
  { value: 'daily', label: 'Каждый день' },
  { value: 'weekdays', label: 'По дням недели' },
  { value: 'times_per_week', label: 'N раз в неделю' },
] as const

export function HabitForm({ habit, onClose }: HabitFormProps) {
  const platform = usePlatform()
  const create = useCreateHabit()
  const update = useUpdateHabit()
  const setPlacement = useSetPlacement()
  const clearPlacement = useClearPlacement()

  const [draft, setDraft] = useState<HabitDraft>(() =>
    habit ? draftFromHabit(habit) : emptyDraft(defaultColor),
  )
  const [error, setError] = useState<string | null>(null)

  const errors = validateDraft(draft)
  const busy = [create, update, setPlacement, clearPlacement].some((m) => m.isPending)
  const canSave =
    Object.keys(errors).length === 0 && !busy && (habit === undefined || hasChanges(habit, draft))
  const gridAllowed = canBeInGrid(draft) && (habit === undefined || habit.archived_at === null)

  const patch = (change: Partial<HabitDraft>) => setDraft({ ...draft, ...change })

  async function save() {
    if (!habit) {
      await create.mutateAsync(toInput(draft))
      return
    }
    // The grid goes first when the habit leaves it (a weekly goal cannot be in it) and last when it
    // comes or moves, so that the server always sees a schedule that fits the grid.
    const grid = placementChange(habit, draft)
    if (grid?.kind === 'clear') await clearPlacement.mutateAsync(habit.id)
    const changes = toPatch(habit, draft)
    if (Object.keys(changes).length > 0) await update.mutateAsync({ id: habit.id, ...changes })
    if (grid?.kind === 'set') await setPlacement.mutateAsync({ id: habit.id, ...grid.placement })
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!canSave) return
    setError(null)
    try {
      await save()
      platform.haptic.notify('success')
      onClose()
    } catch (err) {
      platform.haptic.notify('error')
      setError(habitErrorMessage(err))
    }
  }

  return (
    <Dialog title={habit ? 'Привычка' : 'Новая привычка'} onClose={onClose}>
      <form onSubmit={(e) => void onSubmit(e)} className="space-y-3">
        <label className="block">
          <span>Название</span>
          <input
            className={fieldClass}
            value={draft.title}
            maxLength={maxTitleLength}
            autoFocus={!habit}
            onChange={(e) => patch({ title: e.target.value })}
          />
          {errors.title && <span className="block text-sm text-danger">{errors.title}</span>}
        </label>

        <fieldset>
          <legend>Тип</legend>
          <div className="mt-1 flex gap-2" role="radiogroup" aria-label="Тип">
            {(
              [
                ['boolean', 'Да/нет'],
                ['quantity', 'Количество'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={draft.kind === value}
                // The marks of the two kinds mean different things: the kind of a saved habit stays.
                disabled={habit !== undefined && habit.kind !== value}
                onClick={() => patch({ kind: value })}
                className="flex-1 rounded-xl bg-surface px-3 py-2 aria-checked:bg-accent aria-checked:text-accent-fg disabled:opacity-40"
              >
                {label}
              </button>
            ))}
          </div>
        </fieldset>

        {draft.kind === 'quantity' && (
          <div className="flex gap-2">
            <label className="block flex-1">
              <span>Цель в день</span>
              <input
                inputMode="numeric"
                className={fieldClass}
                value={draft.target}
                onChange={(e) => patch({ target: e.target.value })}
              />
              {errors.target && <span className="block text-sm text-danger">{errors.target}</span>}
            </label>
            <label className="block flex-1">
              <span>Единица</span>
              <input
                className={fieldClass}
                placeholder="стаканов, мин…"
                value={draft.unit}
                onChange={(e) => patch({ unit: e.target.value })}
              />
              {errors.unit && <span className="block text-sm text-danger">{errors.unit}</span>}
            </label>
          </div>
        )}

        <fieldset>
          <legend>Как часто</legend>
          <div className="mt-1 flex flex-wrap gap-2" role="radiogroup" aria-label="Как часто">
            {frequencies.map(({ value, label }) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={draft.frequency === value}
                onClick={() => patch({ frequency: value })}
                className="rounded-xl bg-surface px-3 py-2 aria-checked:bg-accent aria-checked:text-accent-fg"
              >
                {label}
              </button>
            ))}
          </div>
          {draft.frequency === 'weekdays' && (
            <div className="mt-2 flex gap-1" role="group" aria-label="Дни недели">
              {weekdayNames.map((name, i) => {
                const day = i + 1
                const on = draft.weekdays.includes(day)
                return (
                  <button
                    key={name}
                    type="button"
                    aria-pressed={on}
                    onClick={() =>
                      patch({
                        weekdays: on
                          ? draft.weekdays.filter((d) => d !== day)
                          : [...draft.weekdays, day],
                      })
                    }
                    className="flex-1 rounded-lg bg-surface py-2 text-sm aria-pressed:bg-accent aria-pressed:text-accent-fg"
                  >
                    {name}
                  </button>
                )
              })}
            </div>
          )}
          {errors.weekdays && <span className="block text-sm text-danger">{errors.weekdays}</span>}
          {draft.frequency === 'times_per_week' && (
            <label className="mt-2 flex items-center gap-2">
              <input
                inputMode="numeric"
                aria-label="Раз в неделю"
                className="w-16 rounded-xl border border-separator bg-surface px-3 py-2"
                value={draft.timesPerWeek}
                onChange={(e) => patch({ timesPerWeek: e.target.value })}
              />
              <span>раз в неделю</span>
            </label>
          )}
          {errors.timesPerWeek && (
            <span className="block text-sm text-danger">{errors.timesPerWeek}</span>
          )}
        </fieldset>

        <fieldset>
          <legend>Цвет</legend>
          <div className="mt-1">
            <ColorPicker value={draft.color} onChange={(color) => patch({ color })} />
          </div>
        </fieldset>

        <div>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={draft.inGrid && gridAllowed}
              disabled={!gridAllowed}
              onChange={(e) => patch({ inGrid: e.target.checked })}
            />
            <span>Поставить в календарь</span>
          </label>
          {!canBeInGrid(draft) && (
            <p className="text-sm text-hint">Привычка «N раз в неделю» не привязана к дню.</p>
          )}
          {draft.inGrid && gridAllowed && (
            <div className="mt-2 flex gap-2">
              <label className="block flex-1">
                <span>Время</span>
                <input
                  type="time"
                  className={fieldClass}
                  value={draft.time}
                  onChange={(e) => patch({ time: e.target.value })}
                />
                {errors.time && <span className="block text-sm text-danger">{errors.time}</span>}
              </label>
              <label className="block flex-1">
                <span>Минут</span>
                <input
                  inputMode="numeric"
                  className={fieldClass}
                  value={draft.duration}
                  onChange={(e) => patch({ duration: e.target.value })}
                />
                {errors.duration && (
                  <span className="block text-sm text-danger">{errors.duration}</span>
                )}
              </label>
            </div>
          )}
        </div>

        {error && (
          <p role="alert" className="text-danger">
            {error}
          </p>
        )}

        <div className="flex gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded-xl bg-surface px-4 py-3"
          >
            Отмена
          </button>
          <button
            type="submit"
            disabled={!canSave}
            className="flex-1 rounded-xl bg-accent px-4 py-3 text-accent-fg disabled:opacity-50"
          >
            Сохранить
          </button>
        </div>
      </form>
    </Dialog>
  )
}
