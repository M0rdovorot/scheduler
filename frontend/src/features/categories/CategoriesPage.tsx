import { useMemo, useState } from 'react'
import { Link } from 'react-router'
import { useCategories } from '@/api/categories'
import { CategoryForm, type FormTarget } from './CategoryForm'
import { buildTree, flattenTree } from './tree'

export function CategoriesPage() {
  const { data: categories, isPending, isError, refetch } = useCategories()
  const [showArchived, setShowArchived] = useState(false)
  const [target, setTarget] = useState<FormTarget | null>(null)

  const forest = useMemo(() => buildTree(categories ?? []), [categories])
  // Everything under an archived category is archived too, so pruning is safe.
  const rows = useMemo(
    () => flattenTree(forest, (c) => !showArchived && c.archived_at !== null),
    [forest, showArchived],
  )
  const hasArchived = (categories ?? []).some((c) => c.archived_at !== null)

  return (
    <main className="mx-auto max-w-md p-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Категории</h1>
        <button
          type="button"
          onClick={() => setTarget({ mode: 'create', parentId: null })}
          className="rounded-xl bg-accent px-3 py-2 text-accent-fg"
        >
          + Категория
        </button>
      </div>

      {isPending && <p className="mt-3 text-hint">Загрузка…</p>}
      {isError && (
        <p className="mt-3 text-danger" role="alert">
          Не удалось загрузить категории.{' '}
          <button type="button" className="underline" onClick={() => void refetch()}>
            Повторить
          </button>
        </p>
      )}

      {categories && rows.length === 0 && (
        <p className="mt-3 text-hint">
          {categories.length === 0
            ? 'Категорий пока нет. Создайте первую, например «Работа» или «Спорт».'
            : 'Все категории в архиве.'}
        </p>
      )}

      <ul className="mt-3 divide-y divide-separator">
        {rows.map(({ category, depth }) => (
          <li
            key={category.id}
            className="flex items-center gap-2 py-1"
            style={{ paddingLeft: depth * 20 }}
          >
            <span
              aria-hidden="true"
              className="size-3 shrink-0 rounded-full"
              style={{ backgroundColor: category.color }}
            />
            <button
              type="button"
              onClick={() => setTarget({ mode: 'edit', category })}
              className={`min-w-0 flex-1 truncate py-2 text-left ${category.archived_at ? 'text-hint' : ''}`}
            >
              {category.name}
              {category.archived_at && <span className="ml-2 text-xs">в архиве</span>}
            </button>
            {!category.archived_at && (
              <button
                type="button"
                aria-label={`Добавить подкатегорию в «${category.name}»`}
                onClick={() => setTarget({ mode: 'create', parentId: category.id })}
                className="size-9 shrink-0 rounded-xl bg-surface text-lg leading-none"
              >
                +
              </button>
            )}
          </li>
        ))}
      </ul>

      {hasArchived && (
        <label className="mt-4 flex items-center gap-2 text-hint">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
          />
          Показывать архивные
        </label>
      )}

      <nav className="mt-6">
        <Link to="/" className="text-link">
          На главную
        </Link>
      </nav>

      {target && <CategoryForm target={target} forest={forest} onClose={() => setTarget(null)} />}
    </main>
  )
}
