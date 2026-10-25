// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import {
  clearTelegramAuthResult,
  isTelegramLaunch,
  mapTelegramTheme,
  takeTelegramAuthResult,
  telegramLoginUrl,
} from './telegram'

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

describe('telegramLoginUrl', () => {
  it('asks to write to the user and comes back to the page without its hash', () => {
    const url = new URL(telegramLoginUrl(123456, 'https://plan.example/settings?x=1#old'))
    expect(url.origin + url.pathname).toBe('https://oauth.telegram.org/auth')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      bot_id: '123456',
      origin: 'https://plan.example',
      request_access: 'write',
      lang: 'ru',
      return_to: 'https://plan.example/settings?x=1',
    })
  })
})

describe('takeTelegramAuthResult', () => {
  const base64url = (value: unknown) =>
    btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value))))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')

  afterEach(() => {
    window.location.hash = ''
    clearTelegramAuthResult()
  })

  it('reads the fields as strings, removes the hash and keeps the value', () => {
    // A name that needs padding and the URL-safe alphabet once encoded.
    window.location.hash = '#tgAuthResult=' + base64url({ id: 42, first_name: 'Аня?>', hash: 'h' })

    const expected = { id: '42', first_name: 'Аня?>', hash: 'h' }
    expect(takeTelegramAuthResult()).toEqual(expected)
    expect(window.location.hash).toBe('')
    expect(takeTelegramAuthResult()).toEqual(expected)

    clearTelegramAuthResult()
    expect(takeTelegramAuthResult()).toBeNull()
  })

  it('returns null without a result, for a refusal and for garbage', () => {
    expect(takeTelegramAuthResult()).toBeNull()
    for (const hash of ['#tgAuthResult=' + base64url(false), '#tgAuthResult=bm90IGpzb24']) {
      clearTelegramAuthResult()
      window.location.hash = hash
      expect(takeTelegramAuthResult()).toBeNull()
    }
  })
})

describe('isTelegramLaunch', () => {
  it('sees the launch parameters Telegram puts in the hash', () => {
    expect(isTelegramLaunch('#tgWebAppData=query_id%3D1&tgWebAppVersion=8.0', null)).toBe(true)
  })

  it('sees the parameters kept for a reload inside Telegram', () => {
    expect(isTelegramLaunch('', JSON.stringify({ tgWebAppData: 'query_id=1' }))).toBe(true)
  })

  it('is false in a plain browser', () => {
    expect(isTelegramLaunch('', null)).toBe(false)
    expect(isTelegramLaunch('#tgAuthResult=abc', null)).toBe(false)
    expect(isTelegramLaunch('', JSON.stringify({ tgWebAppData: '' }))).toBe(false)
    expect(isTelegramLaunch('', JSON.stringify({}))).toBe(false)
    expect(isTelegramLaunch('', 'not json')).toBe(false)
  })
})
