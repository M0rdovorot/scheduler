import { expect, test } from '@playwright/test'
import { apiLogin, createTask, freezeClock, resetData, type Api } from './helpers'

let api: Api

test.beforeEach(async ({ request, page }) => {
  api = await apiLogin(request)
  await resetData(api)
  await freezeClock(page)
})

async function category(name: string, color: string, parent_id: string | null = null) {
  return (await api.post('/categories', { name, color, parent_id })) as { id: string }
}

/** Moscow time on 2026-10-12 (Monday) / 13 / 14. */
async function seedWeek() {
  const work = await category('Работа', '#3b82f6')
  const sport = await category('Спорт', '#ef4444')
  const run = await category('Бег', '#f97316', sport.id)

  const job = await createTask(api, {
    title: 'Проект',
    start: '2026-10-12T06:00:00Z',
    end: '2026-10-12T09:00:00Z', // 09:00-12:00
    categoryIds: [work.id],
  })
  await api.post(`/instances/${job.id}/complete`, {})

  const jog = await createTask(api, {
    title: 'Пробежка',
    start: '2026-10-13T04:00:00Z',
    end: '2026-10-13T05:00:00Z',
    categoryIds: [run.id],
  })
  await api.patch(`/instances/${jog.id}/tracking`, {
    status: 'done',
    actual_start: '2026-10-13T04:20:00Z', // 20 minutes late
    actual_end: '2026-10-13T05:20:00Z',
  })

  const skipped = await createTask(api, {
    title: 'Чтение',
    start: '2026-10-13T10:00:00Z',
    end: '2026-10-13T11:00:00Z',
  })
  await api.patch(`/instances/${skipped.id}/tracking`, { status: 'not_done', comment: 'Устал' })
}

test('statistics of the week: totals, the category tree, the chart and deviations', async ({
  page,
}) => {
  await seedWeek()
  await page.goto('/stats')

  await expect(page.getByTestId('actual-total')).toHaveText('4 ч')
  await expect(page.getByTestId('period-label')).toContainText('12 – 18')

  // Work 3h; Sport includes Running 1h.
  const rows = page.getByTestId('category-rows').getByRole('listitem')
  await expect(rows).toHaveCount(3)
  await expect(rows.nth(0)).toContainText('Работа')
  await expect(rows.nth(0)).toContainText('3 ч')
  await expect(rows.nth(1)).toContainText('Спорт')
  await expect(rows.nth(1)).toContainText('1 ч')
  await expect(rows.nth(2)).toContainText('Бег')

  await expect(page.locator('[data-tile="late-starts"]')).toContainText('1')
  await expect(page.locator('[data-tile="not-done"]')).toContainText('1')
  await expect(page.getByTestId('deviation-rows')).toContainText('«Устал»')

  const chart = page.getByTestId('daily-chart')
  await expect(chart).toBeVisible()
  await expect(chart.locator('path, rect[fill]').first()).toBeVisible()
  await page.locator('[data-column="2026-10-12"]').hover()
  await expect(page.getByTestId('chart-tooltip')).toContainText('3 ч')
  await page.screenshot({ path: 'e2e/screenshots/stats-week.png', fullPage: true })

  await page.getByRole('button', { name: 'Таблица' }).click()
  await expect(page.getByTestId('chart-table')).toContainText('Работа')
})

test('switching the period asks for that period and an empty one says so', async ({ page }) => {
  await seedWeek()
  await page.goto('/stats')
  await expect(page.getByTestId('actual-total')).toHaveText('4 ч')

  await page.getByRole('button', { name: 'Следующий период' }).click()
  await expect(page.getByTestId('stats-empty')).toBeVisible()
  await expect(page.getByTestId('actual-total')).toHaveText('0 мин')

  await page.getByRole('button', { name: 'Предыдущий период' }).click()
  await page.getByRole('tab', { name: 'Месяц' }).click()
  await expect(page.getByTestId('actual-total')).toHaveText('4 ч')
})

test('a running timer is marked in the calendar and listed on its own page', async ({ page }) => {
  const { id } = await createTask(api, {
    title: 'Спорт',
    start: '2026-10-14T08:00:00Z',
    end: '2026-10-14T09:00:00Z',
  })
  await api.patch(`/instances/${id}/tracking`, {
    status: 'in_progress',
    actual_start: '2026-10-14T08:00:00Z',
  })

  await page.goto('/')
  const badge = page.getByRole('link', { name: 'Запущенные таймеры: 1' })
  await expect(badge).toBeVisible()
  await expect(page.locator('[data-running]').first()).toBeVisible()
  await page.screenshot({ path: 'e2e/screenshots/calendar-running.png' })

  await badge.click()
  await expect(page).toHaveURL(/\/timers$/)
  const card = page.locator(`[data-timer="${id}"]`)
  await expect(card).toContainText('Спорт')
  await expect(card.getByTestId('elapsed')).toHaveText(/^1:\d\d:\d\d$/)
  await page.screenshot({ path: 'e2e/screenshots/timers.png' })

  await card.getByRole('button', { name: 'Стоп' }).click()
  await expect(page.getByText('Нет запущенных таймеров')).toBeVisible()
})
