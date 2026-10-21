import type { Instance } from '@/api/types'
import { statusLabels, statusMarks } from '@/features/tracking/fact'
import type { Block } from './blocks'
import { linesThatFit } from './blockLines'
import { formatMinutes } from './grid'

interface EventBlockProps {
  block: Block
  color: string
  /** Position inside the day column, in pixels and fractions of its width. */
  top: number
  height: number
  column: number
  columns: number
  /** The task is planned, its time is over and nobody marked it (FR-5.9). */
  unmarked: boolean
  /** Many narrow columns (week view): the title wraps and the lines under it are left out. */
  dense: boolean
  /** The lines under the title, most important first; only those that fit are drawn. */
  details: readonly string[]
  onOpen: (instance: Instance) => void
}

/**
 * A task in a day column. Drawn by the plan (kind "plan"), by the fact ("fact") or,
 * for a task outside the plan, by the fact with hatching ("unplanned").
 */
export function EventBlock({
  block,
  color,
  top,
  height,
  column,
  columns,
  unmarked,
  dense,
  details,
  onOpen,
}: EventBlockProps) {
  const { instance, kind, seg, stripe } = block
  const time = `${formatMinutes(seg.startMin)}–${formatMinutes(seg.endMin)}`
  const mark = statusMarks[instance.status]
  const rescheduled = instance.status === 'rescheduled'
  const hatched = kind === 'unplanned'

  const label = [
    instance.title,
    time,
    kind === 'plan' ? null : 'факт',
    instance.status === 'planned' ? null : statusLabels[instance.status],
  ]
    .filter(Boolean)
    .join(', ')

  // What happened is drawn denser than what was planned, so that the two read differently.
  const tint = `color-mix(in srgb, ${color} ${kind === 'plan' ? 28 : 48}%, var(--app-bg))`
  return (
    <button
      type="button"
      data-task={instance.id}
      data-kind={kind}
      data-status={instance.status}
      data-unmarked={unmarked || undefined}
      aria-label={label}
      onClick={() => onOpen(instance)}
      className={`absolute overflow-hidden py-0.5 pr-1 text-left text-xs leading-tight ${stripe ? 'pl-2' : 'pl-1'} ${rescheduled ? 'opacity-50' : ''} ${unmarked ? 'outline-dashed outline-1 -outline-offset-1 outline-hint' : ''}`}
      style={{
        top,
        height: Math.max(height - 1, 12),
        left: `calc(${(column / columns) * 100}% + 1px)`,
        width: `calc(${100 / columns}% - 2px)`,
        background: hatched
          ? `repeating-linear-gradient(135deg, ${tint} 0 6px, color-mix(in srgb, ${color} 14%, var(--app-bg)) 6px 12px)`
          : tint,
        borderLeft: `3px ${rescheduled ? 'dashed' : 'solid'} ${color}`,
        borderTopLeftRadius: seg.continuesBefore ? 0 : 6,
        borderTopRightRadius: seg.continuesBefore ? 0 : 6,
        borderBottomLeftRadius: seg.continuesAfter ? 0 : 6,
        borderBottomRightRadius: seg.continuesAfter ? 0 : 6,
      }}
    >
      <span
        className={`block font-medium ${dense ? 'break-words hyphens-auto' : 'truncate'} ${rescheduled ? 'line-through' : ''}`}
        lang="ru"
      >
        {instance.status === 'in_progress' ? (
          <span
            aria-hidden="true"
            data-running
            className="mr-1 inline-block size-1.5 animate-pulse rounded-full bg-danger align-middle"
          />
        ) : (
          mark && (
            <span aria-hidden="true" className="mr-0.5" data-mark>
              {mark}
            </span>
          )
        )}
        {instance.series_id && (
          <span aria-hidden="true" className="mr-0.5 text-hint" data-repeat>
            ↻
          </span>
        )}
        {unmarked && (
          <span aria-hidden="true" className="mr-0.5 text-hint" data-unmarked-mark>
            ?
          </span>
        )}
        {instance.title}
      </span>
      {details.slice(0, linesThatFit(height, dense)).map((line, i) => (
        <span key={i} data-detail className="block truncate text-hint">
          {line}
        </span>
      ))}
    </button>
  )
}
