import { useOpenStoaSession } from '../stores/sessionStore';

export interface AuthStatus {
  /** True while the boot effect hasn't decided yet (very brief window). */
  isResolving: boolean;
  /** True after a successful sign-in; false for guests AND while unknown. */
  isAuthenticated: boolean;
  /** True for anything that is not `'authenticated'` (guest + unknown). */
  isGuest: boolean;
}

/**
 * One-stop selector for components that need to render differently based
 * on auth state. Mirrors the booleans we'd otherwise re-derive in every
 * screen (`mode !== 'authenticated'`, `mode === 'guest'`, etc.).
 *
 * Pair with `<AuthGate>` for full-screen guest fallbacks, or with
 * `useAuthGuardedAction` for individual action handlers.
 */
export function useRequireAuth(): AuthStatus {
  const mode = useOpenStoaSession((s) => s.mode);
  return {
    isResolving: mode === 'unknown',
    isAuthenticated: mode === 'authenticated',
    isGuest: mode !== 'authenticated',
  };
}
