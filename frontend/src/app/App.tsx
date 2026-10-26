import { Route, Routes } from 'react-router'
import { CategoriesPage } from '@/features/categories/CategoriesPage'
import { CalendarPage } from '@/features/calendar/CalendarPage'
import { HabitPage } from '@/features/habits/HabitPage'
import { HabitsPage } from '@/features/habits/HabitsPage'
import { FreeTimePage } from '@/features/partners/FreeTimePage'
import { InviteAccept } from '@/features/partners/InviteAccept'
import { PartnerCalendarPage } from '@/features/partners/PartnerCalendarPage'
import { PartnersPage } from '@/features/partners/PartnersPage'
import { SettingsPage } from '@/features/settings/SettingsPage'
import { StatsPage } from '@/features/stats/StatsPage'
import { TimersPage } from '@/features/tracking/TimersPage'
import { AuthGate } from './AuthGate'
import { Layout } from './Layout'

export function App() {
  return (
    <AuthGate>
      <InviteAccept />
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<CalendarPage />} />
          <Route path="categories" element={<CategoriesPage />} />
          <Route path="stats" element={<StatsPage />} />
          <Route path="habits" element={<HabitsPage />} />
          <Route path="habits/:id" element={<HabitPage />} />
          <Route path="timers" element={<TimersPage />} />
          <Route path="partners" element={<PartnersPage />} />
          <Route path="partners/:id" element={<PartnerCalendarPage />} />
          <Route path="free-time" element={<FreeTimePage />} />
          <Route path="settings" element={<SettingsPage />} />
        </Route>
      </Routes>
    </AuthGate>
  )
}
