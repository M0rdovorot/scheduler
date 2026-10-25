import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { useAuthStore } from '@/api/authStore'
import { api } from '@/api/client'
import { unwrap } from '@/api/errors'
import { meKey } from '@/api/me'
import { loginWithWidget } from '@/api/session'
import { clearTelegramAuthResult, startTelegramLogin, takeTelegramAuthResult } from '@/platform'

/** Sign-in page of the web version. */
export function LoginScreen() {
  const queryClient = useQueryClient()
  const config = useQuery({
    queryKey: ['auth-config'],
    queryFn: async () => unwrap(await api.GET('/auth/config')),
    staleTime: Infinity,
  })

  const signIn = useMutation({
    mutationFn: loginWithWidget,
    onSettled: clearTelegramAuthResult,
    onSuccess: (user) => {
      // Drop whatever an earlier session left in the cache.
      queryClient.clear()
      queryClient.setQueryData(meKey, user)
      queryClient.setQueryData(['session'], true)
      useAuthStore.getState().setSignedOut(false)
    },
  })

  // Telegram brought the user back with the signed fields: finish signing in.
  const [authData] = useState(takeTelegramAuthResult)
  const sent = useRef(false)
  const { mutate } = signIn
  useEffect(() => {
    if (!authData || sent.current) return
    sent.current = true
    mutate(authData)
  }, [authData, mutate])

  const botId = config.data?.telegram_bot_id ?? 0

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center p-4">
      <h1 className="text-2xl font-semibold">Планировщик</h1>
      <p className="mt-2 text-hint">
        Войдите через Telegram — это тот же аккаунт, что в мини-приложении.
      </p>

      {config.isPending && <p className="mt-6 text-hint">Загрузка…</p>}
      {config.isError && (
        <p role="alert" className="mt-6 text-danger">
          Нет связи с сервером
        </p>
      )}
      {config.data && botId === 0 && (
        <p role="alert" className="mt-6 text-danger">
          Вход через Telegram не настроен на сервере
        </p>
      )}
      {botId !== 0 && (
        <button
          type="button"
          disabled={signIn.isPending}
          onClick={() => startTelegramLogin(botId)}
          className="mt-6 rounded-xl bg-accent px-4 py-3 font-medium text-accent-fg disabled:opacity-60"
        >
          {signIn.isPending ? 'Входим…' : 'Войти через Telegram'}
        </button>
      )}
      {signIn.isError && (
        <p role="alert" className="mt-3 text-danger">
          {signIn.error.message}
        </p>
      )}
    </main>
  )
}
