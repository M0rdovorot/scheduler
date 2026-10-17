import { expect, type APIRequestContext, type Locator, type Page } from '@playwright/test'

export const NOW = new Date('2026-10-14T09:00:00Z') // 12:00 in Moscow
export const TZ = 'Europe/Moscow'

/** Pixels per minute in the grid for the default 30-minute slot (28 px per slot). */
export const PPM_30 = 28 / 30

export interface Api {
  token: string
  post: (path: string, data: unknown) => Promise<unknown>
  patch: (path: string, data: unknown) => Promise<unknown>
  put: (path: string, data: unknown) => Promise<unknown>
  get: (path: string) => Promise<unknown>
  del: (path: string) => Promise<void>
}

/** Signs in as the dev user, the same account the app uses in the browser. */
export async function apiLogin(request: APIRequestContext): Promise<Api> {
  const login = await request.post('/api/v1/auth/dev', { data: { timezone: TZ } })
  expect(login.ok()).toBe(true)
  const { token } = (await login.json()) as { token: string }
  const headers = { Authorization: `Bearer ${token}` }
  const checked = async (res: Awaited<ReturnType<APIRequestContext['get']>>) => {
    expect(res.ok(), await res.text()).toBe(true)
    return res.status() === 204 ? undefined : res.json()
  }
  return {
    token,
    post: async (path, data) => checked(await request.post(`/api/v1${path}`, { headers, data })),
    patch: async (path, data) => checked(await request.patch(`/api/v1${path}`, { headers, data })),
    put: async (path, data) => checked(await request.put(`/api/v1${path}`, { headers, data })),
    get: async (path) => checked(await request.get(`/api/v1${path}`, { headers })),
    del: async (path) => void (await checked(await request.delete(`/api/v1${path}`, { headers }))),
  }
}

/** Removes every task and category of the dev user and restores default settings. */
export async function resetData(api: Api) {
  const windows = [
    ['2026-08-01T00:00:00Z', '2026-11-01T00:00:00Z'],
    ['2026-11-01T00:00:00Z', '2027-02-01T00:00:00Z'],
  ]
  for (const [from, to] of windows) {
    const tasks = (await api.get(`/instances?from=${from}&to=${to}`)) as { id: string }[]
    for (const t of tasks) await api.del(`/instances/${t.id}`)
  }
  const habits = (await api.get('/habits')) as { id: string }[]
  for (const h of habits) await api.del(`/habits/${h.id}`)
  const categories = (await api.get('/categories')) as { id: string; parent_id: string | null }[]
  for (const c of categories.filter((c) => c.parent_id === null))
    await api.del(`/categories/${c.id}`)
  await api.put('/reminders/global', {
    enabled: true,
    quiet_hours: null,
    rules: [
      { kind: 'before_start', offset_minutes: 10, time_of_day: null },
      { kind: 'after_end', offset_minutes: 0, time_of_day: null },
    ],
  })
  await api.patch('/me/settings', { slot_minutes: 30, default_view: 'day', timezone: TZ })
}

export async function createTask(
  api: Api,
  task: { title: string; start: string; end: string; categoryIds?: string[] },
) {
  return (await api.post('/tasks', {
    title: task.title,
    planned_start: task.start,
    planned_end: task.end,
    category_ids: task.categoryIds ?? [],
  })) as { id: string }
}

export async function freezeClock(page: Page) {
  await page.clock.setFixedTime(NOW)
}

export function column(page: Page, day: string): Locator {
  return page.locator(`[data-day="${day}"]`)
}

/** Scrolls the grid so that `minute` of the day is `offset` pixels below its top edge. */
export async function scrollGridTo(page: Page, minute: number, ppm: number, offset = 40) {
  await page.evaluate(
    ([top]) => {
      const el = document.querySelector('[data-day]')?.parentElement?.parentElement
      if (el) el.scrollTop = top as number
    },
    [Math.max(0, minute * ppm - offset)],
  )
}

/** The page y coordinate of `minute` in the column (the column must be in view). */
export async function yAt(page: Page, day: string, minute: number, ppm: number) {
  const box = await column(page, day).boundingBox()
  if (!box) throw new Error(`column ${day} is not visible`)
  return box.y + minute * ppm
}
