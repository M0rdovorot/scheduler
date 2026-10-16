import type { Scope } from '@/api/types'
import { Dialog } from '@/components/Dialog'

export interface ScopeOption {
  scope: Scope
  label: string
  /** Why the option cannot be chosen; the option is disabled when set. */
  disabledReason?: string
}

interface ScopeDialogProps {
  title: string
  options: readonly ScopeOption[]
  /** Style the choices as destructive (for a delete). */
  danger?: boolean
  pending?: boolean
  error?: string | null
  onChoose: (scope: Scope) => void
  onCancel: () => void
}

/** Asks what an edit or delete of an occurrence of a regular task applies to (FR-4.2). */
export function ScopeDialog({
  title,
  options,
  danger,
  pending,
  error,
  onChoose,
  onCancel,
}: ScopeDialogProps) {
  return (
    <Dialog title={title} onClose={onCancel}>
      <ul className="space-y-2">
        {options.map((o) => (
          <li key={o.scope}>
            <button
              type="button"
              disabled={pending || o.disabledReason !== undefined}
              onClick={() => onChoose(o.scope)}
              className={`w-full rounded-xl bg-surface px-4 py-3 text-left disabled:opacity-50 ${danger ? 'text-danger' : ''}`}
            >
              {o.label}
            </button>
            {o.disabledReason && <p className="mt-1 px-1 text-sm text-hint">{o.disabledReason}</p>}
          </li>
        ))}
      </ul>
      {error && (
        <p role="alert" className="mt-3 text-danger">
          {error}
        </p>
      )}
      <button
        type="button"
        onClick={onCancel}
        className="mt-3 w-full rounded-xl px-4 py-3 text-hint"
      >
        Отмена
      </button>
    </Dialog>
  )
}
