import { create } from 'zustand';

export type SessionMode = 'unknown' | 'guest' | 'authenticated';

/**
 * Global account-level role surfaced by `GET /api/auth/session`. Distinct
 * from per-topic membership role (owner/admin/member of a specific topic)
 * which lives in topic detail responses. `admin` means the account has
 * platform-wide moderation powers (post/comment deletion across topics).
 */
export type SessionRole = 'admin' | 'member';

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
  /**
   * Platform-wide role for the signed-in account. `admin` enables global
   * moderation affordances (delete any post/comment). Defaults to
   * `'member'` so screens never need to null-check. Stays `'member'` for
   * guests too — guests are gated upstream by `mode !== 'authenticated'`.
   */
  role: SessionRole;

  setSession: (s: {
    token: string;
    userId: string;
    nickname?: string;
    needsNickname?: boolean;
    expiresAt?: number | null;
    role?: SessionRole;
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
  role: 'member',

  setSession: ({ token, userId, nickname, needsNickname, expiresAt, role }) =>
    set({
      mode: 'authenticated',
      token,
      userId,
      nickname: nickname ?? null,
      needsNickname: needsNickname ?? false,
      expiresAt: expiresAt ?? null,
      role: role ?? 'member',
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
      role: 'member',
    }),
  clear: () =>
    set({
      mode: 'unknown',
      token: null,
      userId: null,
      nickname: null,
      needsNickname: false,
      expiresAt: null,
      role: 'member',
    }),
}));
