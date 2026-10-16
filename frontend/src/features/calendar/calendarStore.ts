import { create } from 'zustand'
import type { ViewMode } from '@/api/types'
import type { ShowMode } from './blocks'
import type { Day } from './dates'

interface CalendarState {
  /** null until the user picks one: then the default view from settings applies. */
  view: ViewMode | null
  /** null means "today". */
  anchor: Day | null
  /** Plan, fact or both. In the week view "both" is shown as the plan. */
  mode: ShowMode
  setMode: (mode: ShowMode) => void
  setView: (view: ViewMode) => void
  setAnchor: (anchor: Day | null) => void
}

export const useCalendarStore = create<CalendarState>()((set) => ({
  view: null,
  anchor: null,
  mode: 'both',
  setMode: (mode) => set({ mode }),
  setView: (view) => set({ view }),
  setAnchor: (anchor) => set({ anchor }),
}))
