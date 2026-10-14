import { Route, Routes } from 'react-router'
import { StatusPage } from '@/features/system/StatusPage'
import { Layout } from './Layout'

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<StatusPage />} />
      </Route>
    </Routes>
  )
}
