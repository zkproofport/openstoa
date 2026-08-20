// A dedicated signal for "the server just refused this session, unprompted"
// — distinct from an ordinary user-initiated logout, which also flips
// `useOpenStoaSession.mode` away from 'authenticated' but must NOT pop the
// sign-in sheet on its own (the person already knows they logged out).
//
// Deliberately a plain module-level pub/sub, not React context: the emitter
// side (`OpenStoaClient.dropDeadSession` via `auth/sessionLifecycle.ts`) is
// non-React, and the subscriber (`SignInSheetProvider`) needs to react from
// wherever it happens to be mounted without threading a prop down to it.
// Kept in its own leaf module (no imports from `SignInSheet.tsx` or
// `auth/index.ts`) so importing it can never create a cycle.

type Listener = () => void;

const listeners = new Set<Listener>();

/**
 * Fired once per session the server has refused and a silent
 * `/api/auth/refresh` could not repair (see `openstoaClient.ts`
 * `dropDeadSession`). Subscribers should treat this as "open the sign-in
 * sheet right now, nobody asked for this to happen."
 */
export function notifySessionExpired(): void {
  for (const listener of listeners) listener();
}

/** Subscribe to session-expiry notifications. Returns an unsubscribe function. */
export function subscribeSessionExpired(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
