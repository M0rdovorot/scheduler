import { useHealth } from '@/api/health'

export function StatusPage() {
  const { data, isPending, isError } = useHealth()

  let status = 'Проверяем сервер…'
  if (!isPending) status = !isError && data === 'ok' ? 'Сервер работает' : 'Сервер недоступен'

  return (
    <main className="mx-auto max-w-md p-4">
      <h1 className="text-xl font-semibold">Планировщик</h1>
      <p className="mt-3 rounded-xl bg-surface p-3 text-hint" role="status">
        {status}
      </p>
    </main>
  )
}
