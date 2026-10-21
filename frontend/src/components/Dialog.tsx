import { useEffect, useRef, type ReactNode } from 'react'

// Open dialogs, topmost last: Escape closes only the top one.
const openDialogs: symbol[] = []

interface DialogProps {
  title: string
  onClose: () => void
  children: ReactNode
}

/** A modal sheet: bottom-aligned on phones, centred on wide screens. */
export function Dialog({ title, onClose, children }: DialogProps) {
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    onCloseRef.current = onClose
  })

  useEffect(() => {
    const id = Symbol('dialog')
    openDialogs.push(id)
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && openDialogs[openDialogs.length - 1] === id) onCloseRef.current()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      openDialogs.splice(openDialogs.indexOf(id), 1)
    }
  }, [])

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="max-h-[90dvh] w-full max-w-md overflow-y-auto rounded-t-2xl bg-bg p-4 pb-[max(1rem,var(--tg-safe-area-inset-bottom,env(safe-area-inset-bottom,0px)))] sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-start justify-between gap-2">
          <h2 className="text-lg font-semibold">{title}</h2>
          {/* Every sheet can be closed without scrolling to its own buttons. */}
          <button
            type="button"
            aria-label="Закрыть"
            onClick={onClose}
            className="-mr-2 -mt-1 shrink-0 rounded-full px-3 py-1 text-xl leading-none text-hint hover:bg-surface"
          >
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}
