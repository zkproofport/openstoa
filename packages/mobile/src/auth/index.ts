// Single entry point for everything auth-related in the mini-app. Screens
// and widgets should import from here instead of reaching into
// `components/SignInSheet`, `stores/sessionStore`, etc. directly — that
// keeps the auth abstraction swappable and stops gate logic from leaking
// across the codebase.

export { useRequireAuth, type AuthStatus } from './useRequireAuth';
export { useAuthGuardedAction } from './useAuthGuardedAction';
export { AuthGate, GuestFallbackView } from './AuthGate';
export { initSessionLifecycle } from './sessionLifecycle';
export {
  SignInLauncherProvider,
  useSignInLauncher,
  type SignInLauncher,
} from './SignInLauncher';

// Re-export the gate primitives that callers occasionally still need
// directly (e.g. to programmatically `open()` the sheet from a catch
// handler when a GuestAuthRequiredError sneaks through).
export {
  useSignInGate,
  SignInSheetProvider,
  GuestSignInCard,
} from '../components/SignInSheet';
