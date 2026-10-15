import { expect, test } from '@playwright/test'
import {
  PPM_30,
  apiLogin,
  column,
  createTask,
  freezeClock,
  resetData,
  scrollGridTo,
  type Api,
} from './helpers'

let api: Api

test.beforeEach(async ({ page, request }) => {
  api = await apiLogin(request)
  await resetData(api)
  await freezeClock(page)
})

test('overlapping tasks share the column width without covering each other', async ({ page }) => {
  await createTask(api, {
    title: 'Первое',
    start: '2026-10-14T07:00:00Z',
    end: '2026-10-14T09:30:00Z',
  })
  await createTask(api, {
    title: 'Второе',
    start: '2026-10-14T08:00:00Z',
    end: '2026-10-14T10:00:00Z',
  })
  await createTask(api, {
    title: 'Третье',
    start: '2026-10-14T08:30:00Z',
    end: '2026-10-14T09:00:00Z',
  })
  await createTask(api, {
    title: 'Одно',
    start: '2026-10-14T11:00:00Z',
    end: '2026-10-14T12:00:00Z',
  })
  await page.goto('/')
  await scrollGridTo(page, 10 * 60, PPM_30)

  const box = async (name: RegExp) => (await page.getByRole('button', { name }).boundingBox())!
  const [a, b, c, alone] = [
    await box(/Первое/),
    await box(/Второе/),
    await box(/Третье/),
    await box(/Одно/),
  ]
  const col = (await column(page, '2026-10-14').boundingBox())!

  // Three tasks overlap at 11:30: each gets a third of the column.
  // (The column's 1px left border and the 2px gaps make exact equality meaningless: allow 2px.)
  const near = (actual: number, expected: number) =>
    expect(Math.abs(actual - expected)).toBeLessThanOrEqual(2)
  for (const t of [a, b, c]) near(t.width, col.width / 3 - 2)
  // No two of them overlap on screen.
  const overlap = (p: typeof a, q: typeof a) =>
    p.x < q.x + q.width && q.x < p.x + p.width && p.y < q.y + q.height && q.y < p.y + p.height
  expect(overlap(a, b)).toBe(false)
  expect(overlap(a, c)).toBe(false)
  expect(overlap(b, c)).toBe(false)
  // A task alone in its time takes the whole column.
  near(alone.width, col.width - 2)
  await page.screenshot({ path: 'e2e/screenshots/overlap.png' })
})

test('a task across midnight is drawn on both days', async ({ page }) => {
  await createTask(api, {
    title: 'Ночная смена',
    start: '2026-10-14T19:00:00Z',
    end: '2026-10-15T03:00:00Z',
  })
  await page.goto('/')
  await page.getByRole('radio', { name: '3 дня' }).click()

  const day1 = column(page, '2026-10-14').getByRole('button', { name: /Ночная смена/ })
  const day2 = column(page, '2026-10-15').getByRole('button', { name: /Ночная смена/ })
  await expect(day1).toHaveAccessibleName('Ночная смена, 22:00–24:00')
  await expect(day2).toHaveAccessibleName('Ночная смена, 00:00–06:00')

  // The first part ends exactly at the bottom of the day, the second starts at the top.
  const col1 = (await column(page, '2026-10-14').boundingBox())!
  const col2 = (await column(page, '2026-10-15').boundingBox())!
  const a = (await day1.boundingBox())!
  const b = (await day2.boundingBox())!
  expect(a.y + a.height + 1).toBeCloseTo(col1.y + col1.height, 0)
  expect(b.y).toBeCloseTo(col2.y, 0)
  await page.screenshot({ path: 'e2e/screenshots/midnight.png', fullPage: false })
})

test('creates, recolors by category, edits and deletes a task through the forms', async ({
  page,
}) => {
  const sport = (await api.post('/categories', { name: 'Спорт', color: '#ef4444' })) as {
    id: string
  }
  await page.goto('/')

  // Create with the "+" button, choosing a category.
  await page.getByRole('button', { name: 'Новое дело' }).click()
  const form = page.getByRole('dialog', { name: 'Новое дело' })
  await form.getByLabel('Название').fill('Зал')
  await form.getByRole('checkbox', { name: /Спорт/ }).check()
  await form.getByRole('button', { name: 'Создать' }).click()

  const block = page.getByRole('button', { name: /^Зал, / })
  await expect(block).toBeVisible()
  await expect(block).toHaveCSS('border-left-color', 'rgb(239, 68, 68)')
  void sport

  // Edit: rename and make it longer.
  await block.click()
  const edit = page.getByRole('dialog', { name: 'Дело' })
  await expect(edit.getByRole('checkbox', { name: /Спорт/ })).toBeChecked()
  await edit.getByLabel('Название').fill('Тренировка')
  await edit.getByLabel('Конец').fill('2026-10-14T14:30')
  await edit.getByRole('button', { name: 'Сохранить' }).click()
  await expect(page.getByRole('button', { name: 'Тренировка, 12:00–14:30' })).toBeVisible()

  // Delete needs a confirmation.
  await page.getByRole('button', { name: /Тренировка/ }).click()
  await page.getByRole('dialog', { name: 'Дело' }).getByRole('button', { name: 'Удалить' }).click()
  const confirm = page.getByRole('dialog', { name: 'Удалить дело?' })
  await confirm.getByRole('button', { name: 'Отмена' }).click()
  await expect(page.getByRole('button', { name: /Тренировка/ })).toBeVisible()
  await page.getByRole('dialog', { name: 'Дело' }).getByRole('button', { name: 'Удалить' }).click()
  await confirm.getByRole('button', { name: 'Удалить' }).click()
  await expect(page.getByRole('button', { name: /Тренировка/ })).toHaveCount(0)
})

test('pages through weeks and picks a date', async ({ page }) => {
  await createTask(api, {
    title: 'На следующей неделе',
    start: '2026-10-21T09:00:00Z',
    end: '2026-10-21T10:00:00Z',
  })
  await page.goto('/')
  await page.getByRole('radio', { name: 'Неделя' }).click()
  await expect(page.getByRole('button', { name: /На следующей неделе/ })).toHaveCount(0)

  await page.getByRole('button', { name: 'Вперёд' }).click()
  await expect(page.getByRole('button', { name: /На следующей неделе/ })).toBeVisible()
  await page.getByRole('button', { name: 'Сегодня' }).click()
  await expect(column(page, '2026-10-14')).toBeVisible()

  await page.getByLabel('Выбрать дату').fill('2027-03-03')
  await expect(column(page, '2027-03-01')).toBeVisible() // Monday of that week
  await expect(page.getByRole('heading', { level: 1 })).toContainText('2027')
})

test('the dark theme follows the system', async ({ page }) => {
  await createTask(api, {
    title: 'Обед',
    start: '2026-10-14T09:00:00Z',
    end: '2026-10-14T10:00:00Z',
  })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.goto('/')
  await expect(page.getByRole('button', { name: /Обед/ })).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.screenshot({ path: 'e2e/screenshots/dark.png' })
})

test('week view with 5-minute slots and 300 tasks stays light (NFR-4)', async ({ page }) => {
  test.setTimeout(120_000)
  await api.patch('/me/settings', { slot_minutes: 5, default_view: 'week' })
  const start = Date.parse('2026-10-12T00:00:00+03:00')
  for (let i = 0; i < 300; i++) {
    const begin = start + ((i * 97) % (7 * 24 * 60)) * 60_000
    await createTask(api, {
      title: `Дело ${i}`,
      start: new Date(begin).toISOString(),
      end: new Date(begin + (15 + (i % 8) * 15) * 60_000).toISOString(),
    })
  }

  await page.goto('/')
  await expect(column(page, '2026-10-18')).toBeVisible()
  await expect(page.getByRole('button', { name: /^Дело \d+, / }).first()).toBeVisible()

  // Slot lines are a CSS background: the DOM does not grow with the number of slots
  // (a week of 5-minute slots would be 2016 elements).
  const stats = await page.evaluate(() => ({
    elements: document.querySelectorAll('*').length,
    columns: document.querySelectorAll('[data-day]').length,
    tasks: document.querySelectorAll('[data-task]').length,
    background: getComputedStyle(document.querySelector('[data-day]')!).backgroundImage.includes(
      'linear-gradient',
    ),
  }))
  console.log('DOM stats', JSON.stringify(stats))
  expect(stats.columns).toBe(7)
  expect(stats.background).toBe(true)
  // Tasks of a 7-day window are drawn per day segment; nothing per slot.
  expect(stats.elements).toBeLessThan(stats.tasks * 6 + 400)

  // Scroll the whole day top to bottom and watch the frame times.
  const frames = await page.evaluate(async () => {
    const scroller = document.querySelector('[data-day]')!.parentElement!.parentElement!
    const gaps: number[] = []
    let last = performance.now()
    const total = scroller.scrollHeight
    await new Promise<void>((resolve) => {
      let y = 0
      const step = () => {
        const now = performance.now()
        gaps.push(now - last)
        last = now
        y += total / 90
        scroller.scrollTop = y
        if (y < total) requestAnimationFrame(step)
        else resolve()
      }
      requestAnimationFrame(step)
    })
    gaps.sort((a, b) => a - b)
    return {
      count: gaps.length,
      median: gaps[Math.floor(gaps.length / 2)]!,
      p95: gaps[Math.floor(gaps.length * 0.95)]!,
      max: gaps.at(-1)!,
    }
  })
  console.log('scroll frames (ms)', JSON.stringify(frames))
  // Software rendering in headless Chromium is slow; this catches only gross regressions.
  expect(frames.median).toBeLessThan(40)
  expect(frames.p95).toBeLessThan(120)
  await page.screenshot({ path: 'e2e/screenshots/week-5min.png' })
})
