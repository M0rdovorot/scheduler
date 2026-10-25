import { create } from 'zustand'

interface AuthState {
  /** Session bearer token of the Mini App and dev mode; kept in memory only. */
  token: string | null
  /**
   * The browser has no session and cannot get one by itself: the user has to
   * sign in. The web version keeps its session in an httpOnly cookie.
   */
  signedOut: boolean
  setToken: (token: string | null) => void
  setSignedOut: (signedOut: boolean) => void
}

export const useAuthStore = create<AuthState>()((set) => ({
  token: null,
  signedOut: false,
  setToken: (token) => set({ token }),
  setSignedOut: (signedOut) => set({ signedOut }),
}))
