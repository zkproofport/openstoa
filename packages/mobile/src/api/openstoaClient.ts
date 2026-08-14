import type { HostApi } from '@openstoa/miniapp-bridge';
import type { RefreshResponse } from '@openstoa/api-types';

export type ClientMode = 'unknown' | 'guest' | 'authenticated';

/**
 * Thrown when an API call requires authentication but the user is in guest
 * mode (or no token can be obtained). Screens should catch this and surface
 * the SignInSheet instead of treating it as a hard error.
 */
export class GuestAuthRequiredError extends Error {
  readonly kind = 'GUEST_AUTH_REQUIRED' as const;
  constructor(public readonly path: string) {
    super(`Sign-in required for ${path}`);
    this.name = 'GuestAuthRequiredError';
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
          const res = await fetch(`${this.baseUrl}/api/auth/refresh`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${currentToken}` },
            credentials: 'omit',
          });
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

  async request<T>(path: string, init: RequestOptions = {}): Promise<T> {
    const method = (init.method ?? 'GET').toUpperCase();
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
    let res = await fetch(url, { ...init, headers, credentials: 'omit' });
    if (res.status === 401) {
      // Guest (or anyone without a token) → don't auto-trigger login.
      // The screen catches GuestAuthRequiredError and shows SignInSheet.
      if (this.mode !== 'authenticated' || !token) {
        throw new GuestAuthRequiredError(path);
      }
      this.invalidateToken();
      token = await this.resolveTokenAuthenticated(true);
      headers.set('Authorization', `Bearer ${token}`);
      res = await fetch(url, { ...init, headers, credentials: 'omit' });
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`${method} ${path} → ${res.status}: ${text}`);
    }

    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  get<T>(path: string, options?: RequestOptions): Promise<T> {
    return this.request<T>(path, { ...options, method: 'GET' });
  }
  post<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
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
  async uploadChatMedia(topicId: string, mediaId: string, ciphertextB64: string): Promise<string> {
    const { key } = await this.post<{ key: string }>(`/api/topics/${topicId}/chat/media`, {
      mediaId,
      ciphertext: ciphertextB64,
    });
    return key;
  }

  /** Fetch an encrypted attachment's ciphertext (base64) for local decryption. */
  async fetchChatMedia(topicId: string, key: string): Promise<string> {
    const { ciphertext } = await this.get<{ ciphertext: string }>(
      `/api/topics/${topicId}/chat/media?key=${encodeURIComponent(key)}`,
    );
    return ciphertext;
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
    const res = await fetch(`${this.baseUrl}/api/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
      credentials: 'omit',
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`POST /api/upload → ${res.status}: ${text}`);
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
      const res = await fetch(`${this.baseUrl}/api/upload`, {
        method: 'DELETE',
        credentials: 'omit',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ urls: clean }),
      });
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
