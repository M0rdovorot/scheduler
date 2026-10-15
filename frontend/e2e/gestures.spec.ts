import { expect, test } from '@playwright/test'
import {
  PPM_30,
  apiLogin,
  column,
  freezeClock,
  resetData,
  scrollGridTo,
  yAt,
  type Api,
} from './helpers'

let api: Api

test.beforeEach(async ({ page, request }) => {
  api = await apiLogin(request)
  await resetData(api)
  await freezeClock(page)
})

const DAY = '2026-10-14'

test('dragging with the mouse selects slots and opens the short form', async ({ page }) => {
  await page.goto('/')
  await expect(column(page, DAY)).toBeVisible()
  await scrollGridTo(page, 14 * 60, PPM_30)

  const box = (await column(page, DAY).boundingBox())!
  const x = box.x + box.width / 2
  // Press inside the 14:00 slot, drag to inside the 15:00 slot.
  await page.mouse.move(x, await yAt(page, DAY, 14 * 60 + 5, PPM_30))
  await page.mouse.down()
  await page.mouse.move(x, await yAt(page, DAY, 14 * 60 + 40, PPM_30), { steps: 4 })
  await page.mouse.move(x, await yAt(page, DAY, 15 * 60 + 5, PPM_30), { steps: 4 })
  // While dragging, the selection is drawn over exactly the covered slots.
  await expect(page.getByText('14:00–15:30')).toBeVisible()
  await page.screenshot({ path: 'e2e/screenshots/selection.png' })
  await page.mouse.up()

  const dialog = page.getByRole('dialog', { name: 'Новое дело' })
  await expect(dialog).toBeVisible()
  // The short form shows the time, not the date and time inputs.
  await expect(dialog.getByLabel('Время')).toHaveText('14:00–15:30')
  await expect(dialog.getByLabel('Начало')).toHaveCount(0)

  await dialog.getByLabel('Название').fill('Встреча')
  await dialog.getByRole('button', { name: 'Создать' }).click()
  await expect(dialog).toBeHidden()

  const block = page.getByRole('button', { name: 'Встреча, 14:00–15:30' })
  await expect(block).toBeVisible()
  const b = (await block.boundingBox())!
  const col = (await column(page, DAY).boundingBox())!
  expect(b.y - col.y).toBeCloseTo(14 * 60 * PPM_30, 0)
  expect(b.height).toBeCloseTo(90 * PPM_30 - 1, 0)
  await page.screenshot({ path: 'e2e/screenshots/created.png' })

  const [task] = (await api.get(
    '/instances?from=2026-10-14T00:00:00Z&to=2026-10-15T00:00:00Z',
  )) as {
    planned_start: string
    planned_end: string
  }[]
  // 14:00–15:30 Moscow is 11:00–12:30 UTC.
  expect(task?.planned_start).toBe('2026-10-14T11:00:00Z')
  expect(task?.planned_end).toBe('2026-10-14T12:30:00Z')
})

test('dragging upwards selects the same slots', async ({ page }) => {
  await page.goto('/')
  await scrollGridTo(page, 15 * 60, PPM_30)
  const box = (await column(page, DAY).boundingBox())!
  const x = box.x + box.width / 2

  await page.mouse.move(x, await yAt(page, DAY, 16 * 60 + 5, PPM_30))
  await page.mouse.down()
  await page.mouse.move(x, await yAt(page, DAY, 15 * 60 + 5, PPM_30), { steps: 6 })
  await page.mouse.up()

  await expect(page.getByRole('dialog').getByLabel('Время')).toHaveText('15:00–16:30')
})

test('a click on an empty slot selects that one slot', async ({ page }) => {
  await page.goto('/')
  await scrollGridTo(page, 16 * 60, PPM_30)
  const box = (await column(page, DAY).boundingBox())!

  await page.mouse.click(box.x + box.width / 2, await yAt(page, DAY, 16 * 60 + 10, PPM_30))

  await expect(page.getByRole('dialog').getByLabel('Время')).toHaveText('16:00–16:30')
})

test('a click on a task opens it instead of starting a selection', async ({ page }) => {
  await api.post('/tasks', {
    title: 'Обед',
    planned_start: '2026-10-14T09:00:00Z',
    planned_end: '2026-10-14T10:00:00Z',
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Обед, 12:00–13:00' }).click()

  const dialog = page.getByRole('dialog', { name: 'Дело' })
  await expect(dialog.getByLabel('Название')).toHaveValue('Обед')
  await expect(dialog.getByLabel('Начало')).toHaveValue('2026-10-14T12:00')
})

test('the pointer can leave the column while dragging', async ({ page }) => {
  await page.goto('/')
  await scrollGridTo(page, 14 * 60, PPM_30)
  const box = (await column(page, DAY).boundingBox())!

  await page.mouse.move(box.x + box.width / 2, await yAt(page, DAY, 14 * 60 + 5, PPM_30))
  await page.mouse.down()
  // Move far to the left, over the time labels.
  await page.mouse.move(5, await yAt(page, DAY, 15 * 60 + 5, PPM_30), { steps: 6 })
  await page.mouse.up()

  await expect(page.getByRole('dialog').getByLabel('Время')).toHaveText('14:00–15:30')
})

test.describe('touch', () => {
  test.use({ hasTouch: true })

  async function touch(page: import('@playwright/test').Page) {
    const cdp = await page.context().newCDPSession(page)
    const point = (x: number, y: number) => [{ x, y, id: 1 }]
    return {
      start: (x: number, y: number) =>
        cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point(x, y) }),
      move: (x: number, y: number) =>
        cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: point(x, y) }),
      end: () => cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }),
    }
  }

  test('a long press and drag selects slots', async ({ page }) => {
    await page.goto('/')
    await scrollGridTo(page, 14 * 60, PPM_30)
    const box = (await column(page, DAY).boundingBox())!
    const x = box.x + box.width / 2
    const t = await touch(page)

    await t.start(x, await yAt(page, DAY, 14 * 60 + 5, PPM_30))
    await page.waitForTimeout(500) // longer than the hold time
    for (let m = 20; m <= 65; m += 15) {
      await t.move(x, await yAt(page, DAY, 14 * 60 + m, PPM_30))
    }
    await expect(page.getByText('14:00–15:30')).toBeVisible()
    await t.end()

    await expect(page.getByRole('dialog').getByLabel('Время')).toHaveText('14:00–15:30')
  })

  test('a quick swipe scrolls the grid and selects nothing', async ({ page }) => {
    await page.goto('/')
    // Start well above the bottom, so that there is room to scroll down.
    await scrollGridTo(page, 8 * 60, PPM_30)
    const box = (await column(page, DAY).boundingBox())!
    const x = box.x + box.width / 2
    const scrollTop = () =>
      page.evaluate(
        () => document.querySelector('[data-day]')!.parentElement!.parentElement!.scrollTop,
      )
    const before = await scrollTop()
    const t = await touch(page)

    await t.start(x, 600)
    for (let i = 1; i <= 10; i++) {
      await t.move(x, 600 - i * 20)
      await page.waitForTimeout(16)
    }
    await t.end()

    await page.waitForTimeout(600)
    await expect(page.getByRole('dialog')).toHaveCount(0)
    expect(await scrollTop()).toBeGreaterThan(before + 100)
  })

  test('a short tap does nothing', async ({ page }) => {
    await page.goto('/')
    await scrollGridTo(page, 14 * 60, PPM_30)
    const box = (await column(page, DAY).boundingBox())!
    await page.touchscreen.tap(box.x + box.width / 2, await yAt(page, DAY, 14 * 60 + 5, PPM_30))
    await page.waitForTimeout(600)
    await expect(page.getByRole('dialog')).toHaveCount(0)
  })
})
