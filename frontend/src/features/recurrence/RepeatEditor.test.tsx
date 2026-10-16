// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { RepeatEditor } from './RepeatEditor'
import { toRRule, type Repeat } from './repeat'

afterEach(cleanup)

const WED = '2026-10-14'

/** Runs the editor with real state and exposes the resulting RRULE. */
function Harness({ start = WED, initial = null }: { start?: string; initial?: Repeat | null }) {
  const [value, setValue] = useState<Repeat | null>(initial)
  return (
    <>
      <RepeatEditor value={value} startDay={start} onChange={setValue} />
      <output data-testid="rrule">{value ? toRRule(value, start, 'Europe/Moscow') : 'none'}</output>
    </>
  )
}

const rrule = () => screen.getByTestId('rrule').textContent

describe('RepeatEditor', () => {
  it('starts without a repeat and shows no options', () => {
    render(<Harness />)
    expect((screen.getByLabelText('Повтор') as HTMLSelectElement).value).toBe('')
    expect(screen.queryByLabelText('Каждые')).toBeNull()
    expect(rrule()).toBe('none')
  })

  it('offers every frequency of FR-4.1', async () => {
    render(<Harness />)
    const options = [...(screen.getByLabelText('Повтор') as HTMLSelectElement).options].map(
      (o) => o.text,
    )
    expect(options).toEqual([
      'Не повторять',
      'Каждый день',
      'Каждую неделю',
      'Каждый месяц',
      'Каждый год',
    ])
  })

  it('builds daily, with an interval', async () => {
    const ui = userEvent.setup()
    render(<Harness />)
    await ui.selectOptions(screen.getByLabelText('Повтор'), 'daily')
    expect(rrule()).toBe('FREQ=DAILY')
    await ui.clear(screen.getByLabelText('Каждые'))
    await ui.type(screen.getByLabelText('Каждые'), '3')
    expect(rrule()).toBe('FREQ=DAILY;INTERVAL=3')
    expect(screen.getByTestId('repeat-summary').textContent).toBe('Каждые 3 дня')
  })

  it('builds weekly with chosen weekdays, and needs at least one', async () => {
    const ui = userEvent.setup()
    render(<Harness />)
    await ui.selectOptions(screen.getByLabelText('Повтор'), 'weekly')
    expect(rrule()).toBe('FREQ=WEEKLY;BYDAY=WE')

    await ui.click(screen.getByRole('button', { name: 'пт' }))
    await ui.click(screen.getByRole('button', { name: 'пн' }))
    expect(rrule()).toBe('FREQ=WEEKLY;BYDAY=MO,WE,FR')

    await ui.click(screen.getByRole('button', { name: 'пн' }))
    await ui.click(screen.getByRole('button', { name: 'ср' }))
    await ui.click(screen.getByRole('button', { name: 'пт' }))
    expect(screen.getByText('Выберите хотя бы один день недели')).toBeTruthy()
  })

  it('offers monthly modes that fit the start date', async () => {
    const ui = userEvent.setup()
    render(<Harness />)
    await ui.selectOptions(screen.getByLabelText('Повтор'), 'monthly')
    // 14 Oct 2026 is the 2nd Wednesday, not the last.
    expect(screen.getByLabelText('14-го числа')).toBeTruthy()
    expect(screen.getByLabelText('2-й ср месяца')).toBeTruthy()
    expect(screen.queryByLabelText(/последний/)).toBeNull()
    expect(rrule()).toBe('FREQ=MONTHLY;BYMONTHDAY=14')

    await ui.click(screen.getByLabelText('2-й ср месяца'))
    expect(rrule()).toBe('FREQ=MONTHLY;BYDAY=2WE')
  })

  it('offers the last weekday when the start date is one', async () => {
    const ui = userEvent.setup()
    render(<Harness start="2026-10-28" />)
    await ui.selectOptions(screen.getByLabelText('Повтор'), 'monthly')
    await ui.click(screen.getByLabelText('последний ср месяца'))
    expect(rrule()).toBe('FREQ=MONTHLY;BYDAY=-1WE')
  })

  it('builds yearly', async () => {
    const ui = userEvent.setup()
    render(<Harness />)
    await ui.selectOptions(screen.getByLabelText('Повтор'), 'yearly')
    expect(rrule()).toBe('FREQ=YEARLY')
    expect(screen.getByTestId('repeat-summary').textContent).toBe('Ежегодно')
  })

  it('ends after a number of repeats or on a date', async () => {
    const ui = userEvent.setup()
    render(<Harness />)
    await ui.selectOptions(screen.getByLabelText('Повтор'), 'daily')

    await ui.selectOptions(screen.getByLabelText('Закончить'), 'count')
    expect(rrule()).toBe('FREQ=DAILY;COUNT=10')
    await ui.clear(screen.getByLabelText('Число повторов'))
    await ui.type(screen.getByLabelText('Число повторов'), '4')
    expect(rrule()).toBe('FREQ=DAILY;COUNT=4')

    await ui.selectOptions(screen.getByLabelText('Закончить'), 'until')
    // The end date starts at the start date itself: one occurrence.
    expect((screen.getByLabelText('Дата окончания') as HTMLInputElement).value).toBe(WED)
    fireEvent.change(screen.getByLabelText('Дата окончания'), { target: { value: '2026-12-31' } })
    expect(rrule()).toBe('FREQ=DAILY;UNTIL=20261231T205959Z')

    await ui.selectOptions(screen.getByLabelText('Закончить'), 'never')
    expect(rrule()).toBe('FREQ=DAILY')
  })

  it('refuses an end date before the start', async () => {
    const ui = userEvent.setup()
    render(<Harness />)
    await ui.selectOptions(screen.getByLabelText('Повтор'), 'daily')
    await ui.selectOptions(screen.getByLabelText('Закончить'), 'until')
    fireEvent.change(screen.getByLabelText('Дата окончания'), { target: { value: '2026-10-01' } })
    expect(screen.getByText('Дата окончания не может быть раньше начала')).toBeTruthy()
  })

  it('refuses an interval out of range', async () => {
    const ui = userEvent.setup()
    render(<Harness />)
    await ui.selectOptions(screen.getByLabelText('Повтор'), 'daily')
    await ui.clear(screen.getByLabelText('Каждые'))
    await ui.type(screen.getByLabelText('Каждые'), '0')
    expect(screen.getByText('Число от 1 до 999')).toBeTruthy()
  })

  it('keeps the interval and the end when the frequency changes, and can switch the repeat off', async () => {
    const ui = userEvent.setup()
    render(<Harness />)
    await ui.selectOptions(screen.getByLabelText('Повтор'), 'daily')
    await ui.clear(screen.getByLabelText('Каждые'))
    await ui.type(screen.getByLabelText('Каждые'), '2')
    await ui.selectOptions(screen.getByLabelText('Закончить'), 'count')

    await ui.selectOptions(screen.getByLabelText('Повтор'), 'weekly')
    expect(rrule()).toBe('FREQ=WEEKLY;INTERVAL=2;BYDAY=WE;COUNT=10')

    await ui.selectOptions(screen.getByLabelText('Повтор'), '')
    expect(rrule()).toBe('none')
    expect(screen.queryByLabelText('Каждые')).toBeNull()
  })

  it('shows an existing rule', () => {
    render(
      <Harness
        initial={{
          freq: 'weekly',
          interval: 2,
          weekdays: [0, 3],
          monthly: 'monthday',
          end: { kind: 'count', count: 6 },
        }}
      />,
    )
    expect((screen.getByLabelText('Повтор') as HTMLSelectElement).value).toBe('weekly')
    expect((screen.getByLabelText('Каждые') as HTMLInputElement).value).toBe('2')
    expect(screen.getByRole('button', { name: 'пн' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: 'чт' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: 'вт' }).getAttribute('aria-pressed')).toBe('false')
    expect((screen.getByLabelText('Число повторов') as HTMLInputElement).value).toBe('6')
    expect(screen.getByTestId('repeat-summary').textContent).toBe('Каждые 2 недели: пн, чт, 6 раз')
  })
})
