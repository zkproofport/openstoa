import { useOpenStoaSession } from '../stores/sessionStore';
import { ensureClient } from '../api/openstoaClient';
import { queryClient } from '../api/queryClient';
import { notifySessionExpired } from './sessionExpiry';
import type { HostApi } from '@openstoa/miniapp-bridge';

/**
 * Wire global side-effects that must follow the session store *synchronously*
 * — without waiting for a React render. The session store is the single
 * source of truth for "who is the user right now"; everything else here
 * mirrors that source on every mutation:
 *
 *   1. The API client's mode (`'unknown' | 'guest' | 'authenticated'`)
 *      flips the moment `setSession()` / `setGuest()` / `clear()` runs, so
 *      pending fetches never read a stale auth mode.
 *
 *   2. The React-Query cache is dropped on every auth-boundary crossing
 *      (guest ↔ authenticated). Without this, a post fetched while signed
 *      in keeps showing `userVoted: 1` / `userBookmarked: true` after the
 *      user logs out, because the cache survives the auth change.
 *
 * Call once at app boot, after `ensureClient(host)` has produced the
 * singleton client. Idempotent: re-calling with the same host is a no-op
 * (zustand's subscribe handles re-registration internally — but we still
 * track a flag to avoid attaching two listeners).
 */
let _bound = false;

export function initSessionLifecycle(host: HostApi): void {
  if (_bound) return;
  _bound = true;

  const client = ensureClient(host);

  // Prime the client with the current store value so the very first
  // request after boot uses the right mode, even before any subscriber
  // fires.
  client.setMode(useOpenStoaSession.getState().mode);

  // The client's own 401-recovery (`dropDeadSession`, openstoaClient.ts)
  // already gives up on a session the server refused twice (once directly,
  // once after a silent refresh) — but that lives entirely inside the
  // client's own `this.mode` field, which `useOpenStoaSession` (what
  // `AuthGate` / `useRequireAuth` actually read) never sees. Without this,
  // the store keeps reporting `mode: 'authenticated'` for a credential the
  // client has already discarded, so screens keep rendering authenticated
  // UI backed by requests that silently fail. Mirror the drop into the
  // store, then tell the sign-in sheet to open UNPROMPTED — unlike a
  // deliberate "Log out" tap (which also flips the store but must NOT pop
  // the sheet), nobody asked for this, so the app has to say so.
  client.onSessionDropped(() => {
    useOpenStoaSession.getState().setGuest();
    notifySessionExpired();
  });

  useOpenStoaSession.subscribe((state, prev) => {
    if (state.mode === prev.mode) return;
    client.setMode(state.mode);

    // An auth-boundary crossing is any change where the authenticated
    // bit flips — guest→authenticated, authenticated→guest,
    // authenticated→unknown (logout), unknown→authenticated, etc. Any
    // crossing means cached data is now mis-typed for the new identity
    // and must go.
    const wasAuthed = prev.mode === 'authenticated';
    const isAuthed = state.mode === 'authenticated';
    if (wasAuthed !== isAuthed) {
      queryClient.clear();
    }
  });
}
