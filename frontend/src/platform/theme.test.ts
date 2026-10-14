import { describe, expect, it, vi } from 'vitest'
import { applyTheme } from './theme'

function fakeElement() {
  return {
    dataset: {} as Record<string, string>,
    style: { setProperty: vi.fn(), removeProperty: vi.fn() },
  }
}

describe('applyTheme', () => {
  it('sets provided colors, clears missing ones and records the scheme', () => {
    const el = fakeElement()
    applyTheme({ colorScheme: 'dark', bg: '#000', fg: '#fff' }, el as unknown as HTMLElement)

    expect(el.dataset.theme).toBe('dark')
    expect(el.style.setProperty).toHaveBeenCalledWith('--app-bg', '#000')
    expect(el.style.setProperty).toHaveBeenCalledWith('--app-fg', '#fff')
    expect(el.style.removeProperty).toHaveBeenCalledWith('--app-accent')
    expect(el.style.removeProperty).not.toHaveBeenCalledWith('--app-bg')
  })
})
