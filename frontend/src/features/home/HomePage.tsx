import { Link } from 'react-router'
import { useMe } from '@/api/me'

export function HomePage() {
  const { data: user } = useMe()

  return (
    <main className="mx-auto max-w-md p-4">
      <h1 className="text-xl font-semibold">Планировщик</h1>
      {user && <p className="mt-1 text-hint">Здравствуйте, {user.display_name}</p>}
      <nav className="mt-4">
        <Link to="/settings" className="text-link">
          Настройки
        </Link>
      </nav>
    </main>
  )
}
