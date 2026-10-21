// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConfirmDialog } from './ConfirmDialog'
import { Dialog } from './Dialog'

afterEach(cleanup)

describe('Dialog', () => {
  it('has a close button in its header', async () => {
    const onClose = vi.fn()
    render(
      <Dialog title="Дело" onClose={onClose}>
        <p>Содержимое</p>
      </Dialog>,
    )
    await userEvent.setup().click(screen.getByRole('button', { name: 'Закрыть' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes on Escape and on a tap beside the sheet, but not on a tap inside it', async () => {
    const onClose = vi.fn()
    render(
      <Dialog title="Дело" onClose={onClose}>
        <p>Содержимое</p>
      </Dialog>,
    )
    const ui = userEvent.setup()
    await ui.click(screen.getByText('Содержимое'))
    expect(onClose).not.toHaveBeenCalled()
    await ui.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes only the top one of two sheets with its button', async () => {
    const outer = vi.fn()
    const inner = vi.fn()
    render(
      <>
        <Dialog title="Нижняя" onClose={outer}>
          <p>a</p>
        </Dialog>
        <Dialog title="Верхняя" onClose={inner}>
          <p>b</p>
        </Dialog>
      </>,
    )
    const buttons = screen.getAllByRole('button', { name: 'Закрыть' })
    expect(buttons).toHaveLength(2)
    await userEvent.setup().click(buttons[1]!)
    expect(inner).toHaveBeenCalledTimes(1)
    expect(outer).not.toHaveBeenCalled()
  })

  it('is there for the confirmation too', async () => {
    const onCancel = vi.fn()
    render(
      <ConfirmDialog
        title="Удалить?"
        confirmLabel="Удалить"
        onConfirm={() => {}}
        onCancel={onCancel}
      >
        Точно?
      </ConfirmDialog>,
    )
    await userEvent.setup().click(screen.getByRole('button', { name: 'Закрыть' }))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})
