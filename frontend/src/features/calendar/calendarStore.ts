import { create } from 'zustand'
import type { ViewMode } from '@/api/types'
import type { Day } from './dates'

interface CalendarState {
  /** null until the user picks one: then the default view from settings applies. */
  view: ViewMode | null
  /** null means "today". */
  anchor: Day | null
  setView: (view: ViewMode) => void
  setAnchor: (anchor: Day | null) => void
}

export const useCalendarStore = create<CalendarState>()((set) => ({
  view: null,
  anchor: null,
  setView: (view) => set({ view }),
  setAnchor: (anchor) => set({ anchor }),
}))
