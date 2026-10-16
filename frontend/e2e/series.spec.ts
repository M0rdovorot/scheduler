import { expect, test } from '@playwright/test'
import { apiLogin, column, freezeClock, resetData, type Api } from './helpers'

let api: Api

test.beforeEach(async ({ page, request }) => {
  api = await apiLogin(request)
  await resetData(api)
  await freezeClock(page)
})

async function createWeeklyThroughTheForm(page: import('@playwright/test').Page, title: string) {
  await page.goto('/')
  await page.getByRole('button', { name: 'Новое дело' }).click()
  const form = page.getByRole('dialog', { name: 'Новое дело' })
  await form.getByLabel('Название').fill(title)
  await form.getByLabel('Повтор').selectOption('weekly')
  await expect(form.getByTestId('repeat-summary')).toHaveText('Еженедельно: ср')
  await form.getByRole('button', { name: 'Создать' }).click()
  await expect(form).toBeHidden()
}

test('a weekly task appears in every week, created lazily as weeks are opened', async ({
  page,
}) => {
  await createWeeklyThroughTheForm(page, 'Планёрка')
  await page.getByRole('radio', { name: 'Неделя' }).click()

  const thisWeek = column(page, '2026-10-14').getByRole('button', { name: /Планёрка/ })
  await expect(thisWeek).toBeVisible()
  await expect(thisWeek.locator('[data-repeat]')).toBeVisible() // the ↻ mark
  await expect(page.getByRole('button', { name: /Планёрка/ })).toHaveCount(1)

  // (That nothing is created ahead of the windows that are opened is checked in the Go tests:
  // asking the API for a long range would itself create the occurrences.)
  await page.getByRole('button', { name: 'Вперёд' }).click()
  await expect(column(page, '2026-10-21').getByRole('button', { name: /Планёрка/ })).toBeVisible()
  await page.getByRole('button', { name: 'Вперёд' }).click()
  await expect(column(page, '2026-10-28').getByRole('button', { name: /Планёрка/ })).toBeVisible()
  await page.screenshot({ path: 'e2e/screenshots/series-week.png' })

  // Half a year ahead works the same, without anything created in between.
  await page.getByLabel('Выбрать дату').fill('2027-04-14')
  await expect(column(page, '2027-04-14').getByRole('button', { name: /Планёрка/ })).toBeVisible()
})

test('editing "this and following" splits the series', async ({ page }) => {
  await createWeeklyThroughTheForm(page, 'Планёрка')
  await page.getByRole('radio', { name: 'Неделя' }).click()
  await page.getByRole('button', { name: 'Вперёд' }).click() // week of 10-19

  await column(page, '2026-10-21')
    .getByRole('button', { name: /Планёрка/ })
    .click()
  const form = page.getByRole('dialog', { name: 'Дело' })
  await expect(form.getByLabel('Повтор')).toHaveValue('weekly')
  await form.getByLabel('Название').fill('Стендап')
  await form.getByRole('button', { name: 'Сохранить', exact: true }).click()

  const scope = page.getByRole('dialog', { name: 'Применить изменения' })
  await scope.getByRole('button', { name: 'Это и следующие' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)

  // From the 21st on the new title; the occurrence of the 14th is unchanged.
  await expect(column(page, '2026-10-21').getByRole('button', { name: /Стендап/ })).toBeVisible()
  await page.getByRole('button', { name: 'Вперёд' }).click()
  await expect(column(page, '2026-10-28').getByRole('button', { name: /Стендап/ })).toBeVisible()
  await page.getByRole('button', { name: 'Сегодня' }).click()
  await expect(column(page, '2026-10-14').getByRole('button', { name: /Планёрка/ })).toBeVisible()
})

test('deleting one occurrence keeps it deleted; deleting all removes the series', async ({
  page,
}) => {
  await createWeeklyThroughTheForm(page, 'Планёрка')
  await page.getByRole('radio', { name: 'Неделя' }).click()
  await page.getByRole('button', { name: 'Вперёд' }).click()

  // Only the occurrence of the 21st.
  await column(page, '2026-10-21')
    .getByRole('button', { name: /Планёрка/ })
    .click()
  await page.getByRole('dialog', { name: 'Дело' }).getByRole('button', { name: 'Удалить' }).click()
  const scope = page.getByRole('dialog', { name: 'Удалить повторяющееся дело' })
  await scope.getByRole('button', { name: 'Только это дело' }).click()
  await expect(column(page, '2026-10-21').getByRole('button', { name: /Планёрка/ })).toHaveCount(0)

  // Another week and back: the deleted occurrence does not come back.
  await page.getByRole('button', { name: 'Вперёд' }).click()
  await expect(column(page, '2026-10-28').getByRole('button', { name: /Планёрка/ })).toBeVisible()
  await page.getByRole('button', { name: 'Назад' }).click()
  await expect(column(page, '2026-10-21')).toBeVisible()
  await expect(column(page, '2026-10-21').getByRole('button', { name: /Планёрка/ })).toHaveCount(0)
  await page.reload()
  await page.getByRole('radio', { name: 'Неделя' }).click()
  await page.getByRole('button', { name: 'Вперёд' }).click()
  await expect(column(page, '2026-10-21').getByRole('button', { name: /Планёрка/ })).toHaveCount(0)

  // All of them.
  await page.getByRole('button', { name: 'Вперёд' }).click()
  await column(page, '2026-10-28')
    .getByRole('button', { name: /Планёрка/ })
    .click()
  await page.getByRole('dialog', { name: 'Дело' }).getByRole('button', { name: 'Удалить' }).click()
  await page
    .getByRole('dialog', { name: 'Удалить повторяющееся дело' })
    .getByRole('button', { name: 'Все дела серии' })
    .click()
  await expect(page.getByRole('button', { name: /Планёрка/ })).toHaveCount(0)
  await page.getByRole('button', { name: 'Сегодня' }).click()
  await expect(page.getByRole('button', { name: /Планёрка/ })).toHaveCount(0)
})

test('the date of a series cannot be moved, but one occurrence can', async ({ page }) => {
  await createWeeklyThroughTheForm(page, 'Планёрка')
  await page.getByRole('button', { name: /Планёрка/ }).click()
  const form = page.getByRole('dialog', { name: 'Дело' })
  await expect(form.getByLabel('Повтор')).toHaveValue('weekly')
  await form.getByLabel('Конец').fill('2026-10-15T13:00')
  await form.getByLabel('Начало').fill('2026-10-15T12:00')
  await form.getByRole('button', { name: 'Сохранить', exact: true }).click()

  const scope = page.getByRole('dialog', { name: 'Применить изменения' })
  await expect(scope.getByRole('button', { name: 'Все дела серии' })).toBeDisabled()
  await expect(scope.getByRole('button', { name: 'Это и следующие' })).toBeDisabled()
  await scope.getByRole('button', { name: 'Только это дело' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)

  await page.getByRole('button', { name: 'Вперёд' }).click()
  await expect(column(page, '2026-10-15').getByRole('button', { name: /Планёрка/ })).toBeVisible()
})
