import type { HostApi } from '@openstoa/miniapp-bridge';
import { installDeviceId } from '../lib/installDeviceId';
import type { RefreshResponse } from '@openstoa/api-types';
import { CHAT_MEDIA_CONTENT_TYPE } from '../lib/chatMedia';
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  UPLOAD_REQUEST_TIMEOUT_MS,
  fetchWithTimeout,
  OpenStoaTimeoutError,
} from './timeout';

/*
 * Re-exported so the timeout joins its two siblings — `OpenStoaApiError` and
 * `OpenStoaNetworkError` — at the import a caller already writes. It lives in
 * `./timeout` rather than here because `OpenStoaApp` needs it for the handful
 * of raw `fetch` calls it makes during boot, and that must not drag the whole
 * client (and the host bridge it types against) into the module graph.
 */
export { OpenStoaTimeoutError, DEFAULT_REQUEST_TIMEOUT_MS, UPLOAD_REQUEST_TIMEOUT_MS };

export type ClientMode = 'unknown' | 'guest' | 'authenticated';

/**
 * Thrown when an API call requires authentication but the user is in guest
 * mode (or no token can be obtained). Screens should catch this and surface
 * the SignInSheet instead of treating it as a hard error.
 */
export class GuestAuthRequiredError extends Error {
  readonly kind = 'GUEST_AUTH_REQUIRED' as const;
  constructor(public readonly path: string) {
    // Path kept as a field, out of the message: screens that render a query
    // error with `err.message` would otherwise show "Sign-in required for
    // /api/topics", which names the endpoint instead of the thing to do.
    super('Sign in to continue.');
    this.name = 'GuestAuthRequiredError';
  }
}

/**
 * A request the server answered with a failure status.
 *
 * The status and the server's own sentence used to be flattened into one
 * message string — `PUT /api/profile/nickname → 400: {"error":"That name is
 * reserved."}` — which left a caller two bad options: show the whole thing,
 * internals and all, or show nothing. Screens showed nothing, so a refusal the
 * server had explained in plain words arrived as silence.
 *
 * `status` lets a caller tell a refusal from a fault, and `serverMessage` is the
 * sentence to put in front of the person. `message` keeps the old full string so
 * logs and any existing caller are unaffected.
 */
export class OpenStoaApiError extends Error {
  readonly kind = 'API_ERROR' as const;
  constructor(
    readonly status: number,
    readonly path: string,
    /** The server's `error` field, when it sent one. */
    readonly serverMessage: string | null,
    /**
     * Method, path, status and raw body, for logs.
     *
     * NOT `message`, which is what a couple of dozen screens put on screen with
     * `err.message`. That used to be this string, so a failed request showed
     * the person `PUT /api/profile/nickname → 400: {"error":"…"}` — the API's
     * shape, on a phone, in place of an explanation. Anything reaching a screen
     * must come from `message` or `serverMessage`; this field is for the log.
     */
    readonly debugMessage: string,
  ) {
    // The message IS the user-facing sentence: the server's own words when it
    // wrote any, and otherwise a plain statement with no internals in it. Every
    // `err.message` call site is fixed by this one line, rather than by editing
    // each of them and hoping the next one remembers.
    super(serverMessage ?? 'Something went wrong. Please try again.');
    this.name = 'OpenStoaApiError';
  }
}

/**
 * The edge is refusing this client for a while — too many requests.
 *
 * SEPARATE FROM EVERY OTHER FAILURE, because the remedy is the opposite one.
 * A 400 means stop and fix the request; a 500 means try again; a 429 means
 * STOP SENDING, and anything that retries it promptly keeps the ban alive.
 *
 * WHAT THIS COST, on a phone 2026-08-27. The rate limit is 100 requests a
 * minute per address, then five minutes of 429. Three independent parts of the
 * app read the same two backup rows on their own schedules — five reads of
 * `/api/keys/backup` inside three seconds at one point — so the app banned
 * itself, and then its retries kept it banned. On screen the person read
 * "Something went wrong. Please try again", in English, which is wrong twice:
 * trying again is exactly what must not happen, and nothing was wrong with
 * what they did.
 */
/*
 * ONE clock for the whole app, not one per caller.
 *
 * The ban is per ADDRESS, so it applies to every request the phone makes, and a
 * screen that does not know about it will spend the pause re-arming it. Holding
 * the deadline in the module means the next caller — any caller — refuses
 * locally instead of spending a request to be told again.
 */
/*
 * ONE flight per identical GET, shared by everyone who asks during it.
 *
 * THE DEFECT THIS CLOSES, measured through the load balancer 2026-08-27:
 * `/api/keys/backup` was read FIVE times inside three seconds. Nothing was
 * wrong with any one caller — the recovery screen, the boot-time repair and the
 * backup retry each read it on their own schedule and none of them knew about
 * the others. Together they crossed a hundred requests a minute and the edge
 * banned the phone for five minutes.
 *
 * Reads only. A POST is an instruction and two of them are two instructions;
 * collapsing those would be a different and much worse defect.
 *
 * NAMED PATHS, not every GET. Sharing a chat-history read would hand a caller
 * an answer fetched a moment before its own question, and the room's tests
 * caught exactly that. These two are different: they are one row per account
 * that several independent parts read on their own timers, and two reads a
 * millisecond apart cannot differ.
 */
const SHAREABLE_READS = new Set(['/api/keys/backup', '/api/keys/tak-backup']);
const _inFlightGets = new Map<string, Promise<unknown>>();

/*
 * And a short memory of the ANSWER, because the readers are not simultaneous.
 *
 * Sharing a flight only helps callers that overlap. Measured through the load
 * balancer 2026-08-27: opening the recovery screen read `/api/keys/backup`
 * FIFTY-SIX times in one minute — a render cascade, each read one after the
 * next, never two at once. So nothing overlapped and nothing was shared.
 *
 * TWO seconds, from the measurement rather than a guess. In the recorded burst
 * the reads were 0.26 to 0.79 seconds apart — median 0.39, and not one gap
 * over a second. Two seconds clears the widest of those with room to spare.
 *
 * Going longer buys nothing and costs something: the only thing that changes
 * this row is a write, from this app (cleared below) or from ANOTHER device,
 * and every extra second is a second this one shows a stale answer about the
 * account's backup. The first draft said five seconds for no reason at all.
 */
const READ_MEMORY_MS = 2_000;
const _recentReads = new Map<string, { at: number; value: unknown }>();

let _pausedUntilMs = 0;

/** Epoch ms until which the edge is refusing us; 0 when it is not. */
export function rateLimitedUntil(): number {
  return _pausedUntilMs;
}

/**
 * Test seam: forget everything this module remembers between requests.
 *
 * The pause, the shared flights and the brief read memory all outlive a single
 * client, which is the point of them — and which is exactly why a test that
 * forgets one of them starts passing or failing on the order its neighbours
 * ran in. One function so a caller cannot clear half of it.
 */
export function clearRateLimitPause(): void {
  _pausedUntilMs = 0;
  _inFlightGets.clear();
  _recentReads.clear();
}

export class OpenStoaRateLimitedError extends Error {
  readonly kind = 'RATE_LIMITED' as const;
  constructor(
    readonly path: string,
    /** When the edge said it would accept requests again, in epoch ms. */
    readonly retryAfterMs: number,
  ) {
    super('요청이 잠시 너무 많았습니다. 잠시 후 다시 시도해 주세요.');
    this.name = 'OpenStoaRateLimitedError';
  }
}

/**
 * The request never reached the server — aeroplane mode, no signal, DNS, a
 * dropped connection mid-flight.
 *
 * Distinct from `OpenStoaApiError` because it means something different to the
 * person: nothing was changed and retrying is the whole remedy, whereas a 400
 * means the server understood and declined. `fetch` reports both as thrown
 * `TypeError`s with platform-specific text, which is not something a screen
 * should be parsing.
 */
export class OpenStoaNetworkError extends Error {
  readonly kind = 'NETWORK_ERROR' as const;
  constructor(
    readonly path: string,
    readonly cause: unknown,
  ) {
    // The path stays a FIELD, for logs. It was in the message, and screens that
    // render `err.message` printed "Could not reach the server for
    // /api/topics" — an endpoint on screen, telling the reader nothing they can
    // use and describing the system rather than their situation.
    super('Could not reach the server. Check your connection and try again.');
    this.name = 'OpenStoaNetworkError';
  }
}

/**
 * The server's own explanation, out of a failure body.
 *
 * Every route in this API answers a refusal as `{ error: string }`, and that
 * sentence is written for a person ("That name is reserved.", "Nickname already
 * taken"). Anything else — an HTML error page from a proxy, an empty body, a
 * 500's opaque `errorId` shape — yields null so the caller shows its own copy
 * instead of putting infrastructure text on screen.
 */
function readServerError(body: string): string | null {
  if (!body) return null;
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    return typeof parsed.error === 'string' && parsed.error.trim() ? parsed.error : null;
  } catch {
    return null;
  }
}

export interface OpenStoaClientOptions {
  host: HostApi;
  /**
   * Refresh threshold in milliseconds before token expiry. When the
   * client believes the token has fewer than this many ms left it will
   * fire /api/auth/refresh proactively. Defaults to 1 day.
   */
  refreshLeadMs?: number;
}

export interface RequestOptions extends RequestInit {
  /**
   * When true, callers explicitly opt into "guest may attempt this".
   * Without it, a guest-mode client throws `GuestAuthRequiredError` before
   * even firing the request (so screens surface the SignInSheet
   * immediately on user gesture, no roundtrip).
   *
   * Read endpoints whitelisted in the server middleware
   * (`GUEST_ACCESSIBLE_PREFIXES`) are auto-detected via `GUEST_SAFE_PREFIXES`
   * below; callers do not need to set this for those paths.
   */
  allowGuest?: boolean;
  /**
   * Override the request deadline, in milliseconds — or `null` for none.
   *
   * Defaults to `DEFAULT_REQUEST_TIMEOUT_MS`. Raise it for a request whose body
   * is large (the uploads below do); pass `null` ONLY for a connection meant to
   * stay open, and say why in a comment where you pass it. Nothing in this
   * package passes `null` today: both long-lived streams
   * (`api/chatSocket.ts`, `api/useAccountEvents.ts`) open `EventSource`
   * directly and never come through here at all.
   */
  timeoutMs?: number | null;
}

// Mirrors the server's `GUEST_ACCESSIBLE_PREFIXES` in `src/middleware.ts`.
// GET requests to these prefixes work without a token. Non-GET methods
// still need auth at the route-handler level, which the client surfaces
// as `GuestAuthRequiredError` on 401.
const GUEST_SAFE_PREFIXES = [
  '/api/feed',
  '/api/tags',
  '/api/categories',
  '/api/stats',
  '/api/og',
  '/api/topics',
  '/api/posts',
];

function isGuestSafePath(path: string): boolean {
  return GUEST_SAFE_PREFIXES.some((prefix) => path.startsWith(prefix));
}

export class OpenStoaClient {
  private readonly host: HostApi;
  private readonly baseUrl: string;
  private readonly refreshLeadMs: number;
  private cachedToken: string | null = null;
  private cachedExpiresAt: number | null = null;
  private inflightRefresh: Promise<string> | null = null;
  private mode: ClientMode = 'unknown';

  constructor(opts: OpenStoaClientOptions) {
    this.host = opts.host;
    this.baseUrl = opts.host.getEnvironment().openstoaBaseUrl.replace(/\/$/, '');
    this.refreshLeadMs = opts.refreshLeadMs ?? 24 * 60 * 60 * 1000;
  }

  /**
   * Tell the client whether the user is browsing as a guest or signed in.
   * Determines whether 401 triggers an auto-login or throws
   * `GuestAuthRequiredError`.
   */
  setMode(mode: ClientMode): void {
    this.mode = mode;
    if (mode === 'guest' || mode === 'unknown') {
      // Drop any cached token so guests never accidentally send a stale
      // Authorization header from a previous signed-in session.
      this.cachedToken = null;
      this.cachedExpiresAt = null;
    }
  }

  /** Force-clear the in-memory token cache (e.g. after logout). */
  invalidateToken(): void {
    this.cachedToken = null;
    this.cachedExpiresAt = null;
  }

  /**
   * Forget a session the server has finally refused.
   *
   * `invalidateToken` alone only empties the in-memory cache, so the very
   * next request reads the same rejected Bearer back out of host storage and
   * is refused again — a sign-in prompt on every single call, with nothing
   * the user does able to clear it. The host's own `logoutFromOpenStoa` is
   * what actually drops the persisted token.
   *
   * Dropping to `'guest'` matters as much as clearing the token: the guest
   * branch at the top of `request()` raises `GuestAuthRequiredError` before
   * spending a round trip, so subsequent calls reach the sign-in sheet
   * directly instead of each discovering the same 401 for themselves.
   *
   * Signing in again still works — the CTA calls `loginToOpenStoa` with
   * `force: true`, which the host documents as bypassing the logged-out
   * marker this sets.
   */
  private async dropDeadSession(): Promise<void> {
    this.invalidateToken();
    this.mode = 'guest';
    try {
      await this.host.logoutFromOpenStoa();
    } catch {
      // Best effort: the in-memory half is already cleared, and failing to
      // reach host storage must not turn a refused request into a crash.
    }
    // Tell whoever is listening that THIS client dropped the session on its
    // own initiative — as opposed to the user tapping "Log out" somewhere.
    // `this.mode` above is this class's own bookkeeping; it is invisible to
    // `useOpenStoaSession` (the zustand store screens actually read via
    // `AuthGate` / `useRequireAuth`), so without this callback the store
    // keeps reporting `mode: 'authenticated'` for a credential the client
    // has already given up on, and nothing ever tells the person why their
    // last action quietly stopped working. `auth/sessionLifecycle.ts` is the
    // sole subscriber: it mirrors this into the store AND pops the sign-in
    // sheet unprompted (an ordinary logout must NOT do the latter, which is
    // exactly why this fires only from here and not from `setMode('guest')`
    // itself).
    this.sessionDroppedHandler?.();
  }

  private sessionDroppedHandler: (() => void) | null = null;

  /**
   * Register the single listener for "this client just dropped a session the
   * server refused" (see `dropDeadSession`). Not a pub/sub set — exactly one
   * subscriber exists for the app's lifetime (`initSessionLifecycle`), same
   * shape as `SignInLauncherProvider`. Pass `null` to detach.
   */
  onSessionDropped(handler: (() => void) | null): void {
    this.sessionDroppedHandler = handler;
  }

  /**
   * Adopt a freshly-reissued JWT (e.g. from a nickname / profile update
   * response). Updates BOTH the in-memory cache AND the host-persisted
   * storage so the next request — and every subsequent app launch — uses
   * the new claims instead of the stale Bearer.
   *
   * Caller must await this before triggering any query refetch, otherwise
   * the refetch can race and read the old cached token.
   */
  async updateToken(newToken: string): Promise<void> {
    this.cachedToken = newToken;
    // expiresAt becomes unknown until /api/auth/refresh confirms it; the
    // next refresh cycle will repopulate it from the server.
    this.cachedExpiresAt = null;
    await this.host.setOpenStoaToken(newToken);
  }

  /** Canonical OpenStoa server origin (no trailing slash). Use for share links. */
  getBaseUrl(): string {
    return this.baseUrl;
  }

  /**
   * The Bearer for a request this client does NOT make itself — React
   * Native's `<Image>`, which fetches a gated `/api/media/{key}` URL through
   * the platform's own HTTP stack and carries neither our `Authorization`
   * header nor a cookie (`credentials: 'omit'` in `send()` is deliberate; see
   * the comment there). `src/utils/gatedMedia.ts` decides which URLs may
   * receive it.
   *
   * Async, like `pushSessionCredential` next door and for the same reason:
   * both are thin public wrappers over `tryGetToken`, so a second consumer
   * gets the refresh-on-near-expiry behaviour rather than a private copy of
   * the rules. `tryGetToken` is also why this never triggers a host login —
   * an image must not be the thing that prompts somebody to sign in.
   */
  async mediaAuthToken(): Promise<string | null> {
    return this.tryGetToken();
  }

  /**
   * The same credential, synchronously, or null when nothing is cached.
   *
   * Exists because `mediaAuthToken` cannot be awaited by the two places that
   * need it: `react-native-render-html`'s `provideEmbeddedHeaders` is a
   * synchronous callback, and a list row's `<Image>` should mount with its
   * headers already attached instead of after a promise settles. This lets
   * `useMediaAuthToken` SEED its state on first render in the overwhelmingly
   * common case — the app has already made an authenticated API call by the
   * time any image exists, so `cachedToken` is populated.
   *
   * Reads the cache and nothing else: no storage, no network, no refresh. A
   * near-expiry token is returned as-is, which is what makes the `reresolve`
   * path in `useMediaAuthToken` necessary rather than optional.
   */
  peekAuthToken(): string | null {
    // Same guard as `tryGetToken`: a guest must never send a Bearer left over
    // from a previous session, even one still sitting in this cache.
    if (this.mode === 'guest') return null;
    return this.cachedToken;
  }

  /**
   * The credential the iOS Notification Service Extension needs to fetch an
   * encrypted attachment for a push preview (P-1), or null when there is none.
   *
   * Deliberately built on `tryGetToken`: mirroring a credential is background
   * bookkeeping and must never be the thing that drives a login prompt. A guest,
   * or anyone whose token cannot be refreshed silently, simply mirrors nothing
   * and gets a caption without a thumbnail.
   */
  async pushSessionCredential(): Promise<{ baseUrl: string; token: string } | null> {
    const token = await this.tryGetToken();
    return token ? { baseUrl: this.baseUrl, token } : null;
  }

  /**
   * In guest mode this is a read-only attempt: if no token is on hand,
   * return null instead of triggering host login. Authenticated mode
   * keeps the original behaviour (refresh on expiry, host login on miss).
   */
  private async tryGetToken(): Promise<string | null> {
    if (this.mode === 'guest') {
      // Some host implementations may still surface a stale token; we keep
      // it out of guest requests to avoid sending an expired Authorization
      // header that the server would reject.
      return null;
    }
    if (this.cachedToken) {
      const expiresIn = (this.cachedExpiresAt ?? 0) - Date.now();
      if (expiresIn > this.refreshLeadMs) {
        return this.cachedToken;
      }
      try {
        return await this.refreshOnce(this.cachedToken);
      } catch {
        // fall through to host fetch
      }
    }
    const token = await this.host.getOpenStoaToken();
    if (token) {
      this.cachedToken = token;
      this.cachedExpiresAt = Date.now() + this.refreshLeadMs * 7;
      return token;
    }
    return null;
  }

  /**
   * Authenticated-only resolver — kicks off a host login if needed.
   * Used as the recovery path on 401 for signed-in users.
   */
  private async resolveTokenAuthenticated(force = false): Promise<string> {
    if (!force) {
      const t = await this.tryGetToken();
      if (t) return t;
    }
    const auth = await this.host.loginToOpenStoa({ force });
    this.cachedToken = auth.token;
    this.cachedExpiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
    this.mode = 'authenticated';
    return auth.token;
  }

  private refreshOnce(currentToken: string): Promise<string> {
    if (!this.inflightRefresh) {
      this.inflightRefresh = (async () => {
        try {
          // Deadlined like every other request: a refresh that hangs used to
          // hang whatever call was waiting on it, which is every call.
          const res = await fetchWithTimeout(
            `${this.baseUrl}/api/auth/refresh`,
            {
              method: 'POST',
              headers: { Authorization: `Bearer ${currentToken}` },
              credentials: 'omit',
            },
            { path: '/api/auth/refresh', timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS, method: 'POST' },
          );
          if (!res.ok) {
            throw new Error(`refresh failed (${res.status})`);
          }
          const data = (await res.json()) as RefreshResponse;
          this.cachedToken = data.token;
          this.cachedExpiresAt = data.expiresAt;
          return data.token;
        } finally {
          this.inflightRefresh = null;
        }
      })();
    }
    return this.inflightRefresh;
  }

  /**
   * `fetch`, with an unreachable server reported as such.
   *
   * A thrown `fetch` means the request never got an answer, which is a
   * different fact from any status code and the one case where "check your
   * connection" is the correct advice. Left raw it surfaced as a platform
   * string ("Network request failed"), so screens could not tell it apart from
   * a server fault and said nothing useful about either.
   */
  private async send(
    url: string,
    init: RequestInit,
    path: string,
    timeoutMs: number | null = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<Response> {
    try {
      return await fetchWithTimeout(url, init, {
        path,
        timeoutMs,
        method: (init.method ?? 'GET').toString().toUpperCase(),
      });
    } catch (e) {
      // A deadline that expired is its own fact and must reach the caller as
      // one — rewrapping it as "could not reach the server" would put the wrong
      // sentence on screen and, worse, assert that nothing was sent when the
      // truth is that nobody knows.
      if (e instanceof OpenStoaTimeoutError) throw e;
      throw new OpenStoaNetworkError(path, e);
    }
  }

  async request<T>(path: string, init: RequestOptions = {}): Promise<T> {
    const method = (init.method ?? 'GET').toUpperCase();
    // Every request carries a deadline unless the caller named a different one.
    // Kept out of the object handed to `fetch` — it is ours, not `RequestInit`'s.
    const { timeoutMs: timeoutOverride, ...fetchInit } = init;
    const timeoutMs =
      timeoutOverride === undefined ? DEFAULT_REQUEST_TIMEOUT_MS : timeoutOverride;
    const guestSafe = method === 'GET' && isGuestSafePath(path);
    const guestAllowed = guestSafe || init.allowGuest === true;

    // Guest mode + path is auth-only → surface immediately so the screen
    // can show SignInSheet on the user gesture without a wasted roundtrip.
    if (this.mode === 'guest' && !guestAllowed) {
      throw new GuestAuthRequiredError(path);
    }

    let token = await this.tryGetToken();
    // Authenticated mode + token missing + not guest-safe → drive a host
    // login. (Guest mode falls through with no token; if the path is
    // guest-safe the server lets it through.)
    if (!token && this.mode === 'authenticated' && !guestSafe) {
      token = await this.resolveTokenAuthenticated();
    }

    const url = `${this.baseUrl}${path}`;
    const headers = new Headers(init.headers ?? {});
    if (token) headers.set('Authorization', `Bearer ${token}`);

    /*
     * WHICH DEVICE THIS IS — sent on every request, not just at login.
     *
     * The server keeps one session per person and needs to tell "the same phone
     * again" from "a second device"; it also decides chat availability from the
     * kind. Sending it once at sign-in would leave every later request unable to
     * answer either question, and the server would have to trust a months-old
     * record instead of what is in front of it.
     *
     * Neither value is a credential — see `deviceFromRequest` on the server for
     * why a declaration is enough here and where it stops being enough.
     */
    headers.set('x-openstoa-device-kind', 'mobile');
    headers.set('x-openstoa-device-id', await installDeviceId(this.host.secureStore));
    if (init.body && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }


    // CRITICAL: explicitly omit cookies on every request. The native iOS
    // cookie store persists across logout (we only clear AsyncStorage
    // tokens), so without this any stale `zk-community-session` cookie
    // from a previous authenticated session would be sent automatically
    // and the server would treat the user as still-authenticated — even
    // when `clientMode === 'guest'` and we explicitly skipped the
    // Authorization header. That bug is what made joined topics keep
    // showing after logout.
    /*
     * Refuse locally while the edge is banning us.
     *
     * Sending anyway is what kept the ban alive: every request during the pause
     * counts, so an app with a few independent pollers can hold itself out
     * indefinitely. Failing here costs nothing and lets the clock run down.
     */
    if (Date.now() < _pausedUntilMs) {
      throw new OpenStoaRateLimitedError(path, _pausedUntilMs);
    }

    let res = await this.send(url, { ...fetchInit, headers, credentials: 'omit' }, path, timeoutMs);
    if (res.status === 401) {
      // Guest (or anyone without a token) → don't auto-trigger login.
      // The screen catches GuestAuthRequiredError and shows SignInSheet.
      if (this.mode !== 'authenticated' || !token) {
        throw new GuestAuthRequiredError(path);
      }

      /*
       * A token the server refused. Try ONE refresh: an ordinary expiry is
       * the common case and recovers without troubling anyone.
       *
       * If the refresh fails, or the refreshed token is refused too, the
       * session is genuinely over — drop it and let the screen offer sign-in.
       *
       * What must NOT happen here is `resolveTokenAuthenticated(true)`. The
       * host reads `force: true` as "the user tapped Sign in" and answers it
       * by starting the OIDC proof flow — see the comment on
       * `loginToOpenStoa` in the host: it withholds any proof flow until the
       * user explicitly asks for one. A 401 is the server declining a
       * credential, not a person asking to prove their organisation, and
       * treating the two alike dropped someone into a domain-verification
       * sheet just for opening the tab, and again for pressing Create on a
       * filled-in form. It also cannot work: when the account behind the
       * token is gone, no amount of re-authenticating produces an acceptable
       * one.
       */
      let refreshed: string | null = null;
      try {
        refreshed = await this.refreshOnce(token);
      } catch {
        refreshed = null;
      }
      if (!refreshed) {
        await this.dropDeadSession();
        throw new GuestAuthRequiredError(path);
      }

      headers.set('Authorization', `Bearer ${refreshed}`);
      res = await this.send(url, { ...fetchInit, headers, credentials: 'omit' }, path, timeoutMs);
      if (res.status === 401) {
        await this.dropDeadSession();
        throw new GuestAuthRequiredError(path);
      }
    }

    if (res.status === 429) {
      /*
       * Believe `Retry-After` when the edge sends one, and otherwise assume the
       * documented ban — five minutes. Guessing SHORTER would re-arm the ban,
       * which is the failure this exists to stop.
       */
      const header = res.headers.get('retry-after');
      const seconds = header && /^\d+$/.test(header) ? Number(header) : 300;
      _pausedUntilMs = Date.now() + seconds * 1000;
      throw new OpenStoaRateLimitedError(path, _pausedUntilMs);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new OpenStoaApiError(
        res.status,
        path,
        readServerError(text),
        `${method} ${path} → ${res.status}: ${text}`,
      );
    }

    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  get<T>(path: string, options?: RequestOptions): Promise<T> {
    /*
     * Share a read that is already on its way. See `_inFlightGets` above: the
     * callers are independent by design and cannot coordinate between
     * themselves, so the one place that can is here.
     *
     * Keyed by mode too — a guest and a signed-in reader of the same path are
     * asking different questions and must not be handed each other's answer.
     */
    if (!SHAREABLE_READS.has(path)) {
      return this.request<T>(path, { ...options, method: 'GET' });
    }

    const key = `${this.mode}\u0000${path}`;

    const remembered = _recentReads.get(key);
    if (remembered && Date.now() - remembered.at < READ_MEMORY_MS) {
      return Promise.resolve(remembered.value as T);
    }

    const existing = _inFlightGets.get(key);
    if (existing) return existing as Promise<T>;

    const flight = this.request<T>(path, { ...options, method: 'GET' })
      .then((value) => {
        _recentReads.set(key, { at: Date.now(), value });
        return value;
      })
      .finally(() => {
        _inFlightGets.delete(key);
      });
    _inFlightGets.set(key, flight);
    return flight;
  }
  post<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    // A write to these rows makes every remembered read of them wrong.
    if (path.startsWith('/api/keys/')) _recentReads.clear();
    return this.request<T>(path, {
      ...options,
      method: 'POST',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  patch<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.request<T>(path, {
      ...options,
      method: 'PATCH',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  put<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.request<T>(path, {
      ...options,
      method: 'PUT',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  delete<T = void>(path: string, options?: RequestOptions): Promise<T> {
    return this.request<T>(path, { ...options, method: 'DELETE' });
  }

  /**
   * Store an END-TO-END ENCRYPTED chat attachment (R-3) and return its object
   * key. `ciphertextB64` is AEAD output sealed under the topic's TAK — the
   * server stores it as opaque bytes and can never open it.
   *
   * Deliberately NOT `uploadFile`: that one hands the plaintext file to
   * `/api/upload`, which stores it at a public unauthenticated URL. It is still
   * the right call for post images and avatars, which are public by intent.
   */
  async uploadChatMedia(topicId: string, mediaId: string, ciphertext: Uint8Array): Promise<string> {
    /*
     * RAW BYTES as the body, with the id in the query string.
     *
     * It used to be `{ mediaId, ciphertext }` with the ciphertext base64'd
     * inside JSON. That cost the 4/3 expansion against a 10MB transport
     * ceiling, so the reachable attachment size was ~7.1MB rather than ~9.5MB,
     * and it cost a multi-megabyte string built 32KB at a time on the JS thread
     * before anything left the device.
     *
     * React Native still base64s an `ArrayBufferView` body at the bridge
     * (`Libraries/Network/convertRequestBody.js`), so the encode is not gone on
     * THIS hop — but it moves to `base64-js` in the platform's own fast path
     * instead of a `String.fromCharCode` loop plus `JSON.stringify`, and what
     * reaches the wire is octets either way. The ceiling is what actually
     * mattered, and the ceiling is the wire.
     */
    const { key } = await this.request<{ key: string }>(
      `/api/topics/${topicId}/chat/media?mediaId=${encodeURIComponent(mediaId)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': CHAT_MEDIA_CONTENT_TYPE },
        body: ciphertext as unknown as BodyInit,
        // Megabytes of ciphertext up a phone's uplink: the ordinary 15s
        // deadline would cut off a transfer that is making progress.
        timeoutMs: UPLOAD_REQUEST_TIMEOUT_MS,
      },
    );
    return key;
  }

  /**
   * Where to fetch an encrypted attachment from, and with what credential.
   *
   * A SPEC rather than the bytes, because this client cannot fetch them: RN's
   * `Response.arrayBuffer()` is not dependable (facebook/react-native#6743), so
   * the download is done by the native filesystem straight to disk — see
   * `lib/chatMediaFiles.ts`. This is the part that needs the session, so it
   * lives here with the token handling and nothing else does.
   *
   * The token is resolved the same way every other request resolves it, which
   * includes refreshing one that is close to expiry. What it does NOT get is
   * the retry-after-401 that `request()` performs, because the download is not
   * ours to retry — a 401 surfaces as a failed fetch with a Reload control,
   * which is a worse outcome than an automatic refresh and a better one than a
   * silent login prompt in the middle of reading a conversation.
   *
   * It also gets no deadline from here, because there is no request here to put
   * one on: the download runs on the native side, on its own clock, and the
   * only thing this method spends time on is resolving the token — which is
   * itself deadlined, since `tryGetToken` refreshes through `refreshOnce`.
   */
  async chatMediaFetchSpec(
    topicId: string,
    key: string,
  ): Promise<{ url: string; headers: Record<string, string> }> {
    const token = await this.tryGetToken();
    if (!token) throw new GuestAuthRequiredError(`/api/topics/${topicId}/chat/media`);
    return {
      url: `${this.baseUrl}/api/topics/${topicId}/chat/media?key=${encodeURIComponent(key)}`,
      headers: { Authorization: `Bearer ${token}` },
    };
  }

  /** Delete an encrypted attachment — used when its message failed to send. */
  async deleteChatMedia(topicId: string, key: string): Promise<void> {
    await this.delete(`/api/topics/${topicId}/chat/media?key=${encodeURIComponent(key)}`);
  }

  /**
   * Tell the server the message referencing this attachment went out, so the
   * unclaimed-object collector leaves it alone (M-1).
   */
  async claimChatMedia(topicId: string, key: string): Promise<void> {
    await this.patch(`/api/topics/${topicId}/chat/media?key=${encodeURIComponent(key)}`);
  }

  /**
   * Upload a local file URI (or data URI) as multipart/form-data to
   * POST /api/upload and return the public URL string.
   * Always requires an authenticated session — surfaces
   * `GuestAuthRequiredError` for guests.
   */
  async uploadFile(
    localUri: string,
    /**
     * The topic this image belongs to. Sent so the object is filed under
     * `topics/{id}/` and a topic deletion sweeps it away with everything else
     * (M-3). Omit ONLY where there is no topic — a profile picture, or an image
     * chosen while a topic is still being created; those land under the
     * uploader and outlive any topic deletion, by construction.
     */
    opts: { topicId?: string; purpose?: 'post' | 'topic' | 'avatar' } = {},
  ): Promise<string> {
    if (this.mode === 'guest') {
      throw new GuestAuthRequiredError('/api/upload');
    }
    const token = await this.resolveTokenAuthenticated();
    const formData = new FormData();
    formData.append('file', {
      uri: localUri,
      name: 'chat-image.jpg',
      type: 'image/jpeg',
    } as unknown as Blob);
    if (opts.purpose) formData.append('purpose', opts.purpose);
    if (opts.topicId) formData.append('topicId', opts.topicId);
    // Same treatment as `request()`: uploads fail on the same networks and are
    // reported by the same screens, so they must not be the one path that still
    // hands `POST /api/upload → 413: …` to a person.
    const res = await this.send(
      `${this.baseUrl}/api/upload`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
        credentials: 'omit',
      },
      '/api/upload',
      // Same reason as `uploadChatMedia`: the clock covers the body going up.
      UPLOAD_REQUEST_TIMEOUT_MS,
    );
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new OpenStoaApiError(
        res.status,
        '/api/upload',
        readServerError(text),
        `POST /api/upload → ${res.status}: ${text}`,
      );
    }
    const { publicUrl } = (await res.json()) as { publicUrl: string };
    return publicUrl;
  }

  /**
   * Best-effort cleanup of R2 images that were uploaded for a draft the user
   * abandoned (compose Reset, screen exit, etc.). Failures are swallowed —
   * the worst case is an orphan in R2, not a broken UI flow.
   */
  async deleteUploadedFiles(urls: string[]): Promise<{ attempted: number; deleted: number; skipped: number } | null> {
    const clean = urls.filter((u) => typeof u === 'string' && u.length > 0);
    if (clean.length === 0) return null;
    if (this.mode === 'guest') return null;
    try {
      const token = await this.tryGetToken();
      if (!token) return null;
      const res = await fetchWithTimeout(
        `${this.baseUrl}/api/upload`,
        {
          method: 'DELETE',
          credentials: 'omit',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ urls: clean }),
        },
        { path: '/api/upload', timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS, method: 'DELETE' },
      );
      if (!res.ok) return null;
      return (await res.json()) as { attempted: number; deleted: number; skipped: number };
    } catch {
      return null;
    }
  }
}

let _client: OpenStoaClient | null = null;

/**
 * Lazily initialise (or refresh) a singleton client tied to the host.
 * Call once OpenStoaApp has resolved a HostApi and reuse via getClient().
 */
export function ensureClient(host: HostApi): OpenStoaClient {
  if (!_client || _client['host'] !== host) {
    _client = new OpenStoaClient({ host });
  }
  return _client;
}

export function getClient(): OpenStoaClient {
  if (!_client) {
    throw new Error('[openstoa-mobile] getClient() called before ensureClient(host)');
  }
  return _client;
}
