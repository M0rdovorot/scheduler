import { expect, test, type Page } from '@playwright/test'
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

test.beforeEach(async ({ request }) => {
  api = await apiLogin(request)
  await resetData(api)
})

const DAY = '2026-10-14'

/** A done task 09:00-10:00 (plan) with the fact 09:20-10:30, Moscow time. */
async function seedDoneLate() {
  const { id } = await createTask(api, {
    title: 'Спорт',
    start: '2026-10-14T06:00:00Z',
    end: '2026-10-14T07:00:00Z',
  })
  await api.patch(`/instances/${id}/tracking`, {
    actual_start: '2026-10-14T06:20:00Z',
    actual_end: '2026-10-14T07:30:00Z',
  })
  return id
}

const mode = (page: Page, name: 'План' | 'Факт' | 'Оба') =>
  page.getByRole('radiogroup', { name: 'Что показывать' }).getByRole('radio', { name })

test.describe('with a frozen clock (12:00)', () => {
  test.beforeEach(async ({ page }) => {
    await freezeClock(page)
  })

  test('the plan, the fact and both are drawn at the right places', async ({ page }) => {
    await seedDoneLate()
    await api.post('/instances/unplanned', {
      title: 'Звонок',
      actual_start: '2026-10-14T05:00:00Z', // 08:00
      actual_end: '2026-10-14T05:30:00Z',
    })
    await createTask(api, {
      title: 'Забыл',
      start: '2026-10-14T03:00:00Z',
      end: '2026-10-14T04:00:00Z',
    }) // 06:00-07:00, never marked
    const { id: movedId } = await createTask(api, {
      title: 'Перенёс',
      start: '2026-10-14T01:00:00Z',
      end: '2026-10-14T02:00:00Z',
    }) // 04:00-05:00
    await api.post(`/instances/${movedId}/reschedule`, {
      planned_start: '2026-10-15T01:00:00Z',
      planned_end: '2026-10-15T02:00:00Z',
      comment: 'совещание',
    })

    await page.goto('/')
    await scrollGridTo(page, 5 * 60, PPM_30, 10)
    const col = (await column(page, DAY).boundingBox())!
    const topOf = async (name: RegExp) =>
      ((await page.getByRole('button', { name }).first().boundingBox())!.y - col.y) / PPM_30

    // Both (the default): the plan block at 09:00 and, beside it, the fact stripe from 09:20 to 10:30.
    const plan = page.getByRole('button', { name: /^Спорт, 09:00–10:00/ })
    await expect(plan).toBeVisible()
    expect(await topOf(/^Спорт, 09:00–10:00/)).toBeCloseTo(540, 0)
    const stripe = page.locator('[data-fact-stripe]')
    await expect(stripe).toHaveCount(1)
    const s = (await stripe.boundingBox())!
    const p = (await plan.boundingBox())!
    expect((s.y - col.y) / PPM_30).toBeCloseTo(560, 0)
    expect(s.height / PPM_30).toBeCloseTo(70, 0)
    expect(s.x).toBeGreaterThanOrEqual(p.x) // at the left edge of the block
    expect(s.x).toBeLessThan(p.x + 10)
    // The unplanned task is hatched; the unmarked one is outlined and marked with "?".
    await expect(page.getByRole('button', { name: /Звонок/ })).toHaveAttribute(
      'data-kind',
      'unplanned',
    )
    await expect(page.getByRole('button', { name: /Забыл/ })).toHaveAttribute(
      'data-unmarked',
      'true',
    )
    await expect(page.getByRole('button', { name: /Перенёс/ })).toHaveAttribute(
      'data-status',
      'rescheduled',
    )
    await page.screenshot({ path: 'e2e/screenshots/tracking-both.png' })

    // Plan only: no stripe, no unplanned task.
    await mode(page, 'План').click()
    await expect(page.locator('[data-fact-stripe]')).toHaveCount(0)
    await expect(page.getByRole('button', { name: /Звонок/ })).toHaveCount(0)
    await expect(page.getByRole('button', { name: /Спорт/ })).toHaveAttribute('data-kind', 'plan')
    await page.screenshot({ path: 'e2e/screenshots/tracking-plan.png' })

    // Fact only: the block sits where it really happened, and planned-but-unmarked tasks are gone.
    await mode(page, 'Факт').click()
    expect(await topOf(/^Спорт/)).toBeCloseTo(560, 0)
    await expect(page.getByRole('button', { name: /Спорт, 09:20–10:30/ })).toHaveAttribute(
      'data-kind',
      'fact',
    )
    await expect(page.getByRole('button', { name: /Звонок/ })).toBeVisible()
    await expect(page.getByRole('button', { name: /Забыл/ })).toHaveCount(0)
    await page.screenshot({ path: 'e2e/screenshots/tracking-fact.png' })
  })

  test('the week offers the plan and the fact only', async ({ page }) => {
    await seedDoneLate()
    await page.goto('/')
    await page.getByRole('radio', { name: 'Неделя' }).click()

    const modes = page.getByRole('radiogroup', { name: 'Что показывать' }).getByRole('radio')
    await expect(modes).toHaveText(['План', 'Факт'])
    await expect(mode(page, 'План')).toBeChecked()
    await expect(page.locator('[data-fact-stripe]')).toHaveCount(0)
    await mode(page, 'Факт').click()
    await expect(page.getByRole('button', { name: /Спорт, 09:20–10:30/ })).toBeVisible()
    await page.screenshot({ path: 'e2e/screenshots/tracking-week-fact.png' })

    // Back to a day: "both" is still the choice there.
    await page.getByRole('radio', { name: 'День' }).click()
    await mode(page, 'Факт').click() // the week choice carried over
    await mode(page, 'Оба').click()
    await expect(page.locator('[data-fact-stripe]')).toHaveCount(1)
  })

  test('one tap marks a task done, and the mark can be removed', async ({ page }) => {
    await createTask(api, {
      title: 'Бег',
      start: '2026-10-14T06:00:00Z',
      end: '2026-10-14T07:00:00Z',
    })
    await page.goto('/')
    await page.getByRole('button', { name: /^Бег/ }).click()
    const card = page.getByRole('dialog', { name: 'Дело' })
    await expect(card.getByTestId('status')).toContainText('Запланировано')
    await expect(card.getByText('не отмечено')).toBeVisible()
    await page.screenshot({ path: 'e2e/screenshots/tracking-card.png' })

    await card.getByRole('button', { name: 'Выполнено' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    const block = page.getByRole('button', { name: /^Бег.*Выполнено/ })
    await expect(block).toHaveAttribute('data-status', 'done')
    await expect(block.locator('[data-mark]')).toHaveText('✓')

    await block.click()
    await page
      .getByRole('dialog', { name: 'Дело' })
      .getByRole('button', { name: 'Снять отметку' })
      .click()
    await expect(page.getByRole('button', { name: /^Бег/ })).toHaveAttribute(
      'data-status',
      'planned',
    )
  })

  test('edits the fact by hand and shows the deviations', async ({ page }) => {
    await createTask(api, {
      title: 'Бег',
      start: '2026-10-14T06:00:00Z',
      end: '2026-10-14T07:00:00Z',
    })
    await page.goto('/')
    await page.getByRole('button', { name: /^Бег/ }).click()
    const card = page.getByRole('dialog', { name: 'Дело' })

    await card.getByRole('button', { name: 'Править факт' }).click()
    await card.getByLabel('Начало факта').fill('2026-10-14T09:25')
    await card.getByLabel('Конец факта').fill('2026-10-14T10:20')
    await card.getByRole('button', { name: 'Сохранить факт' }).click()

    // The card stays open and now shows what happened: 25 minutes late, 20 minutes over.
    await expect(card.getByTestId('status')).toContainText('Выполнено')
    await expect(card.getByTestId('fact')).toHaveText('09:25–10:20')
    const deviations = card.getByRole('list', { name: 'Отклонения' })
    await expect(deviations).toContainText('Начали позже на 25 мин')
    await expect(deviations).toContainText('Закончили позже на 20 мин (затянулось)')

    await card.getByLabel(/Комментарий/).fill('пробки')
    await card.getByRole('button', { name: 'Сохранить комментарий' }).click()
    await expect(card.getByRole('button', { name: 'Сохранить комментарий' })).toBeDisabled()
    expect(
      (
        (await api.get('/instances?from=2026-10-14T00:00:00Z&to=2026-10-15T00:00:00Z')) as {
          comment: string
        }[]
      )[0]?.comment,
    ).toBe('пробки')
  })

  test('reschedules a task and follows the link', async ({ page }) => {
    await createTask(api, {
      title: 'Планёрка',
      start: '2026-10-14T06:00:00Z',
      end: '2026-10-14T07:00:00Z',
    })
    await page.goto('/')
    await page.getByRole('button', { name: /^Планёрка/ }).click()
    await page
      .getByRole('dialog', { name: 'Дело' })
      .getByRole('button', { name: 'Перенести' })
      .click()

    const form = page.getByRole('dialog', { name: 'Перенести дело' })
    await expect(form.getByLabel('Новое начало')).toHaveValue('2026-10-15T09:00')
    await form.getByLabel('Причина').fill('совещание')
    await form.getByRole('button', { name: 'Перенести' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)

    // The original stays, muted and crossed out.
    const original = page.getByRole('button', { name: /^Планёрка.*Перенесено/ })
    await expect(original).toHaveAttribute('data-status', 'rescheduled')
    await page.screenshot({ path: 'e2e/screenshots/tracking-rescheduled.png' })

    await original.click()
    const card = page.getByRole('dialog', { name: 'Дело' })
    await expect(card.getByText(/Перенесено на/)).toBeVisible()
    // The reason is shown as text: a rescheduled task is history and is not edited any more.
    await expect(card.getByText('совещание')).toBeVisible()
    await card.getByRole('button', { name: 'Перейти' }).click()

    // On the new day: the new task, linked back.
    await expect(column(page, '2026-10-15')).toBeVisible()
    await page.getByRole('button', { name: /^Планёрка, 09:00–10:00$/ }).click()
    await expect(page.getByRole('dialog', { name: 'Дело' }).getByText(/Перенесено с/)).toBeVisible()
  })

  test('adds a task outside the plan, back-dated', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: 'Меню' }).click()
    await page.getByRole('button', { name: 'Дело вне плана' }).click()
    const form = page.getByRole('dialog', { name: 'Дело вне плана' })
    await form.getByLabel('Название').fill('Звонок маме')
    await form.getByLabel('Добавить задним числом').check()
    await expect(form.getByLabel('Началось')).toHaveValue('2026-10-14T11:30')
    await form.getByRole('button', { name: 'Добавить' }).click()

    const block = page.getByRole('button', { name: /Звонок маме/ })
    await expect(block).toHaveAttribute('data-kind', 'unplanned')
    await mode(page, 'План').click()
    await expect(page.getByRole('button', { name: /Звонок маме/ })).toHaveCount(0)
  })

  test('deleting a marked task warns about the fact', async ({ page }) => {
    await seedDoneLate()
    await page.goto('/')
    await page.getByRole('button', { name: /^Спорт/ }).click()
    await page
      .getByRole('dialog', { name: 'Дело' })
      .getByRole('button', { name: 'Удалить' })
      .click()
    const confirm = page.getByRole('dialog', { name: 'Удалить дело?' })
    await expect(confirm.getByTestId('marked-warning')).toContainText('вместе с фактом')
    await confirm.getByRole('button', { name: 'Удалить' }).click()
    await expect(page.getByRole('button', { name: /^Спорт/ })).toHaveCount(0)
  })
})

// The timer uses the server's clock, so this runs in real time and looks at "today".
test('a timer: start, see it running, stop', async ({ page }) => {
  const now = Date.now()
  await createTask(api, {
    title: 'Таймер',
    start: new Date(now - 30 * 60_000).toISOString(),
    end: new Date(now + 30 * 60_000).toISOString(),
  })
  await page.goto('/')
  await page.getByRole('button', { name: /^Таймер/ }).click()
  await page.getByRole('dialog', { name: 'Дело' }).getByRole('button', { name: 'Старт' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)

  const block = page.getByRole('button', { name: /^Таймер/ }).first()
  await expect(block).toHaveAttribute('data-status', 'in_progress')
  await expect(page.locator('[data-fact-stripe]')).toHaveCount(1)

  await block.click()
  const card = page.getByRole('dialog', { name: 'Дело' })
  await expect(card.getByTestId('fact')).toContainText('идёт')
  await expect(card.getByRole('button', { name: 'Старт' })).toHaveCount(0)
  await card.getByRole('button', { name: 'Стоп' }).click()
  await expect(page.getByRole('button', { name: /^Таймер/ })).toHaveAttribute('data-status', 'done')
})
