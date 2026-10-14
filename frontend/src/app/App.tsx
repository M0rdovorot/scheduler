import { Route, Routes } from 'react-router'
import { CategoriesPage } from '@/features/categories/CategoriesPage'
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
          <Route path="categories" element={<CategoriesPage />} />
          <Route path="settings" element={<SettingsPage />} />
        </Route>
      </Routes>
    </AuthGate>
  )
}
