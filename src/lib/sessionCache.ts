/**
 * One `/api/auth/session` per page, shared by everything that needs it.
 *
 * WHAT THIS REPLACES. Thirteen call sites each fetched the same endpoint
 * independently — `Header`, `ChatPanel`, and eleven pages — so opening a topic
 * asked twice before anything else happened, and every client-side navigation
 * asked again. `Header` alone cached the answer, in `localStorage` under
 * `os-session`, and nothing else read it.
 *
 * The cost is not theoretical. Measured on staging, `/api/auth/session` takes
 * ~270ms, and `ChatPanel` will not draw a single row until it answers: a bubble
 * whose side is unknown would open under someone else's name and slide across
 * the panel a moment later. So a restored room sat blank waiting for a value the
 * tab already had.
 *
 * THREE LAYERS, cheapest first:
 *   1. a module variable — same page, no I/O at all;
 *   2. `localStorage` — a new tab, and a reload, without a round trip. Shared
 *      with `Header`'s existing `os-session` key rather than beside it, so
 *      there is one thing to write, one to read and one to clear on logout;
 *   3. the network — and only ONE request, however many callers arrive at once,
 *      because the in-flight promise is shared.
 *
 * A stale cached value cannot outlive its usefulness: the network answer always
 * lands and overwrites it, every caller is told, and logout clears it. What it
 * buys is the first paint, not the truth.
 *
 * NOT A SECRET. The server hands this to the session on request, and the
 * reader's own nickname is already on screen. The origin already keeps far more
 * sensitive material — the device master key — in IndexedDB.
 */
import { apiFetch } from '@/lib/apiFetch';

export interface CachedSession {
  userId?: string;
  nickname?: string;
  profileImage?: string | null;
  role?: string;
  totalRecorded?: number;
}

/** The key `Header` has always used. Shared deliberately — see the note above. */
export const SESSION_STORAGE_KEY = 'os-session';

let memo: CachedSession | null = null;
let inFlight: Promise<CachedSession | null> | null = null;
/**
 * Whether the SERVER has answered during this page load.
 *
 * Separate from `memo`, which may have come from storage and is therefore a
 * hint rather than a verification. Without this, `loadSession()` de-duplicated
 * only CONCURRENT callers and went to the network again for every sequential
 * one — two `UserCard`s opened one after the other cost two requests, which is
 * worse than the per-component cache this module replaced. Caught by
 * `userCard.test.tsx`, which had asserted exactly that for the old code.
 */
let verifiedThisPage = false;

function readStored(): CachedSession | null {
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedSession;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    // Private mode, disabled storage, or a value someone else corrupted.
    return null;
  }
}

function writeStored(session: CachedSession | null): void {
  try {
    if (session) localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
    else localStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    /* the round trip is the fallback */
  }
}

/**
 * The session as far as this device knows it, WITHOUT asking the server.
 *
 * Synchronous on purpose: an async read lands after the first paint, which is
 * exactly the moment the value was needed. Returns null when this device has
 * never been told, which is a real answer and not an error.
 */
export function peekSession(): CachedSession | null {
  if (memo) return memo;
  memo = readStored();
  return memo;
}

/**
 * The session from the server, asked once however many callers want it.
 *
 * Concurrent callers share the in-flight promise rather than each starting a
 * request — the case that made opening a topic cost two identical round trips.
 * A failure clears the promise so a later caller can try again rather than
 * inheriting a rejection.
 */
export function loadSession(options?: { force?: boolean }): Promise<CachedSession | null> {
  if (inFlight) return inFlight;
  /*
   * Once per page load, not once per caller.
   *
   * The answer changes at sign-in and sign-out, and both write through this
   * module — so re-asking mid-page tells us nothing we do not already know.
   * `force` exists for the caller that has a reason to believe otherwise; there
   * is none today, and it is here so adding one does not mean reaching around
   * this module again.
   */
  if (verifiedThisPage && !options?.force) return Promise.resolve(memo);
  inFlight = apiFetch('/api/auth/session')
    .then((r) => (r.ok ? r.json() : null))
    .then((data: CachedSession | null) => {
      const session = data?.userId ? data : null;
      memo = session;
      verifiedThisPage = true;
      writeStored(session);
      return session;
    })
    .catch(() => null)
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/**
 * Forget everything. Called on logout, where leaving it would show the next
 * person at this browser the previous one's name until the server disagreed.
 */
export function clearSession(): void {
  memo = null;
  inFlight = null;
  // A later `loadSession()` must ASK again: the next person at this browser is
  // not the one this page verified.
  verifiedThisPage = false;
  writeStored(null);
}

/** Test seam: drops the module memo without touching storage. */
export function resetSessionMemoForTests(): void {
  memo = null;
  inFlight = null;
  verifiedThisPage = false;
}
