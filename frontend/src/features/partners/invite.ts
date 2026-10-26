export const inviteParam = 'invite'
const storageKey = 'pendingInvite'

/** The link a person opens to become a partner. The token is the secret. */
export function inviteLink(origin: string, token: string): string {
  const url = new URL('/', origin)
  url.searchParams.set(inviteParam, token)
  return url.href
}

/** The invite token in the query string of the address, if any. */
export function tokenFromSearch(search: string): string | null {
  const token = new URLSearchParams(search).get(inviteParam)?.trim()
  return token ? token : null
}

/** The address without the invite token, keeping the rest of the query and the hash. */
export function withoutInvite(href: string): string {
  const url = new URL(href)
  url.searchParams.delete(inviteParam)
  return url.href
}

interface TokenStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/**
 * The invite to accept after signing in: from the address, else from what was kept before the
 * sign-in page took the person away. Storage can be unavailable (private windows): then the
 * address alone has to do.
 */
export function pendingInvite(search: string, storage: TokenStorage | null): string | null {
  const fromAddress = tokenFromSearch(search)
  try {
    if (fromAddress) {
      storage?.setItem(storageKey, fromAddress)
      return fromAddress
    }
    return storage?.getItem(storageKey) ?? null
  } catch {
    return fromAddress
  }
}

export function forgetInvite(storage: TokenStorage | null): void {
  try {
    storage?.removeItem(storageKey)
  } catch {
    // Nothing kept, nothing to forget.
  }
}

export function sessionStorageOrNull(): TokenStorage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage
  } catch {
    return null
  }
}
