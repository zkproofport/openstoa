/**
 * A server-sent event stream that survives the token it was born with.
 *
 * WHY THIS EXISTS AS ONE PLACE. Two streams in this app had the same defect,
 * written three months apart and found on the same night:
 *
 *   chat (`chatSocket.ts`)             the "Reconnecting to the chat server…"
 *                                      banner that never cleared, and sends
 *                                      that sat there offering Resend
 *   key events (`useAccountEvents.ts`) worse — no error listener at all, so a
 *                                      room simply sat on "Waiting for the
 *                                      key…" with nothing anywhere to explain it
 *
 * Both read the token correctly, from the app-wide store. Both then handed the
 * VALUE to an object that lives for hours:
 *
 *     new EventSource(url, { headers: { Authorization: `Bearer ${token}` } })
 *
 * `react-native-sse` reconnects on its own, reusing that same config — and its
 * `headers` is a plain object, not a callback, so the connection has no way to
 * ask again. Meanwhile the REST client refreshes the session and stores a new
 * token. After a refresh the app held two truths: ordinary requests worked, and
 * the stream retried a dead credential until the screen closed.
 *
 * A comment in the old code said "react-native-sse handles reconnect via its
 * own polling timer" — true, and it never asked WHAT it reconnects with. That
 * is the shape of the mistake.
 *
 * SO THE LIBRARY DOES NOT OWN THE RECONNECT ANY MORE; this does. On an error
 * the stream is closed at once (leaving it open means it keeps polling with the
 * credential that just failed, for the whole backoff), and after a delay the
 * whole connect runs again — including reading the token, which is the point.
 *
 * ONE PLACE so a third stream cannot repeat it. A test asserts that nothing
 * else in the app constructs an `EventSource` directly; a scan for that cannot
 * be satisfied by a comment, because a comment cannot open a connection.
 *
 * THE DELAY IS THE SHARED LADDER (`backupRetry.ts`) and it WRAPS back to its
 * fast end rather than settling at a ceiling — a phone that lost signal gets a
 * quick attempt soon after it returns, instead of waiting out the rest of a
 * five-minute step.
 */
import EventSource from 'react-native-sse';
import { nextDelay } from '../crypto/backupRetry';

export interface ReconnectingStreamOptions<E extends string> {
  /** Where to connect. Re-read on every attempt, so a changed handle is picked up. */
  url: () => Promise<string | null> | string | null;
  /** The credential, READ FRESH on every attempt. Null aborts this attempt. */
  token: () => Promise<string | null>;
  /**
   * Is somebody signed in right now?
   *
   * A GUEST MUST NOT BE TOLD THEIR SESSION DIED. Both cases answer 401 — the
   * server distinguishes them with a `code` (`no-credential` vs
   * `credential-dead`), but an EventSource error event carries only the status,
   * so the client has to know which side it is on. Without this, opening the
   * app signed out produced "다시 로그인해 주세요" to somebody who had never
   * logged in.
   *
   * REQUIRED, and that is the design. It was optional with a default of
   * "assume signed in", and mutation testing showed the default was dead code
   * — both callers pass it — while a wrong default would silently break
   * whichever caller had not been thought about. A new stream cannot skip this
   * decision because the compiler will not let it.
   */
  isAuthenticated: () => boolean;
  /**
   * Event names to subscribe, and what to do with each.
   *
   * `'message'` is included alongside the caller's custom names because it is
   * the library's own built-in and therefore never appears in a custom-name
   * union — the chat stream carries its rows on it. Leaving it out made the
   * compiler reject the one listener that matters most.
   */
  on: Partial<Record<E | 'message', (event: { data?: string }) => void>>;
  /** Told when the stream opens, when it drops, and when it gives up. */
  onStatus?: (status: 'connecting' | 'open' | 'error' | 'rejected', detail?: string) => void;
  /**
   * The credential was REFUSED, and re-reading it did not help.
   *
   * Separate from a dropped connection because the two need opposite answers: a
   * dropped connection wants patience, and a refused credential wants the
   * person to sign in again. Retrying a refusal is how a signed-out phone ends
   * up knocking on the door every few minutes for the rest of the day.
   */
  onRejected?: () => void;
  /** Schedules the retry. Injected so a test can drive hours in milliseconds. */
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}

export interface ReconnectingStream {
  /** Stop for good: close the connection and cancel any armed retry. */
  close(): void;
}

/**
 * Open the stream and keep it open. Never throws — a caller is a screen, and a
 * connection that cannot be made is a status to report, not an exception.
 */
export function openReconnectingStream<E extends string>(
  opts: ReconnectingStreamOptions<E>,
): ReconnectingStream {
  const arm = opts.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
  const disarm =
    opts.clearTimeoutFn ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  let stopped = false;
  /*
   * How many times in a row the server has REFUSED the credential.
   *
   * One refusal is worth another go: the token may have just been refreshed by
   * a request happening in parallel, and the next attempt reads the new one. A
   * second refusal with a freshly read token means the session is genuinely
   * dead, and no amount of waiting will change that.
   */
  let refusals = 0;
  let es: EventSource<E> | null = null;
  let timer: unknown = null;
  /** Failures since the stream was last open. Drives the ladder. */
  let attempt = 0;

  const dropStream = () => {
    try {
      es?.removeAllEventListeners();
      es?.close();
    } catch {
      // already closed
    }
    es = null;
  };

  const scheduleRetry = () => {
    if (stopped) return;
    if (timer !== null) disarm(timer);
    attempt += 1;
    timer = arm(() => {
      timer = null;
      void connect();
    }, nextDelay(attempt));
  };

  async function connect(): Promise<void> {
    if (stopped) return;
    opts.onStatus?.('connecting');
    try {
      const [url, token] = await Promise.all([opts.url(), opts.token()]);
      if (stopped) return;
      if (!url || !token) {
        /*
         * No credential yet — a sign-in that has not landed, or a handle the
         * app is still resolving. Not an error to report, but not a reason to
         * give up either: the ladder brings us back.
         */
        scheduleRetry();
        return;
      }

      const next = new EventSource<E>(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      es = next;

      next.addEventListener('open', () => {
        if (stopped) return;
        // A stream that opened resets the ladder, so the next outage starts
        // from a quick attempt rather than inheriting this one's patience.
        attempt = 0;
        refusals = 0;
        opts.onStatus?.('open');
      });

      next.addEventListener('error', (e: unknown) => {
        if (stopped) return;
        const err = e as { message?: string; xhrStatus?: number };
        opts.onStatus?.('error', err?.message);
        dropStream();

        /*
         * A REFUSED CREDENTIAL IS NOT A DROPPED CONNECTION, and treating them
         * alike is what leaves a signed-out phone knocking every few minutes
         * for the rest of the day. `react-native-sse` reports the HTTP status
         * on its error event, so the two are distinguishable.
         *
         * The SECOND refusal is what stops it, not the first. One refusal can
         * be a token that was refreshed a moment ago by a request happening in
         * parallel — the next attempt reads the new one and succeeds. Two in a
         * row, each with a freshly read credential, means the session is dead
         * and waiting will not revive it.
         */
        /*
         * A guest's 401 is not a refusal, it is the absence of a credential.
         * Counting it would stop the stream and put a sign-in-again message in
         * front of somebody who never signed in — and it would also stop
         * retrying, so the stream would not come back when they DO sign in.
         */
        const signedIn = opts.isAuthenticated();
        if (signedIn && (err?.xhrStatus === 401 || err?.xhrStatus === 403)) {
          refusals += 1;
          if (refusals >= 2) {
            stopped = true;
            opts.onStatus?.('rejected', `server refused the credential (${err.xhrStatus})`);
            opts.onRejected?.();
            return;
          }
        } else {
          refusals = 0;
        }

        scheduleRetry();
      });

      for (const [name, handler] of Object.entries(opts.on)) {
        if (typeof handler !== 'function') continue;
        next.addEventListener(
          name as E | 'message',
          handler as unknown as (event: unknown) => void,
        );
      }
    } catch (err) {
      if (stopped) return;
      opts.onStatus?.('error', err instanceof Error ? err.message : String(err));
      dropStream();
      scheduleRetry();
    }
  }

  void connect();

  return {
    close() {
      stopped = true;
      dropStream();
      if (timer !== null) {
        // An armed retry outlives whatever closed this. Left alone it wakes up
        // and reconnects for a screen that is gone.
        disarm(timer);
        timer = null;
      }
    },
  };
}
