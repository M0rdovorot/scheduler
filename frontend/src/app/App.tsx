import { Route, Routes } from 'react-router'
import { HomePage } from '@/features/home/HomePage'
import { SettingsPage } from '@/features/settings/SettingsPage'
import { AuthGate } from './AuthGate'
import { Layout } from './Layout'

export function App() {
  return (
    <AuthGate>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<HomePage />} />
          <Route path="settings" element={<SettingsPage />} />
        </Route>
      </Routes>
    </AuthGate>
  )
}
