import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useAuthStore } from '@/api/authStore'
import { api } from '@/api/client'
import { meKey } from '@/api/me'
import { login, LoginError } from '@/api/session'
import { usePlatform } from '@/platform/context'
import { LoginScreen } from './LoginScreen'

/** Signs the user in before rendering the app. */
export function AuthGate({ children }: { children: ReactNode }) {
  const platform = usePlatform()
  const queryClient = useQueryClient()
  const signedOut = useAuthStore((s) => s.signedOut)

  const session = useQuery({
    queryKey: ['session'],
    queryFn: async () => {
      if (platform.initData) {
        const s = await login(platform)
        queryClient.setQueryData(meKey, s.user)
        return true
      }
      // In the browser the session lives in a cookie. Without one the request
      // gets 401; then dev mode signs in by itself, and otherwise signedOut is set.
      let result
      try {
        result = await api.GET('/me')
      } catch {
        throw new LoginError('Нет связи с сервером')
      }
      if (result.data) {
        queryClient.setQueryData(meKey, result.data)
        return true
      }
      if (result.response.status === 401) return false
      throw new LoginError('Не удалось войти')
    },
    staleTime: Infinity,
    retry: false,
  })

  if (signedOut) {
    return <LoginScreen />
  }
  if (session.isPending) {
    return <p className="p-4 text-hint">Входим…</p>
  }
  if (session.isError) {
    return (
      <main className="mx-auto max-w-md p-4">
        <p role="alert">{session.error.message}</p>
        <button
          type="button"
          onClick={() => void session.refetch()}
          className="mt-3 rounded-xl bg-accent px-4 py-2 text-accent-fg"
        >
          Повторить
        </button>
      </main>
    )
  }
  return children
}
