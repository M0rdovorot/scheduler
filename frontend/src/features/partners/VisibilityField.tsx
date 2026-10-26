import { useId } from 'react'
import type { Visibility } from '@/api/types'
import { visibilityOptions } from './visibility'

interface VisibilityFieldProps {
  value: Visibility
  onChange: (value: Visibility) => void
}

/** Who sees the title of a task (FR-11.5). Everyone else sees only that the time is busy. */
export function VisibilityField({ value, onChange }: VisibilityFieldProps) {
  const base = useId()
  return (
    <fieldset>
      <legend>Кто видит название</legend>
      <div className="mt-1 space-y-1">
        {visibilityOptions.map((o) => (
          <div key={o.value} className="flex items-start gap-2 rounded-xl bg-surface px-3 py-2">
            <input
              type="radio"
              id={`${base}-${o.value}`}
              name={`${base}-visibility`}
              aria-describedby={`${base}-${o.value}-hint`}
              className="mt-1"
              checked={value === o.value}
              onChange={() => onChange(o.value)}
            />
            <div>
              {/* The hint stays out of the label: it is read as a description, not as the name. */}
              <label htmlFor={`${base}-${o.value}`}>{o.label}</label>
              <span id={`${base}-${o.value}-hint`} className="block text-sm text-hint">
                {o.hint}
              </span>
            </div>
          </div>
        ))}
      </div>
    </fieldset>
  )
}
