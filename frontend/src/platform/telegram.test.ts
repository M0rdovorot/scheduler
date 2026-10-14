import { describe, expect, it } from 'vitest'
import { mapTelegramTheme } from './telegram'

describe('mapTelegramTheme', () => {
  it('maps Telegram theme params to platform colors', () => {
    expect(
      mapTelegramTheme(
        {
          bg_color: '#111',
          text_color: '#eee',
          hint_color: '#888',
          link_color: '#5ac',
          button_color: '#27f',
          button_text_color: '#fff',
          secondary_bg_color: '#222',
          section_separator_color: '#333',
          destructive_text_color: '#f44',
        },
        'dark',
      ),
    ).toEqual({
      colorScheme: 'dark',
      bg: '#111',
      fg: '#eee',
      hint: '#888',
      link: '#5ac',
      accent: '#27f',
      accentFg: '#fff',
      surface: '#222',
      separator: '#333',
      danger: '#f44',
    })
  })

  it('leaves absent colors undefined', () => {
    const theme = mapTelegramTheme({}, 'light')
    expect(theme.colorScheme).toBe('light')
    expect(theme.bg).toBeUndefined()
  })
})
