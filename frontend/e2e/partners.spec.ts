import { expect, test } from '@playwright/test'
import { apiLogin, freezeClock, resetData, type Api } from './helpers'

// The browser is the dev user; the partner is a second dev user, driven through the API.
let me: Api
let boris: Api
let borisId: string

test.beforeEach(async ({ request, page }) => {
  me = await apiLogin(request)
  boris = await apiLogin(request, { key: 'boris', displayName: 'Борис' })
  await resetData(me)
  await resetData(boris)
  borisId = ((await boris.get('/me')) as { id: string }).id
  await freezeClock(page)
})

/** Makes the browser user and Boris partners; Boris has given nothing yet. */
async function link() {
  const invite = (await me.post('/partners/invites', {})) as { token: string }
  await boris.post('/partners/invites/accept', { token: invite.token })
}

const task = (title: string, start: string, end: string, visibility: string) =>
  boris.post('/tasks', { title, planned_start: start, planned_end: end, visibility })

test('invites a partner by link; the partner accepts it', async ({ page }) => {
  await page.goto('/partners')
  await page.getByRole('button', { name: 'Пригласить партнёра' }).click()
  const link = await page.getByRole('textbox', { name: 'Ссылка-приглашение' }).inputValue()
  expect(link).toMatch(/\/\?invite=[\w-]+$/)
  await page.screenshot({ path: 'e2e/screenshots/partners-invite.png' })

  // Boris opens the link: here the same browser, signed in as the inviter, would be
  // "your own invite"; the accept goes through the API as him.
  const token = new URL(link).searchParams.get('invite')!
  await boris.post('/partners/invites/accept', { token })
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Борис' })).toBeVisible()
  await page.screenshot({ path: 'e2e/screenshots/partners-list.png' })
})

test('the invite link signs the person up for a partnership when opened', async ({ page }) => {
  const invite = (await boris.post('/partners/invites', {})) as { token: string }
  await page.goto(`/?invite=${invite.token}`)
  const dialog = page.getByRole('dialog', { name: 'Приглашение' })
  await expect(dialog.getByRole('status')).toContainText('Борис')
  // The token does not stay in the address.
  expect(new URL(page.url()).searchParams.has('invite')).toBe(false)
  await dialog.getByRole('button', { name: 'К партнёрам' }).click()
  await expect(page.getByRole('heading', { name: 'Борис' })).toBeVisible()
  await page.screenshot({ path: 'e2e/screenshots/partners-accepted.png' })
})

test("shows the partner's calendar with titles only where they allow", async ({ page }) => {
  await link()
  await task('Секретно', '2026-10-14T07:00:00Z', '2026-10-14T08:00:00Z', 'private')
  await task('Открытое', '2026-10-14T09:00:00Z', '2026-10-14T10:00:00Z', 'partners')
  await task('Для своих', '2026-10-14T11:00:00Z', '2026-10-14T12:00:00Z', 'granted')

  await page.goto(`/partners/${borisId}`)
  await expect(page.getByRole('button', { name: /^Открытое, 12:00–13:00/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /^Занят, 10:00–11:00/ })).toBeVisible()
  // Nobody gave access to tasks: "granted" is also only "busy".
  await expect(page.getByRole('button', { name: /^Занят, 14:00–15:00/ })).toBeVisible()
  await expect(page.getByText('Секретно')).toHaveCount(0)
  await expect(page.getByText('Для своих')).toHaveCount(0)
  await page.screenshot({ path: 'e2e/screenshots/partner-calendar.png' })

  // Boris gives access to tasks: the "granted" title appears.
  await boris.put(`/partners/${((await me.get('/me')) as { id: string }).id}/access`, {
    tasks: true,
  })
  await page.reload()
  await expect(page.getByRole('button', { name: /^Для своих, 14:00–15:00/ })).toBeVisible()
  await expect(page.getByText('Секретно')).toHaveCount(0)
})

test('finds the free time of two people', async ({ page }) => {
  await link()
  await me.post('/tasks', {
    title: 'Моё',
    planned_start: '2026-10-14T06:00:00Z',
    planned_end: '2026-10-14T08:00:00Z',
  }) // 09:00–11:00 Moscow
  await task('Его', '2026-10-14T09:00:00Z', '2026-10-14T11:00:00Z', 'private') // 12:00–14:00

  await page.goto('/free-time')
  await page.getByRole('checkbox', { name: 'Борис' }).check()
  await expect(page.getByText('11:00–12:00')).toBeVisible()
  await expect(page.getByText('14:00–21:00')).toBeVisible()
  // The hours before 09:00 are cut off, and 09:00–11:00 is busy.
  await expect(page.getByText('09:00–11:00')).toHaveCount(0)
  await page.screenshot({ path: 'e2e/screenshots/free-time.png' })
})

test('breaks the link after confirmation', async ({ page }) => {
  await link()
  await page.goto('/partners')
  await page.getByRole('button', { name: 'Разорвать связь' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Разорвать' }).click()
  await expect(page.getByText(/Партнёров пока нет/)).toBeVisible()
  const gone = await page.request.get(`/api/v1/partners/${borisId}/busy`, {
    headers: { Authorization: `Bearer ${me.token}` },
    params: { from: '2026-10-14T00:00:00Z', to: '2026-10-15T00:00:00Z' },
  })
  expect(gone.status()).toBe(404)
})

test('sets the visibility of a new task in the form and the default in the settings', async ({
  page,
}) => {
  await page.goto('/settings')
  await page.getByLabel('Кто видит названия новых дел').selectOption('partners')
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click()
  await expect(page.getByRole('status')).toHaveText('Сохранено')

  await page.goto('/')
  await page.getByRole('button', { name: 'Новое дело' }).click()
  const dialog = page.getByRole('dialog', { name: 'Новое дело' })
  await expect(dialog.getByRole('radio', { name: /Все партнёры/ })).toBeChecked()
  await dialog.getByRole('radio', { name: /Только я/ }).check()
  await dialog.getByLabel('Название', { exact: true }).fill('Личное')
  await page.screenshot({ path: 'e2e/screenshots/task-visibility.png' })
  await dialog.getByRole('button', { name: 'Создать' }).click()
  await expect(page.getByRole('button', { name: /^Личное/ })).toBeVisible()

  const list = (await me.get(`/instances?from=2026-10-13T00:00:00Z&to=2026-10-16T00:00:00Z`)) as {
    title: string
    visibility: string
  }[]
  expect(list.find((i) => i.title === 'Личное')?.visibility).toBe('private')
})
