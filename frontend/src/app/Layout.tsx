import { useCallback } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router'
import { useBackButton } from '@/platform/useBackButton'

export function Layout() {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const goBack = useCallback(() => void navigate(-1), [navigate])

  useBackButton(pathname !== '/', goBack)

  return <Outlet />
}
