import { describe, expect, it } from 'vitest'
import { forgetInvite, inviteLink, pendingInvite, tokenFromSearch, withoutInvite } from './invite'

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  }
}

describe('inviteLink', () => {
  it('puts the token in the query of the site root', () => {
    expect(inviteLink('https://plan.example.org', 'a-b_c')).toBe(
      'https://plan.example.org/?invite=a-b_c',
    )
  })

  it('does not depend on the page it was made on', () => {
    expect(inviteLink('https://plan.example.org/', 'x')).toBe('https://plan.example.org/?invite=x')
  })
})

describe('tokenFromSearch', () => {
  it('reads the token', () => {
    expect(tokenFromSearch('?invite=abc')).toBe('abc')
    expect(tokenFromSearch('?a=1&invite=abc')).toBe('abc')
  })

  it('finds nothing in an empty or missing parameter', () => {
    expect(tokenFromSearch('')).toBeNull()
    expect(tokenFromSearch('?invite=')).toBeNull()
    expect(tokenFromSearch('?invite=%20')).toBeNull()
    expect(tokenFromSearch('?other=1')).toBeNull()
  })
})

describe('withoutInvite', () => {
  it('drops the token and keeps the rest', () => {
    expect(withoutInvite('https://x.org/?invite=abc&a=1#top')).toBe('https://x.org/?a=1#top')
    expect(withoutInvite('https://x.org/?invite=abc')).toBe('https://x.org/')
  })

  it('leaves an address with no token as it is', () => {
    expect(withoutInvite('https://x.org/stats?a=1')).toBe('https://x.org/stats?a=1')
  })
})

describe('pendingInvite', () => {
  it('keeps the token from the address for after the sign-in', () => {
    const storage = memoryStorage()
    expect(pendingInvite('?invite=abc', storage)).toBe('abc')
    // Back from the sign-in page the address has no token any more.
    expect(pendingInvite('', storage)).toBe('abc')
  })

  it('prefers the address over what was kept', () => {
    const storage = memoryStorage({ pendingInvite: 'old' })
    expect(pendingInvite('?invite=new', storage)).toBe('new')
    expect(pendingInvite('', storage)).toBe('new')
  })

  it('has nothing to accept without a token anywhere', () => {
    expect(pendingInvite('', memoryStorage())).toBeNull()
    expect(pendingInvite('', null)).toBeNull()
  })

  it('forgets the token once it is used', () => {
    const storage = memoryStorage()
    pendingInvite('?invite=abc', storage)
    forgetInvite(storage)
    expect(pendingInvite('', storage)).toBeNull()
  })

  it('works from the address when the storage is unusable', () => {
    const broken = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
      removeItem: () => {
        throw new Error('blocked')
      },
    }
    expect(pendingInvite('?invite=abc', broken)).toBe('abc')
    expect(pendingInvite('', broken)).toBeNull()
    expect(() => forgetInvite(broken)).not.toThrow()
  })
})
