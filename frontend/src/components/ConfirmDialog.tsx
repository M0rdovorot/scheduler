import type { ReactNode } from 'react'
import { Dialog } from './Dialog'

interface ConfirmDialogProps {
  title: string
  children: ReactNode
  confirmLabel: string
  pending?: boolean
  error?: string | null
  onConfirm: () => void
  onCancel: () => void
}

/** Confirmation for a destructive action. */
export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  pending = false,
  error,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <Dialog title={title} onClose={onCancel}>
      <div className="text-hint">{children}</div>
      {error && (
        <p role="alert" className="mt-3 text-danger">
          {error}
        </p>
      )}
      <div className="mt-4 flex gap-2">
        <button type="button" onClick={onCancel} className="flex-1 rounded-xl bg-surface px-4 py-3">
          Отмена
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={onConfirm}
          className="flex-1 rounded-xl bg-danger px-4 py-3 text-accent-fg disabled:opacity-50"
        >
          {confirmLabel}
        </button>
      </div>
    </Dialog>
  )
}
