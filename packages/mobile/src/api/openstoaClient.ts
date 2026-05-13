import type { HostApi } from '@openstoa/miniapp-bridge';
import type { RefreshResponse } from '@openstoa/api-types';

export interface OpenStoaClientOptions {
  host: HostApi;
  /**
   * Refresh threshold in milliseconds before token expiry. When the
   * client believes the token has fewer than this many ms left it will
   * fire /api/auth/refresh proactively. Defaults to 1 day.
   */
  refreshLeadMs?: number;
}

export class OpenStoaClient {
  private readonly host: HostApi;
  private readonly baseUrl: string;
  private readonly refreshLeadMs: number;
  private cachedToken: string | null = null;
  private cachedExpiresAt: number | null = null;
  private inflightRefresh: Promise<string> | null = null;

  constructor(opts: OpenStoaClientOptions) {
    this.host = opts.host;
    this.baseUrl = opts.host.getEnvironment().openstoaBaseUrl.replace(/\/$/, '');
    this.refreshLeadMs = opts.refreshLeadMs ?? 24 * 60 * 60 * 1000;
  }

  /** Force-clear the in-memory token cache (e.g. after logout). */
  invalidateToken(): void {
    this.cachedToken = null;
    this.cachedExpiresAt = null;
  }

  /** Canonical OpenStoa server origin (no trailing slash). Use for share links. */
  getBaseUrl(): string {
    return this.baseUrl;
  }

  private async resolveToken(force = false): Promise<string> {
    if (!force && this.cachedToken) {
      const expiresIn = (this.cachedExpiresAt ?? 0) - Date.now();
      if (expiresIn > this.refreshLeadMs) {
        return this.cachedToken;
      }
      // Within refresh window — try a sliding refresh first.
      try {
        return await this.refreshOnce(this.cachedToken);
      } catch {
        // fall through to host re-login
      }
    }

    const token = await this.host.getOpenStoaToken();
    if (token) {
      this.cachedToken = token;
      // We don't know exp without decoding; let server tell us next refresh.
      this.cachedExpiresAt = Date.now() + this.refreshLeadMs * 7; // optimistic
      return token;
    }

    const auth = await this.host.loginToOpenStoa();
    this.cachedToken = auth.token;
    this.cachedExpiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
    return auth.token;
  }

  private refreshOnce(currentToken: string): Promise<string> {
    if (!this.inflightRefresh) {
      this.inflightRefresh = (async () => {
        try {
          const res = await fetch(`${this.baseUrl}/api/auth/refresh`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${currentToken}` },
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

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    let token = await this.resolveToken();
    const url = `${this.baseUrl}${path}`;
    const headers = new Headers(init.headers ?? {});
    headers.set('Authorization', `Bearer ${token}`);
    if (init.body && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }

    let res = await fetch(url, { ...init, headers });
    if (res.status === 401) {
      // Token may have been revoked or expired — force a fresh login once.
      this.invalidateToken();
      token = await this.host.loginToOpenStoa({ force: true }).then((a) => a.token);
      headers.set('Authorization', `Bearer ${token}`);
      res = await fetch(url, { ...init, headers });
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`${init.method ?? 'GET'} ${path} → ${res.status}: ${text}`);
    }

    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>(path, { method: 'GET' });
  }
  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>(path, {
      method: 'POST',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>(path, {
      method: 'PATCH',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  put<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>(path, {
      method: 'PUT',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  delete<T = void>(path: string): Promise<T> {
    return this.request<T>(path, { method: 'DELETE' });
  }

  /**
   * Upload a local file URI (or data URI) as multipart/form-data to
   * POST /api/upload and return the public URL string.
   * Handles auth automatically via resolveToken().
   */
  async uploadFile(localUri: string): Promise<string> {
    const token = await this.resolveToken();
    const formData = new FormData();
    formData.append('file', {
      uri: localUri,
      name: 'chat-image.jpg',
      type: 'image/jpeg',
    } as unknown as Blob);
    const res = await fetch(`${this.baseUrl}/api/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`POST /api/upload → ${res.status}: ${text}`);
    }
    const { publicUrl } = (await res.json()) as { publicUrl: string };
    return publicUrl;
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
