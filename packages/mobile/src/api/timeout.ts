/**
 * A deadline on every request the mini-app waits for.
 *
 * This module exists because of a real incident: the OpenStoa tab was opened,
 * the boot screen said "Preparing your anonymous identity…", and it said that
 * until the app was force-quit. There was no cancel, no error, no way out. The
 * cause was not an error at all — it was the ABSENCE of one. `fetch` has no
 * timeout of its own, `AbortController` appeared nowhere in this package, and a
 * request that is never answered therefore leaves its caller waiting for as
 * long as the process lives. A `try/catch` around such a call is decoration:
 * there is nothing to catch, because nothing was ever thrown.
 *
 * So the deadline goes HERE, once, rather than at each of the call sites — a
 * per-call convention is a convention the next call site forgets.
 *
 * ── Why 15 seconds ────────────────────────────────────────────────────────
 *
 * The OpenStoa API is a Next.js service on Cloud Run and its routes answer in
 * tens of milliseconds warm. The slow parts are the ones around it: a Cloud Run
 * cold start on an idle revision costs 1–3s (staging runs `min-instances=0`),
 * and a phone on a bad cellular link spends another 1–3s on DNS, TCP and TLS
 * before a byte of the request goes out. So the honest worst case for a request
 * that IS going to succeed is somewhere near 5s.
 *
 * 15s is three times that. Wide enough that no request which would have
 * succeeded is killed, narrow enough that a person watching a spinner gets an
 * answer while they are still watching it. The alternative failure — cutting
 * off a slow request that was about to work — is worse than waiting, which is
 * why this is not tuned tighter.
 *
 * ── Why uploads get their own, longer one ─────────────────────────────────
 *
 * A deadline of this kind is a deadline on the WHOLE exchange, not on idle
 * time: a 9MB encrypted attachment climbing a slow uplink is making progress
 * the entire time and would be aborted at 15s for no reason. Uploads therefore
 * get 60s, which is roughly a 10MB body at ~1.5Mbps.
 *
 * ── What must NOT inherit it ──────────────────────────────────────────────
 *
 * Long-lived connections. `api/chatSocket.ts` (topic chat) and
 * `api/useAccountEvents.ts` (the account's key-needed stream) hold SSE
 * connections open for as long as the screen or the session lasts — that is
 * their entire purpose — and a deadline would sever chat delivery and the key
 * handover every 15 seconds. Both of them construct `react-native-sse`'s
 * `EventSource` directly against `host.getEnvironment().openstoaBaseUrl` and
 * never touch `OpenStoaClient`, so nothing here can reach them; the
 * `timeoutMs: null` opt-out below exists for anything that later does.
 */

/** The deadline every ordinary request gets. See the header for the number. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

/**
 * The deadline for a request whose body is megabytes (chat attachments, image
 * uploads). Longer because the clock covers the upload itself, not idle time.
 */
export const UPLOAD_REQUEST_TIMEOUT_MS = 60_000;

/**
 * The server was reachable but did not answer inside the deadline.
 *
 * A THIRD thing, deliberately not folded into either neighbour:
 *
 *   - `OpenStoaNetworkError` means the request never got out — aeroplane mode,
 *     no signal, DNS. "Check your connection" is the right advice and the state
 *     of the account is unchanged, because nothing was sent.
 *   - `OpenStoaApiError` means the server understood and answered with a
 *     status. It has an opinion, and usually a sentence.
 *   - This one means neither: something accepted the connection and then went
 *     quiet. Whether the write landed is UNKNOWN — that is the fact that
 *     separates it from the other two, and the reason a caller must be able to
 *     tell them apart instead of showing one "it didn't work" for all three.
 */
export class OpenStoaTimeoutError extends Error {
  readonly kind = 'TIMEOUT' as const;
  constructor(
    readonly path: string,
    readonly timeoutMs: number,
  ) {
    // Says what happened without naming the endpoint (it goes in the field, for
    // logs — see the same reasoning on `OpenStoaNetworkError`), and without
    // claiming the action failed, because that is not known.
    super('The server did not answer in time. Please try again.');
    this.name = 'OpenStoaTimeoutError';
  }
}

export interface FetchWithTimeoutOptions {
  /** Endpoint path, for the thrown error and the log line. */
  path: string;
  /**
   * Milliseconds before the request is aborted, or `null` for no deadline.
   *
   * `null` is the opt-out for a connection that is SUPPOSED to stay open —
   * streaming, long-poll, a file the platform downloads on its own clock. It
   * must be passed explicitly, with a comment saying why, so that "no deadline"
   * is always a decision somebody made rather than one nobody noticed.
   */
  timeoutMs: number | null;
  /** Method name, for the log line only. */
  method?: string;
}

/**
 * `fetch`, with a deadline, and a distinguishable error when it expires.
 *
 * Built on `AbortController` rather than `AbortSignal.timeout()`: the static
 * helper is not present on every JS runtime this package runs on (Hermes has
 * had it only recently), and — more importantly — a signal aborted by
 * `AbortSignal.timeout` is indistinguishable at the catch site from one the
 * caller aborted, which is exactly the distinction this function exists to
 * preserve. The local `timedOut` flag is that distinction.
 *
 * A caller's own `init.signal` is respected as well: aborting it aborts the
 * request, and the resulting error is NOT reported as a timeout, because it
 * wasn't one.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  opts: FetchWithTimeoutOptions,
): Promise<Response> {
  const { path, timeoutMs, method } = opts;
  if (timeoutMs === null) {
    // Explicitly deadline-free — see `timeoutMs` above.
    return fetch(url, init);
  }

  const controller = new AbortController();
  let timedOut = false;
  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;

  /*
   * The deadline is a RACE, not merely an abort.
   *
   * Aborting alone would leave the guarantee resting on the `fetch`
   * implementation honouring the signal — and this whole module exists because
   * of a promise that never settled. A deadline that can itself be defeated by
   * the thing it is supervising is not a deadline. So the abort is still sent,
   * because releasing the socket is worth doing and a phone's radio is not
   * free, but the caller is freed by this promise either way.
   */
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      try {
        controller.abort();
      } catch {
        // An implementation without abort support must not turn a timeout into
        // a different, stranger error.
      }
      /*
       * The one line that makes the next occurrence diagnosable.
       *
       * The incident this module was written for left NOTHING in the log: the
       * code logged a success and logged a rejection, and a request that did
       * neither wrote nothing at all, so the trigger is still unknown. A
       * timeout is not an error the server reported — nobody else is going to
       * record it.
       */
      console.warn(
        `[openstoa-mobile] request timed out after ${Date.now() - startedAt}ms ` +
          `(limit ${timeoutMs}ms): ${method ?? 'GET'} ${path}`,
      );
      reject(new OpenStoaTimeoutError(path, timeoutMs));
    }, timeoutMs);
  });

  // Chain the caller's signal, if it brought one, so both can abort.
  const external = init.signal;
  const onExternalAbort = () => controller.abort();
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener('abort', onExternalAbort);
  }

  const attempt = fetch(url, { ...init, signal: controller.signal }).catch((e) => {
    // An abort WE sent surfaces here as an `AbortError`. It is the deadline
    // expiring, said in the platform's words, and must reach the caller as a
    // timeout rather than as a mysterious cancellation. A caller's own abort
    // has `timedOut === false` and passes through untouched — the two are not
    // the same event and the catch site has to be able to tell them apart.
    if (timedOut) throw new OpenStoaTimeoutError(path, timeoutMs);
    throw e;
  });
  // Whichever branch loses the race is nobody's business any more; without this
  // the loser's rejection is an unhandled one.
  attempt.catch(() => {});

  try {
    return await Promise.race([attempt, deadline]);
  } finally {
    clearTimeout(timer);
    if (external) external.removeEventListener('abort', onExternalAbort);
  }
}
