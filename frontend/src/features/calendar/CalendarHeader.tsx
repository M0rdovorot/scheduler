import { useState } from 'react'
import { Link } from 'react-router'
import type { ViewMode } from '@/api/types'

const views: readonly { value: ViewMode; label: string }[] = [
  { value: 'day', label: 'День' },
  { value: 'three_days', label: '3 дня' },
  { value: 'week', label: 'Неделя' },
]

interface CalendarHeaderProps {
  title: string
  view: ViewMode
  onViewChange: (view: ViewMode) => void
  onPrev: () => void
  onNext: () => void
  onToday: () => void
}

export function CalendarHeader({
  title,
  view,
  onViewChange,
  onPrev,
  onNext,
  onToday,
}: CalendarHeaderProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const iconButton = 'size-9 rounded-xl bg-surface text-lg leading-none'

  return (
    <header className="space-y-2 px-3 pb-2 pt-3">
      <div className="flex items-center gap-2">
        <button type="button" aria-label="Назад" className={iconButton} onClick={onPrev}>
          ‹
        </button>
        <button type="button" aria-label="Вперёд" className={iconButton} onClick={onNext}>
          ›
        </button>
        <h1 className="min-w-0 flex-1 truncate text-lg font-semibold">{title}</h1>
        <button type="button" className="rounded-xl bg-surface px-3 py-2 text-sm" onClick={onToday}>
          Сегодня
        </button>
        <div className="relative">
          <button
            type="button"
            aria-label="Меню"
            aria-expanded={menuOpen}
            className={iconButton}
            onClick={() => setMenuOpen(!menuOpen)}
          >
            ⋯
          </button>
          {menuOpen && (
            <nav className="absolute right-0 z-30 mt-1 w-40 rounded-xl border border-separator bg-bg p-1 shadow-lg">
              <Link to="/categories" className="block rounded-lg px-3 py-2 hover:bg-surface">
                Категории
              </Link>
              <Link to="/settings" className="block rounded-lg px-3 py-2 hover:bg-surface">
                Настройки
              </Link>
            </nav>
          )}
        </div>
      </div>

      <div
        role="radiogroup"
        aria-label="Вид календаря"
        className="flex rounded-xl bg-surface p-0.5"
      >
        {views.map((v) => (
          <button
            key={v.value}
            type="button"
            role="radio"
            aria-checked={view === v.value}
            onClick={() => onViewChange(v.value)}
            className="flex-1 rounded-[10px] py-1.5 text-sm aria-checked:bg-bg aria-checked:font-semibold aria-checked:shadow-sm"
          >
            {v.label}
          </button>
        ))}
      </div>
    </header>
  )
}
