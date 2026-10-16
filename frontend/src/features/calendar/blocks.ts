import type { Instance, ViewMode } from '@/api/types'
import { factInterval, planInterval, type Interval } from '@/features/tracking/fact'
import type { Day } from './dates'
import { segmentOnDay, type Segment } from './segments'

/** What the grid draws: the plan, the fact, or both (FR-5.8). */
export type ShowMode = 'plan' | 'fact' | 'both'

/** The week is too narrow for both at once: there "both" falls back to the plan. */
export function effectiveMode(mode: ShowMode, view: ViewMode): ShowMode {
  return mode === 'both' && view === 'week' ? 'plan' : mode
}

export const modeOptions = (view: ViewMode): readonly ShowMode[] =>
  view === 'week' ? ['plan', 'fact'] : ['plan', 'fact', 'both']

export interface Block {
  key: string
  instance: Instance
  /**
   * plan: drawn by the plan. fact: drawn by the fact. unplanned: a task that was never
   * planned, drawn by its fact (hatched).
   */
  kind: 'plan' | 'fact' | 'unplanned'
  seg: Segment
  /** The fact as a narrow stripe beside a plan block (mode "both"). */
  stripe: Segment | null
}

function onDay(interval: Interval | null, day: Day, tz: string): Segment | null {
  return interval ? segmentOnDay(interval.start, interval.end, day, tz) : null
}

/** True if the plan or the fact of the task reaches the day, whatever is shown. */
export function touchesDay(instance: Instance, day: Day, tz: string, now: Date): boolean {
  return (
    onDay(planInterval(instance), day, tz) !== null ||
    onDay(factInterval(instance, now), day, tz) !== null
  )
}

/** The blocks of one day for the mode. */
export function blocksForDay(
  instances: readonly Instance[],
  day: Day,
  tz: string,
  mode: ShowMode,
  now: Date,
): Block[] {
  const blocks: Block[] = []
  for (const instance of instances) {
    const plan = onDay(planInterval(instance), day, tz)
    const fact = onDay(factInterval(instance, now), day, tz)
    const planned = planInterval(instance) !== null

    if (!planned) {
      // Outside the plan there is only the fact: shown unless the grid shows the plan alone.
      if (mode !== 'plan' && fact)
        blocks.push({ key: instance.id, instance, kind: 'unplanned', seg: fact, stripe: null })
      continue
    }
    if (mode === 'plan') {
      if (plan) blocks.push({ key: instance.id, instance, kind: 'plan', seg: plan, stripe: null })
    } else if (mode === 'fact') {
      if (fact) blocks.push({ key: instance.id, instance, kind: 'fact', seg: fact, stripe: null })
    } else if (plan) {
      blocks.push({ key: instance.id, instance, kind: 'plan', seg: plan, stripe: fact })
    } else if (fact) {
      // The fact is on another day than the plan: it still has to be seen.
      blocks.push({ key: instance.id, instance, kind: 'fact', seg: fact, stripe: null })
    }
  }
  return blocks
}
