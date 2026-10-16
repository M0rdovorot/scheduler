import type { Instance } from '@/api/types'
import { formatMinutes } from './grid'

interface EventBlockProps {
  instance: Instance
  title: string
  color: string
  /** Position inside the day column, in pixels and fractions of its width. */
  top: number
  height: number
  column: number
  columns: number
  startMin: number
  endMin: number
  continuesBefore: boolean
  continuesAfter: boolean
  /** Many narrow columns (week view): the title wraps and the time line is left out. */
  dense: boolean
  onOpen: (instance: Instance) => void
}

/** A task in a day column. Tall enough blocks also show their time range. */
export function EventBlock({
  instance,
  title,
  color,
  top,
  height,
  column,
  columns,
  startMin,
  endMin,
  continuesBefore,
  continuesAfter,
  dense,
  onOpen,
}: EventBlockProps) {
  const time = `${formatMinutes(startMin)}–${formatMinutes(endMin)}`
  return (
    <button
      type="button"
      data-task={instance.id}
      aria-label={`${instance.title}, ${time}`}
      onClick={() => onOpen(instance)}
      className="absolute overflow-hidden px-1 py-0.5 text-left text-xs leading-tight"
      style={{
        top,
        height: Math.max(height - 1, 12),
        left: `calc(${(column / columns) * 100}% + 1px)`,
        width: `calc(${100 / columns}% - 2px)`,
        backgroundColor: `color-mix(in srgb, ${color} 28%, var(--app-bg))`,
        borderLeft: `3px solid ${color}`,
        borderTopLeftRadius: continuesBefore ? 0 : 6,
        borderTopRightRadius: continuesBefore ? 0 : 6,
        borderBottomLeftRadius: continuesAfter ? 0 : 6,
        borderBottomRightRadius: continuesAfter ? 0 : 6,
      }}
    >
      <span
        className={`block font-medium ${dense ? 'break-words hyphens-auto' : 'truncate'}`}
        lang="ru"
      >
        {instance.series_id && (
          <span aria-hidden="true" className="mr-0.5 text-hint" data-repeat>
            ↻
          </span>
        )}
        {title}
      </span>
      {!dense && height >= 40 && <span className="block truncate text-hint">{time}</span>}
    </button>
  )
}
