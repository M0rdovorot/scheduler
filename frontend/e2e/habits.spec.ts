import { expect, test } from '@playwright/test'
import { PPM_30, TZ, apiLogin, resetData, scrollGridTo, type Api } from './helpers'

// The server works out "today" with its own clock, so these tests use the real date
// in the user's time zone instead of the frozen one.
let api: Api

test.beforeEach(async ({ request }) => {
  api = await apiLogin(request)
  await resetData(api)
})

const ymd = (d: Date) => d.toLocaleDateString('sv-SE', { timeZone: TZ })
const daysAgo = (n: number) => ymd(new Date(Date.now() - n * 864e5))

async function createHabit(body: Record<string, unknown>) {
  return (await api.post('/habits', { color: '#3b82f6', ...body })) as { id: string }
}

test('marks today: a tap for yes/no, plus and minus for a quantity', async ({ page }) => {
  await createHabit({ title: 'Читать', kind: 'boolean', frequency: 'daily' })
  await createHabit({
    title: 'Вода',
    kind: 'quantity',
    target_value: 8,
    unit: 'стаканов',
    frequency: 'daily',
    color: '#06b6d4',
  })
  await page.goto('/habits')

  const read = page.getByRole('button', { name: 'Отметить: Читать' })
  await read.click()
  await expect(page.getByRole('button', { name: 'Снять отметку: Читать' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )

  const plus = page.getByRole('button', { name: 'Больше: Вода' })
  for (let i = 0; i < 3; i++) await plus.click()
  await expect(page.getByTestId('progress')).toContainText('3 из 8 стаканов')
  await page.screenshot({ path: 'e2e/screenshots/habits-today.png' })

  // Marks are kept on the server.
  await page.reload()
  await expect(page.getByRole('button', { name: 'Снять отметку: Читать' })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Значение: Вода' })).toHaveValue('3')

  await page.getByRole('button', { name: 'Больше: Вода' }).click({ clickCount: 5, delay: 120 })
  await expect(page.getByTestId('progress')).toContainText('8 из 8 стаканов ✓')
})

test('creates a habit from the form and opens it', async ({ page }) => {
  await page.goto('/habits')
  await page.getByRole('button', { name: '+ Привычка' }).click()
  const dialog = page.getByRole('dialog', { name: 'Новая привычка' })
  await dialog.getByRole('textbox', { name: /^Название/ }).fill('Зал')
  await dialog.getByRole('radio', { name: 'N раз в неделю' }).click()
  await dialog.getByRole('textbox', { name: 'Раз в неделю' }).fill('2')
  await page.screenshot({ path: 'e2e/screenshots/habit-form.png' })
  await dialog.getByRole('button', { name: 'Сохранить' }).click()
  await expect(dialog).toHaveCount(0)

  const row = page.getByTestId('habits-today').getByRole('listitem').filter({ hasText: 'Зал' })
  await expect(row).toContainText('На этой неделе: 0 из 2')
  await row.getByRole('link', { name: 'Зал' }).click()
  await expect(page.getByRole('heading', { name: 'Зал' })).toBeVisible()
  await expect(page.locator('[data-tile="current"]')).toContainText('0 недель')
})

test('shows the streak, the percentage and the heat map, and a day can be corrected', async ({
  page,
}) => {
  const { id } = await createHabit({
    title: 'Йога',
    kind: 'boolean',
    frequency: 'daily',
    color: '#8b5cf6',
  })
  for (const n of [0, 1, 2, 3, 4, 6, 7, 8])
    await api.put(`/habits/${id}/logs/${daysAgo(n)}`, { value: 1 })

  await page.goto(`/habits/${id}`)
  // Today, yesterday … four days ago are done in a row; five days ago is missed.
  await expect(page.locator('[data-tile="current"]')).toContainText('5 дней')
  await expect(page.locator('[data-tile="best"]')).toContainText('5 дней')
  // The days before the first mark are not counted: 9 days from it, 8 done.
  await expect(page.locator('[data-tile="pall"]')).toContainText('89%')
  await expect(page.locator(`[data-cell="${daysAgo(0)}"]`)).toHaveAttribute('data-level', '4')
  await expect(page.locator(`[data-cell="${daysAgo(5)}"]`)).toHaveAttribute('data-level', '0')
  await page.screenshot({ path: 'e2e/screenshots/habit-page.png', fullPage: true })

  // Fix the missed day: the streak joins up.
  await page.locator(`[data-cell="${daysAgo(5)}"]`).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Выполнено', exact: true }).click()
  await expect(page.locator('[data-tile="current"]')).toContainText('9 дней')
  await expect(page.locator(`[data-cell="${daysAgo(5)}"]`)).toHaveAttribute('data-level', '4')
})

test('a habit in the calendar is a task, and doing it counts for the habit', async ({ page }) => {
  const { id } = await createHabit({
    title: 'Зарядка',
    kind: 'boolean',
    frequency: 'daily',
    color: '#ef4444',
    placement: { time: '07:30', duration_minutes: 30 },
  })
  await page.goto('/')
  await scrollGridTo(page, 7 * 60 + 30, PPM_30, 60)
  const block = page.getByRole('button', { name: /^Зарядка, 07:30–08:00/ })
  await expect(block).toBeVisible()
  await expect(block).toHaveCSS('background-color', /.+/)
  await page.screenshot({ path: 'e2e/screenshots/habit-in-calendar.png' })

  await block.click()
  const card = page.getByRole('dialog', { name: 'Дело' })
  // The schedule belongs to the habit: no repeat editor here.
  await expect(card.getByText('расписание меняется на экране «Привычки»')).toBeVisible()
  await card.getByRole('button', { name: 'Выполнено', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)

  await page.goto('/habits')
  await expect(page.getByRole('button', { name: 'Снять отметку: Зарядка' })).toBeVisible()

  // Taking the mark off in the calendar takes the credit back.
  await page.goto('/')
  await scrollGridTo(page, 7 * 60 + 30, PPM_30, 60)
  await page.getByRole('button', { name: /^Зарядка/ }).click()
  await page
    .getByRole('dialog', { name: 'Дело' })
    .getByRole('button', { name: 'Снять отметку' })
    .click()
  await page.goto('/habits')
  await expect(page.getByRole('button', { name: 'Отметить: Зарядка' })).toBeVisible()

  // Taking the habit out of the grid removes its planned occurrences from the calendar.
  await api.del(`/habits/${id}/placement`)
  await page.goto('/')
  await expect(page.getByRole('button', { name: /^Зарядка/ })).toHaveCount(0)
})
