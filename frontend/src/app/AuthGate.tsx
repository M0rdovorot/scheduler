import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { meKey } from '@/api/me'
import { login } from '@/api/session'
import { usePlatform } from '@/platform/context'

/** Signs the user in before rendering the app. */
export function AuthGate({ children }: { children: ReactNode }) {
  const platform = usePlatform()
  const queryClient = useQueryClient()

  const session = useQuery({
    queryKey: ['session'],
    queryFn: async () => {
      const s = await login(platform)
      queryClient.setQueryData(meKey, s.user)
      return s.expires_at
    },
    staleTime: Infinity,
    retry: false,
  })

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
