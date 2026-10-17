import { expect, test } from '@playwright/test'
import { apiLogin, createTask, freezeClock, resetData, type Api } from './helpers'

let api: Api

test.beforeEach(async ({ request, page }) => {
  api = await apiLogin(request)
  await resetData(api)
  await freezeClock(page)
})

test('global reminders: quiet hours and the list of reminders are kept', async ({ page }) => {
  await page.goto('/settings')
  const section = page.getByRole('region', { name: 'Напоминания' })
  await expect(section.getByRole('checkbox', { name: 'Присылать напоминания' })).toBeChecked()
  await expect(section.getByTestId('rules').getByRole('listitem')).toHaveCount(2)

  await section.getByRole('checkbox', { name: 'Тихие часы' }).check()
  await section.getByRole('button', { name: '+ Напоминание' }).click()
  const added = section.getByTestId('rules').getByRole('listitem').nth(2)
  await added.getByRole('combobox', { name: 'Вид напоминания' }).selectOption('not_started')
  await added.getByRole('textbox', { name: 'Сколько' }).fill('15')
  await page.screenshot({ path: 'e2e/screenshots/reminders-settings.png', fullPage: true })
  await section.getByRole('button', { name: 'Сохранить напоминания' }).click()
  await expect(section.getByText('Сохранено')).toBeVisible()

  await page.reload()
  const after = page.getByRole('region', { name: 'Напоминания' })
  await expect(after.getByLabel('Тихие часы с')).toHaveValue('23:00')
  await expect(after.getByLabel('Тихие часы до')).toHaveValue('08:00')
  await expect(after.getByTestId('rules').getByRole('listitem')).toHaveCount(3)

  const saved = (await api.get('/reminders/global')) as {
    quiet_hours: { start: string; end: string }
    rules: { kind: string; offset_minutes: number }[]
  }
  expect(saved.quiet_hours).toEqual({ start: '23:00', end: '08:00' })
  expect(saved.rules.some((r) => r.kind === 'not_started' && r.offset_minutes === 15)).toBe(true)
})

test('a category gets reminders of its own and a task inherits them', async ({ page }) => {
  const cat = (await api.post('/categories', { name: 'Работа', color: '#3b82f6' })) as {
    id: string
  }
  await createTask(api, {
    title: 'Планёрка',
    start: '2026-10-14T06:00:00Z',
    end: '2026-10-14T07:00:00Z',
    categoryIds: [cat.id],
  })

  await page.goto('/categories')
  await page
    .getByRole('button', { name: /Работа/ })
    .first()
    .click()
  await page
    .getByRole('dialog', { name: 'Категория' })
    .getByRole('button', { name: 'Напоминания' })
    .click()
  const dialog = page.getByRole('dialog', { name: 'Напоминания: Работа' })
  await dialog.getByRole('radio', { name: 'Свои напоминания' }).check()
  const first = dialog.getByTestId('rules').getByRole('listitem').first()
  await first.getByRole('textbox', { name: 'Сколько' }).fill('1')
  await first.getByRole('combobox', { name: 'Единица' }).selectOption('hour')
  await page.screenshot({ path: 'e2e/screenshots/reminders-level.png' })
  await dialog.getByRole('button', { name: 'Сохранить' }).click()
  await expect(dialog).toHaveCount(0)

  // The task of the category now inherits it: the card says where its reminders come from.
  await page.goto('/')
  await page.getByRole('button', { name: /^Планёрка/ }).click()
  await page
    .getByRole('dialog', { name: 'Дело' })
    .getByRole('button', { name: 'Напоминания' })
    .click()
  const task = page.getByRole('dialog', { name: 'Напоминания: Планёрка' })
  await expect(task.getByTestId('effective')).toContainText('настройки категории')
  await expect(task.getByTestId('effective')).toContainText('Через 1 час после окончания')

  // Switched off for this task only.
  await task.getByRole('radio', { name: 'Без напоминаний' }).check()
  await task.getByRole('button', { name: 'Сохранить' }).click()
  await expect(task).toHaveCount(0)
  const level = (await api.get(`/reminders/category/${cat.id}`)) as {
    override: { enabled: boolean }
  }
  expect(level.override.enabled).toBe(true)
})
