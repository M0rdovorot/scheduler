// @vitest-environment jsdom
import { json, net, noContent, type StubRequest } from '@/test/fetchStub'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { useAuthStore } from '@/api/authStore'
import { setupApi } from '@/api/setup'
import type { Category } from '@/api/types'
import { App } from '@/app/App'
import { createBrowserPlatform } from '@/platform/browser'
import { PlatformContext } from '@/platform/context'

const user = {
  id: 'u1',
  display_name: 'Ann',
  timezone: 'UTC',
  slot_minutes: 30,
  default_view: 'day',
  deviation_threshold_minutes: 10,
}

/** A small in-memory stand-in for the categories API. */
let store: Category[]
let nextId: number
let failNext: Response | null

function cat(id: string, name: string, parent: string | null = null, archived = false): Category {
  return {
    id,
    name,
    parent_id: parent,
    color: '#3b82f6',
    archived_at: archived ? '2026-01-01T00:00:00Z' : null,
  }
}

function subtree(id: string): Set<string> {
  const ids = new Set([id])
  for (let grew = true; grew;) {
    grew = false
    for (const c of store) {
      if (c.parent_id && ids.has(c.parent_id) && !ids.has(c.id)) {
        ids.add(c.id)
        grew = true
      }
    }
  }
  return ids
}

function server(req: StubRequest): Response {
  if (req.path === '/auth/dev') {
    return json(200, { token: 't', expires_at: '2030-01-01T00:00:00Z', user })
  }
  if (req.method === 'GET' && req.path === '/me') return json(200, user)
  if (req.method !== 'GET' && failNext) {
    const response = failNext
    failNext = null
    return response
  }
  const body = (req.body ?? {}) as Record<string, string | undefined>
  const match = /^\/categories\/([^/]+)(?:\/(move|archive|unarchive))?$/.exec(req.path)
  const target = match ? store.find((c) => c.id === match[1]) : undefined

  if (req.path === '/categories' && req.method === 'GET') return json(200, store)
  if (req.path === '/categories' && req.method === 'POST') {
    const created = {
      ...cat(`c${nextId++}`, body.name!, body.parent_id ?? null),
      color: body.color!,
    }
    store.push(created)
    return json(201, created)
  }
  if (!match || !target) return json(404, { code: 'not_found', message: 'not found' })

  switch (`${req.method} ${match[2] ?? ''}`) {
    case 'PATCH ':
      Object.assign(target, body.name && { name: body.name }, body.color && { color: body.color })
      return json(200, target)
    case 'POST move':
      target.parent_id = body.parent_id ?? null
      return json(200, target)
    case 'POST archive':
      for (const c of store)
        if (subtree(target.id).has(c.id)) c.archived_at = '2026-01-01T00:00:00Z'
      return json(200, target)
    case 'POST unarchive':
      target.archived_at = null
      return json(200, target)
    case 'DELETE ': {
      const doomed = subtree(target.id)
      store = store.filter((c) => !doomed.has(c.id))
      return noContent()
    }
  }
  return json(404, { code: 'not_found', message: 'not found' })
}

const platform = createBrowserPlatform()

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <PlatformContext.Provider value={platform}>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/categories']}>
          <App />
        </MemoryRouter>
      </QueryClientProvider>
    </PlatformContext.Provider>,
  )
  return { queryClient }
}

const dialog = () => screen.findByRole('dialog')
const mutations = () => net.calls.filter((c) => c.method !== 'GET' && c.path !== '/auth/dev')

beforeAll(() => {
  window.matchMedia = (() => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia
  setupApi(platform)
})

beforeEach(() => {
  store = []
  nextId = 1
  failNext = null
  net.calls.length = 0
  net.handler = server
  useAuthStore.getState().setToken(null)
})

afterEach(cleanup)

describe('categories page', () => {
  it('shows an empty state, then creates a category with the chosen color', async () => {
    const ui = userEvent.setup()
    renderPage()
    expect(await screen.findByText(/Категорий пока нет/)).toBeTruthy()

    await ui.click(screen.getByRole('button', { name: '+ Категория' }))
    const form = within(await dialog())
    const save = form.getByRole('button', { name: 'Создать' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)

    await ui.type(form.getByLabelText('Название'), '  Спорт ')
    await ui.click(form.getByRole('radio', { name: 'Красный' }))
    expect(save.disabled).toBe(false)
    await ui.click(save)

    expect(await screen.findByRole('button', { name: 'Спорт' })).toBeTruthy()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(mutations()).toMatchObject([
      { method: 'POST', path: '/categories', body: { name: 'Спорт', color: '#ef4444' } },
    ])
  })

  it('adds a subcategory with the parent preselected and shows the tree', async () => {
    store = [cat('c0', 'Спорт')]
    const ui = userEvent.setup()
    renderPage()

    await ui.click(await screen.findByRole('button', { name: 'Добавить подкатегорию в «Спорт»' }))
    const form = within(await dialog())
    expect((form.getByLabelText('Родительская категория') as HTMLSelectElement).value).toBe('c0')
    await ui.type(form.getByLabelText('Название'), 'Бег')
    await ui.click(form.getByRole('button', { name: 'Создать' }))

    const rows = await screen.findAllByRole('listitem')
    expect(rows.map((r) => r.textContent?.replace('+', ''))).toEqual(['Спорт', 'Бег'])
    expect(mutations()[0]?.body).toMatchObject({ name: 'Бег', parent_id: 'c0' })
  })

  it('renames and moves in one save, sending only what changed', async () => {
    store = [cat('a', 'Спорт'), cat('b', 'Работа'), cat('c', 'Бег', 'a')]
    const ui = userEvent.setup()
    renderPage()

    await ui.click(await screen.findByRole('button', { name: 'Бег' }))
    const form = within(await dialog())
    const select = form.getByLabelText('Родительская категория') as HTMLSelectElement
    // A category can't be offered itself as a parent.
    expect([...select.options].map((o) => o.textContent?.trim())).toEqual([
      'Без родителя (верхний уровень)',
      'Работа',
      'Спорт',
    ])
    await ui.clear(form.getByLabelText('Название'))
    await ui.type(form.getByLabelText('Название'), 'Пробежка')
    await ui.selectOptions(select, 'b')
    await ui.click(form.getByRole('button', { name: 'Сохранить' }))

    await screen.findByRole('button', { name: 'Пробежка' })
    // The move goes first: it is the step the server can refuse.
    expect(mutations()).toMatchObject([
      { method: 'POST', path: '/categories/c/move', body: { parent_id: 'b' } },
      { method: 'PATCH', path: '/categories/c', body: { name: 'Пробежка' } },
    ])
    expect(store.find((c) => c.id === 'c')?.parent_id).toBe('b')
  })

  it('moves to the top level without a parent_id', async () => {
    store = [cat('a', 'Спорт'), cat('c', 'Бег', 'a')]
    const ui = userEvent.setup()
    renderPage()

    await ui.click(await screen.findByRole('button', { name: 'Бег' }))
    const form = within(await dialog())
    await ui.selectOptions(form.getByLabelText('Родительская категория'), '')
    await ui.click(form.getByRole('button', { name: 'Сохранить' }))

    await screen.findByRole('button', { name: 'Бег' })
    expect(mutations()).toMatchObject([{ method: 'POST', path: '/categories/c/move', body: {} }])
    expect(store.find((c) => c.id === 'c')?.parent_id).toBeNull()
  })

  it('explains in Russian why a move was rejected', async () => {
    store = [cat('a', 'Спорт')]
    failNext = json(400, { code: 'category_cycle', message: 'x', field: 'parent_id' })
    const ui = userEvent.setup()
    renderPage()

    await ui.click(await screen.findByRole('button', { name: 'Спорт' }))
    const form = within(await dialog())
    await ui.clear(form.getByLabelText('Название'))
    await ui.type(form.getByLabelText('Название'), 'Спорт 2')
    await ui.click(form.getByRole('button', { name: 'Сохранить' }))

    expect((await form.findByRole('alert')).textContent).toMatch(/внутрь самой себя/)
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('deletes the whole subtree only after confirmation that names the count', async () => {
    store = [cat('a', 'Спорт'), cat('b', 'Бег', 'a'), cat('c', 'Спринт', 'b'), cat('d', 'Работа')]
    const ui = userEvent.setup()
    renderPage()

    await ui.click(await screen.findByRole('button', { name: 'Спорт' }))
    await ui.click(within(await dialog()).getByRole('button', { name: 'Удалить' }))

    const confirm = within(await screen.findByRole('dialog', { name: 'Удалить категорию?' }))
    expect(confirm.getByText(/Подкатегории \(2\) тоже будут удалены/)).toBeTruthy()
    expect(mutations()).toEqual([])

    await ui.click(confirm.getByRole('button', { name: 'Удалить' }))
    await screen.findByRole('button', { name: 'Работа' })
    expect(screen.queryByRole('button', { name: 'Спорт' })).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(mutations()).toMatchObject([{ method: 'DELETE', path: '/categories/a' }])
    expect(store.map((c) => c.id)).toEqual(['d'])
  })

  it('cancelling the confirmation deletes nothing', async () => {
    store = [cat('a', 'Спорт')]
    const ui = userEvent.setup()
    renderPage()

    await ui.click(await screen.findByRole('button', { name: 'Спорт' }))
    await ui.click(within(await dialog()).getByRole('button', { name: 'Удалить' }))
    await ui.click(
      within(await screen.findByRole('dialog', { name: 'Удалить категорию?' })).getByRole(
        'button',
        {
          name: 'Отмена',
        },
      ),
    )

    expect(mutations()).toEqual([])
    expect(screen.getByRole('dialog', { name: 'Категория' })).toBeTruthy()
  })

  it('archives a subtree, hides it, and shows it again on request', async () => {
    store = [cat('a', 'Спорт'), cat('b', 'Бег', 'a'), cat('c', 'Работа')]
    const ui = userEvent.setup()
    renderPage()

    await ui.click(await screen.findByRole('button', { name: 'Спорт' }))
    const form = within(await dialog())
    expect(form.getByText(/Подкатегории \(1\) тоже уйдут в архив/)).toBeTruthy()
    await ui.click(form.getByRole('button', { name: 'В архив' }))

    await screen.findByRole('button', { name: 'Работа' })
    expect(screen.queryByRole('button', { name: 'Спорт' })).toBeNull()
    expect(screen.queryByRole('button', { name: /Бег/ })).toBeNull()

    await ui.click(screen.getByLabelText('Показывать архивные'))
    expect(await screen.findByRole('button', { name: /Спорт/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Бег/ })).toBeTruthy()
    // No "add subcategory" for an archived category.
    expect(screen.queryByRole('button', { name: 'Добавить подкатегорию в «Спорт»' })).toBeNull()

    await ui.click(screen.getByRole('button', { name: /Спорт/ }))
    await ui.click(within(await dialog()).getByRole('button', { name: 'Вернуть из архива' }))
    await screen.findByRole('button', { name: 'Добавить подкатегорию в «Спорт»' })
    expect(mutations().map((m) => m.path)).toEqual([
      '/categories/a/archive',
      '/categories/a/unarchive',
    ])
  })

  it('does not offer archived categories as a parent', async () => {
    store = [cat('a', 'Старое', null, true), cat('b', 'Живое'), cat('c', 'Новое')]
    const ui = userEvent.setup()
    renderPage()

    await ui.click(await screen.findByRole('button', { name: 'Новое' }))
    const select = within(await dialog()).getByLabelText(
      'Родительская категория',
    ) as HTMLSelectElement
    expect([...select.options].map((o) => o.textContent?.trim())).toEqual([
      'Без родителя (верхний уровень)',
      'Живое',
    ])
  })

  it('keeps the rename out of a save whose move was refused', async () => {
    store = [cat('a', 'Спорт'), cat('b', 'Работа'), cat('c', 'Бег', 'a')]
    failNext = json(400, { code: 'parent_archived', message: 'x', field: 'parent_id' })
    const ui = userEvent.setup()
    renderPage()

    await ui.click(await screen.findByRole('button', { name: 'Бег' }))
    const form = within(await dialog())
    await ui.clear(form.getByLabelText('Название'))
    await ui.type(form.getByLabelText('Название'), 'Пробежка')
    await ui.selectOptions(form.getByLabelText('Родительская категория'), 'b')
    await ui.click(form.getByRole('button', { name: 'Сохранить' }))

    expect((await form.findByRole('alert')).textContent).toMatch(/в архиве/)
    expect(store.find((c) => c.id === 'c')?.name).toBe('Бег')
    expect(mutations().map((m) => m.method + ' ' + m.path)).toEqual(['POST /categories/c/move'])
  })

  it('Escape closes only the topmost dialog', async () => {
    store = [cat('a', 'Спорт')]
    const ui = userEvent.setup()
    renderPage()

    await ui.click(await screen.findByRole('button', { name: 'Спорт' }))
    await ui.click(within(await dialog()).getByRole('button', { name: 'Удалить' }))
    await screen.findByRole('dialog', { name: 'Удалить категорию?' })

    await ui.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: 'Удалить категорию?' })).toBeNull()
    expect(screen.getByRole('dialog', { name: 'Категория' })).toBeTruthy()

    await ui.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('a failed delete shows its error only in the confirmation and forgets it on cancel', async () => {
    store = [cat('a', 'Спорт')]
    const ui = userEvent.setup()
    renderPage()

    await ui.click(await screen.findByRole('button', { name: 'Спорт' }))
    const form = within(await dialog())
    await ui.click(form.getByRole('button', { name: 'Удалить' }))
    failNext = json(500, {})
    const confirm = within(await screen.findByRole('dialog', { name: 'Удалить категорию?' }))
    await ui.click(confirm.getByRole('button', { name: 'Удалить' }))

    expect((await confirm.findByRole('alert')).textContent).toMatch(/Не удалось/)
    expect(form.queryByRole('alert')).toBeNull()

    await ui.click(confirm.getByRole('button', { name: 'Отмена' }))
    expect(screen.queryByRole('alert')).toBeNull()
    await ui.click(form.getByRole('button', { name: 'Удалить' }))
    expect(
      within(await screen.findByRole('dialog', { name: 'Удалить категорию?' })).queryByRole(
        'alert',
      ),
    ).toBeNull()
  })

  it('closes the dialog when the edited category disappears from the list', async () => {
    store = [cat('a', 'Спорт'), cat('b', 'Работа')]
    const ui = userEvent.setup()
    const { queryClient } = renderPage()

    await ui.click(await screen.findByRole('button', { name: 'Спорт' }))
    await dialog()

    // Deleted on another device; the next refresh no longer lists it.
    store = store.filter((c) => c.id !== 'a')
    await queryClient.invalidateQueries({ queryKey: ['categories'] })

    await screen.findByRole('button', { name: 'Работа' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('shows the live state of the edited category, not the one from the click', async () => {
    store = [cat('a', 'Спорт')]
    const ui = userEvent.setup()
    const { queryClient } = renderPage()

    await ui.click(await screen.findByRole('button', { name: 'Спорт' }))
    const form = within(await dialog())
    expect(form.getByRole('button', { name: 'В архив' })).toBeTruthy()

    // Archived on another device while the dialog is open.
    store = [cat('a', 'Спорт', null, true)]
    await queryClient.invalidateQueries({ queryKey: ['categories'] })

    expect(await form.findByRole('button', { name: 'Вернуть из архива' })).toBeTruthy()
    expect(form.queryByRole('button', { name: 'В архив' })).toBeNull()
  })
})
