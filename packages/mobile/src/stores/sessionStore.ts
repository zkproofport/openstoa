import { create } from 'zustand';

export type SessionMode = 'unknown' | 'guest' | 'authenticated';

export interface OpenStoaSessionState {
  /**
   * `unknown` — boot hasn't decided yet (initial state).
   * `guest`   — user explicitly continued without signing in OR token resolution failed.
   * `authenticated` — a valid token is hydrated and bound to a userId/nullifier.
   *
   * Components must NOT infer auth from `token` alone; gate on `mode === 'authenticated'`.
   */
  mode: SessionMode;
  token: string | null;
  userId: string | null;
  nickname: string | null;
  needsNickname: boolean;
  expiresAt: number | null;

  setSession: (s: {
    token: string;
    userId: string;
    nickname?: string;
    needsNickname?: boolean;
    expiresAt?: number | null;
  }) => void;
  setNickname: (nickname: string) => void;
  /** Mark the session as guest browsing — clears any stale token state. */
  setGuest: () => void;
  /** Reset to `unknown` (used during sign-out before redirecting to Welcome). */
  clear: () => void;
}

export const useOpenStoaSession = create<OpenStoaSessionState>((set) => ({
  mode: 'unknown',
  token: null,
  userId: null,
  nickname: null,
  needsNickname: false,
  expiresAt: null,

  setSession: ({ token, userId, nickname, needsNickname, expiresAt }) =>
    set({
      mode: 'authenticated',
      token,
      userId,
      nickname: nickname ?? null,
      needsNickname: needsNickname ?? false,
      expiresAt: expiresAt ?? null,
    }),
  setNickname: (nickname) => set({ nickname, needsNickname: false }),
  setGuest: () =>
    set({
      mode: 'guest',
      token: null,
      userId: null,
      nickname: null,
      needsNickname: false,
      expiresAt: null,
    }),
  clear: () =>
    set({
      mode: 'unknown',
      token: null,
      userId: null,
      nickname: null,
      needsNickname: false,
      expiresAt: null,
    }),
}));
