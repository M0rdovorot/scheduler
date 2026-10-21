import { deviationShort, planInterval } from '@/features/tracking/fact'
import type { Block } from './blocks'
import { formatTimeRange } from './localTime'

/**
 * The lines under the title of a block, most important first; the block shows as many as fit.
 * A plan block has its time. A fact block has the time of the fact, how it differs from the
 * plan, and the plan itself, so that "what really happened" can be read off the grid.
 */
export function detailLines(block: Block, time: string, tz: string): string[] {
  const { instance, kind } = block
  if (kind === 'plan') return [time]
  if (kind === 'unplanned') return [time, 'вне плана']

  const lines = [time]
  if (instance.status === 'in_progress') lines.push('идёт')
  // "Took longer" only restates a late end and an early start: it is shown when there is nothing else.
  const edges = instance.deviations.filter((d) => !d.kind.startsWith('took_'))
  const deviations = (edges.length > 0 ? edges : instance.deviations)
    .map(deviationShort)
    .join(' · ')
  if (deviations) lines.push(deviations)
  const plan = planInterval(instance)
  if (plan) lines.push(`план ${formatTimeRange(plan.start, plan.end, tz)}`)
  return lines
}

/** How many detail lines fit in a block of this height in pixels (a title takes the first line). */
export function linesThatFit(height: number, dense: boolean): number {
  if (dense) return 0
  return Math.max(0, Math.floor((height - 5) / 13) - 1)
}
