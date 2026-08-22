/**
 * `fetch` with a deadline, for anything a person is sitting and waiting for.
 *
 * The browser's `fetch` has no timeout. A server that accepts a connection and
 * then goes quiet — a stalled Cloud Run instance, a proxy that swallowed the
 * response, a laptop resuming onto a captive-portal network that answers the
 * TCP handshake and nothing else — leaves the promise pending, and every
 * spinner behind it spinning, until the tab is closed. `try/catch` does not
 * help: nothing is thrown, there is only a caller that never resumes.
 *
 * The mini-app hit exactly this and stranded a real device on its boot screen
 * (`packages/mobile/src/api/timeout.ts` is the twin of this file, written for
 * that incident). The web client had the same hole for the same reason: the
 * `AbortController` uses already in this repo — `lib/proof.ts`, the OG routes —
 * are all SERVER-side, where nobody is watching a spinner.
 *
 * ── Why 15 seconds ────────────────────────────────────────────────────────
 *
 * The API routes answer in tens of milliseconds warm. What is slow is the
 * surroundings: a Cloud Run cold start on an idle revision is 1–3s, and a bad
 * connection adds a second or two of DNS/TCP/TLS before the request leaves. So
 * a request that IS going to succeed has an honest worst case near 5s, and 15s
 * is three times that — wide enough never to kill a working request, short
 * enough to answer someone while they are still watching.
 *
 * ── What must NOT get one ─────────────────────────────────────────────────
 *
 * Anything that streams. `/api/ask/stream` is read with `body.getReader()` and
 * a long answer legitimately takes minutes; it passes `timeoutMs: null`, with
 * a comment, at its call site. The SSE consumers (`components/ChatPanel.tsx`,
 * `lib/useAccountEvents.ts`) use the native `EventSource`, which is not `fetch`
 * at all and therefore cannot inherit anything from here.
 */

/** The deadline an ordinary request gets. See the header for the number. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

/**
 * The deadline for a request whose body is megabytes (image upload). Longer
 * because the clock covers the body going up, not idle time — a transfer that
 * is making progress must not be cut off for making progress slowly.
 */
export const UPLOAD_REQUEST_TIMEOUT_MS = 60_000;

/**
 * The server was reachable and did not answer inside the deadline.
 *
 * Its own type so a caller can say "the server did not answer" rather than
 * "something went wrong". That is a different fact from both neighbours: a
 * `TypeError` from `fetch` means the request never got out and nothing changed,
 * a non-ok `Response` means the server understood and declined — and this one
 * means the request was taken and whether it landed is UNKNOWN, which is the
 * one case where telling somebody "it failed" may send them off to do it twice.
 */
export class ApiTimeoutError extends Error {
  readonly kind = 'TIMEOUT' as const;
  constructor(
    readonly url: string,
    readonly timeoutMs: number,
  ) {
    super('The server did not answer in time. Please try again.');
    this.name = 'ApiTimeoutError';
  }
}

/** True for the error `apiFetch` throws when its deadline expires. */
export function isApiTimeout(e: unknown): e is ApiTimeoutError {
  return e instanceof ApiTimeoutError || (e as { kind?: string } | null)?.kind === 'TIMEOUT';
}

export interface ApiFetchInit extends RequestInit {
  /**
   * Milliseconds before the request is abandoned; `null` for no deadline.
   *
   * Defaults to `DEFAULT_REQUEST_TIMEOUT_MS`. `null` is the opt-out for a
   * response that is SUPPOSED to take a long time — a stream being read
   * incrementally, chiefly — and every use of it carries a comment saying why,
   * so that "no deadline" is always a decision somebody made.
   */
  timeoutMs?: number | null;
}

/**
 * Drop-in for `fetch` that will not wait forever.
 *
 * Signature-compatible on purpose: adopting it at a call site is a rename, and
 * the deadline arrives without anyone having to remember it.
 *
 * The deadline is a RACE, not merely an `abort()`. Aborting alone would rest
 * the whole guarantee on the runtime honouring the signal, and the failure this
 * exists to stop is a promise that never settles — a deadline the supervised
 * thing can defeat is not a deadline. The abort is still sent, because leaving
 * a socket open behind a caller that has given up is waste, but the caller is
 * freed either way.
 */
export async function apiFetch(input: RequestInfo | URL, init: ApiFetchInit = {}): Promise<Response> {
  const { timeoutMs: override, ...rest } = init;
  const timeoutMs = override === undefined ? DEFAULT_REQUEST_TIMEOUT_MS : override;
  if (timeoutMs === null) return fetch(input, rest);

  const url = typeof input === 'string' ? input : input.toString();
  const controller = new AbortController();
  let timedOut = false;
  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      try {
        controller.abort();
      } catch {
        // Never let a missing abort turn a timeout into a stranger error.
      }
      // The only trace a timeout leaves — nothing else reports it, because
      // nothing failed anywhere that could report it.
      console.warn(
        `[openstoa] request timed out after ${Date.now() - startedAt}ms ` +
          `(limit ${timeoutMs}ms): ${(rest.method ?? 'GET').toUpperCase()} ${url}`,
      );
      reject(new ApiTimeoutError(url, timeoutMs));
    }, timeoutMs);
  });

  // A caller's own signal still works, and aborting it is NOT a timeout.
  const external = rest.signal;
  const onExternalAbort = () => controller.abort();
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener('abort', onExternalAbort);
  }

  const attempt = fetch(input, { ...rest, signal: controller.signal }).catch((e) => {
    if (timedOut) throw new ApiTimeoutError(url, timeoutMs);
    throw e;
  });
  // The race's loser is nobody's business; without this its rejection is
  // unhandled.
  attempt.catch(() => {});

  try {
    return await Promise.race([attempt, deadline]);
  } finally {
    clearTimeout(timer);
    if (external) external.removeEventListener('abort', onExternalAbort);
  }
}
