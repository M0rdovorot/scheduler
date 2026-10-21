import { expect, test } from '@playwright/test'
import {
  PPM_30,
  apiLogin,
  createTask,
  freezeClock,
  resetData,
  scrollGridTo,
  yAt,
  column,
  type Api,
} from './helpers'

let api: Api
const DAY = '2026-10-14'

test.beforeEach(async ({ request, page }) => {
  api = await apiLogin(request)
  await resetData(api)
  await freezeClock(page)
})

const mode = (page: import('@playwright/test').Page, name: 'План' | 'Факт' | 'Оба') =>
  page.getByRole('radiogroup', { name: 'Что показывать' }).getByRole('radio', { name })

test('the fact tab says what happened: the time, how it differs from the plan, and the plan', async ({
  page,
}) => {
  const { id } = await createTask(api, {
    title: 'Спорт',
    start: '2026-10-14T06:00:00Z', // 09:00–10:00
    end: '2026-10-14T07:00:00Z',
  })
  await api.patch(`/instances/${id}/tracking`, {
    actual_start: '2026-10-14T06:20:00Z', // 20 minutes late, 30 minutes over
    actual_end: '2026-10-14T07:30:00Z',
  })
  await page.goto('/')
  await mode(page, 'Факт').click()
  await scrollGridTo(page, 8 * 60, PPM_30, 10)
  const block = page.getByRole('button', { name: /^Спорт, 09:20–10:30, факт/ })
  const lines = block.locator('[data-detail]')
  await expect(lines).toHaveText([
    '09:20–10:30',
    'начало +20 мин · конец +30 мин',
    'план 09:00–10:00',
  ])
  await page.screenshot({ path: 'e2e/screenshots/fact-day.png' })

  // Three days: narrower, but the facts and the difference are still there.
  await page.getByRole('radio', { name: '3 дня' }).click()
  await scrollGridTo(page, 8 * 60, PPM_30, 10)
  await expect(
    page
      .getByRole('button', { name: /^Спорт, 09:20–10:30, факт/ })
      .locator('[data-detail]')
      .first(),
  ).toHaveText('09:20–10:30')
  await page.screenshot({ path: 'e2e/screenshots/fact-three-days.png' })
})

test('dragging over the grid in the fact tab adds a fact, not a plan', async ({ page }) => {
  await page.goto('/')
  await mode(page, 'Факт').click()
  await scrollGridTo(page, 9 * 60, PPM_30, 40)
  const col = (await column(page, DAY).boundingBox())!
  const x = col.x + col.width / 2
  await page.mouse.move(x, await yAt(page, DAY, 10 * 60 + 5, PPM_30))
  await page.mouse.down()
  await page.mouse.move(x, await yAt(page, DAY, 10 * 60 + 40, PPM_30), { steps: 4 })
  await page.mouse.move(x, await yAt(page, DAY, 11 * 60 + 5, PPM_30), { steps: 4 })
  await page.mouse.up()

  const dialog = page.getByRole('dialog', { name: 'Дело вне плана' })
  await expect(dialog.getByLabel('Началось')).toHaveValue('2026-10-14T10:00')
  await expect(dialog.getByLabel('Закончилось')).toHaveValue('2026-10-14T11:30')
  await dialog.getByLabel('Название').fill('Звонок')
  await dialog.getByRole('button', { name: 'Добавить' }).click()
  await expect(dialog).toHaveCount(0)

  const block = page.getByRole('button', { name: /^Звонок, 10:00–11:30, факт/ })
  await expect(block).toHaveAttribute('data-kind', 'unplanned')
  // It is in the fact, and so not on the plan tab.
  await mode(page, 'План').click()
  await expect(page.getByRole('button', { name: /^Звонок/ })).toHaveCount(0)
})

test('the "+" button adds a fact in the fact tab and a plan elsewhere', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Новое дело' }).click()
  await expect(page.getByRole('dialog', { name: 'Новое дело' })).toBeVisible()
  await page.getByRole('dialog').getByRole('button', { name: 'Закрыть' }).click()

  await mode(page, 'Факт').click()
  await page.getByRole('button', { name: 'Новое дело в факте' }).click()
  const dialog = page.getByRole('dialog', { name: 'Дело вне плана' })
  await expect(dialog.getByLabel('Началось')).toHaveValue('2026-10-14T11:30')
  await dialog.getByLabel('Название').fill('Чтение')
  await dialog.getByRole('button', { name: 'Добавить' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^Чтение, 11:30–12:00, факт/ })).toBeVisible()
})

test('every sheet can be closed with its own button', async ({ page }) => {
  await api.post('/categories', { name: 'Работа', color: '#3b82f6' })
  const habit = (await api.post('/habits', {
    title: 'Вода',
    kind: 'boolean',
    frequency: 'daily',
    color: '#06b6d4',
  })) as { id: string }
  await createTask(api, {
    title: 'Планёрка',
    start: '2026-10-14T06:00:00Z',
    end: '2026-10-14T07:00:00Z',
  })

  const closeTop = async () => {
    await page.getByRole('button', { name: 'Закрыть' }).last().click()
  }
  const sheets = page.getByRole('dialog')

  // The card of a task, and the sheets that open from it.
  await page.goto('/')
  await page.getByRole('button', { name: /^Планёрка/ }).click()
  await expect(sheets).toHaveCount(1)
  await page
    .getByRole('dialog', { name: 'Дело' })
    .getByRole('button', { name: 'Напоминания' })
    .click()
  await expect(sheets).toHaveCount(2)
  await closeTop()
  await expect(sheets).toHaveCount(1)
  await page.getByRole('dialog', { name: 'Дело' }).getByRole('button', { name: 'Удалить' }).click()
  await expect(sheets).toHaveCount(2)
  await closeTop()
  await closeTop()
  await expect(sheets).toHaveCount(0)

  // The task outside the plan, from the menu.
  await page.getByRole('button', { name: 'Меню' }).click()
  await page.getByRole('button', { name: 'Дело вне плана' }).click()
  await expect(sheets).toHaveCount(1)
  await closeTop()
  await expect(sheets).toHaveCount(0)

  // Categories and habits.
  await page.goto('/categories')
  await page
    .getByRole('button', { name: /Работа/ })
    .first()
    .click()
  await expect(sheets).toHaveCount(1)
  await closeTop()
  await expect(sheets).toHaveCount(0)
  await page.getByRole('button', { name: '+ Категория' }).click()
  await closeTop()
  await expect(sheets).toHaveCount(0)

  await page.goto(`/habits/${habit.id}`)
  await page.getByRole('button', { name: 'Изменить' }).click()
  await expect(sheets).toHaveCount(1)
  await closeTop()
  await page.getByRole('button', { name: 'Удалить' }).click()
  await expect(sheets).toHaveCount(1)
  await closeTop()
  await expect(sheets).toHaveCount(0)
})
