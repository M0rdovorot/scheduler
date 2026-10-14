// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Category } from '@/api/types'
import { CategoryPicker } from './CategoryPicker'

function cat(id: string, name: string, parent: string | null = null, archived = false): Category {
  return {
    id,
    name,
    parent_id: parent,
    color: '#3b82f6',
    archived_at: archived ? '2026-01-01T00:00:00Z' : null,
  }
}

const categories = [
  cat('sport', 'Спорт'),
  cat('run', 'Бег', 'sport'),
  cat('work', 'Работа'),
  cat('old', 'Старое', null, true),
]

afterEach(cleanup)

describe('CategoryPicker', () => {
  it('lists active categories as a tree and hides archived ones', () => {
    render(<CategoryPicker categories={categories} value={[]} onChange={() => {}} />)
    const names = screen.getAllByRole('checkbox').map((c) => c.closest('label')?.textContent)
    expect(names).toEqual(['Работа', 'Спорт', 'Бег'])
  })

  it('still shows a selected archived category, marked as archived', () => {
    render(<CategoryPicker categories={categories} value={['old']} onChange={() => {}} />)
    const box = screen.getByRole('checkbox', { name: /Старое/ }) as HTMLInputElement
    expect(box.checked).toBe(true)
    expect(box.closest('label')?.textContent).toContain('в архиве')
  })

  it('allows any number of categories, parents and children independently', async () => {
    const ui = userEvent.setup()
    const onChange = vi.fn()
    function Harness() {
      const [value, setValue] = useState<string[]>([])
      return (
        <CategoryPicker
          categories={categories}
          value={value}
          onChange={(ids) => {
            onChange(ids)
            setValue(ids)
          }}
        />
      )
    }
    render(<Harness />)

    await ui.click(screen.getByRole('checkbox', { name: /Спорт/ }))
    await ui.click(screen.getByRole('checkbox', { name: /Бег/ }))
    await ui.click(screen.getByRole('checkbox', { name: /Работа/ }))
    expect(onChange).toHaveBeenLastCalledWith(['sport', 'run', 'work'])

    await ui.click(screen.getByRole('checkbox', { name: /Спорт/ }))
    expect(onChange).toHaveBeenLastCalledWith(['run', 'work'])
  })

  it('puts a selected archived child at the top level when its archived parent is hidden', () => {
    const tree = [cat('p', 'Спорт', null, true), cat('c', 'Бег', 'p', true), cat('w', 'Работа')]
    render(<CategoryPicker categories={tree} value={['c']} onChange={() => {}} />)
    const items = screen.getAllByRole('listitem')
    expect(items.map((li) => li.textContent)).toEqual(['Бег (в архиве)', 'Работа'])
    expect(items.every((li) => (li as HTMLElement).style.paddingLeft === '0px')).toBe(true)
  })

  it('allows an empty selection (a task may have no category)', async () => {
    const ui = userEvent.setup()
    const onChange = vi.fn()
    render(<CategoryPicker categories={categories} value={['work']} onChange={onChange} />)
    await ui.click(screen.getByRole('checkbox', { name: /Работа/ }))
    expect(onChange).toHaveBeenCalledWith([])
  })

  it('says so when there are no categories', () => {
    render(<CategoryPicker categories={[]} value={[]} onChange={() => {}} />)
    expect(screen.getByText('Категорий пока нет')).toBeTruthy()
  })
})
