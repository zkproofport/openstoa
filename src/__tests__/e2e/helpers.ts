import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { R2_HOSTS } from '@/lib/imageCacheBuster';

const BASE_URL = process.env.E2E_BASE_URL || 'https://stg-community.zkproofport.app';

export function getBaseUrl(): string {
  return BASE_URL;
}

export function getAuthToken(): string {
  const token = process.env.E2E_AUTH_TOKEN;
  if (!token) throw new Error('E2E_AUTH_TOKEN not set — run global-setup first or provide manually');
  return token;
}

export function getUserId(): string {
  const id = process.env.E2E_USER_ID;
  if (!id) throw new Error('E2E_USER_ID not set');
  return id;
}

// ── Second user helpers (for tests that need a different user) ──

let secondUserCache: { token: string; userId: string } | null = null;

/** Create a second test user via dev-login endpoint (non-production only) */
export async function getSecondUserToken(): Promise<{ token: string; userId: string }> {
  if (secondUserCache) return secondUserCache;

  const res = await fetch(`${BASE_URL}/api/auth/dev-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nickname: `e2e_second_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}` }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`dev-login failed: ${res.status} ${err}`);
  }

  const data = await res.json();
  secondUserCache = { token: data.token, userId: data.userId };
  return secondUserCache;
}

/** Make an authenticated GET request as the second user */
export async function secondUserGet(path: string): Promise<Response> {
  const { token } = await getSecondUserToken();
  return fetch(`${BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

/** Make an authenticated POST request as the second user */
export async function secondUserPost(path: string, body?: unknown): Promise<Response> {
  const { token } = await getSecondUserToken();
  return fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

/** Make an authenticated PATCH request as the second user */
export async function secondUserPatch(path: string, body?: unknown): Promise<Response> {
  const { token } = await getSecondUserToken();
  return fetch(`${BASE_URL}${path}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

/** Make an authenticated DELETE request as the second user */
export async function secondUserDelete(path: string, body?: unknown): Promise<Response> {
  const { token } = await getSecondUserToken();
  return fetch(`${BASE_URL}${path}`, {
    method: 'DELETE',
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      Authorization: `Bearer ${token}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

/** Make an authenticated GET request */
export async function authGet(path: string): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${getAuthToken()}` },
  });
}

/** Make an authenticated POST request with JSON body */
export async function authPost(path: string, body?: unknown): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getAuthToken()}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

/** Make an authenticated PUT request with JSON body */
export async function authPut(path: string, body?: unknown): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getAuthToken()}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

/** Make an authenticated DELETE request with optional JSON body */
export async function authDelete(path: string, body?: unknown): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, {
    method: 'DELETE',
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      Authorization: `Bearer ${getAuthToken()}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

/** Make an authenticated PATCH request with JSON body */
export async function authPatch(path: string, body?: unknown): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getAuthToken()}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

/** Make an unauthenticated GET request */
export async function publicGet(path: string): Promise<Response> {
  return fetch(`${BASE_URL}${path}`);
}

/** Make an unauthenticated POST request */
export async function publicPost(path: string, body?: unknown): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

/** Make an unauthenticated PUT request */
export async function publicPut(path: string, body?: unknown): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

/** Make an unauthenticated DELETE request */
export async function publicDelete(path: string): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, { method: 'DELETE' });
}

// ── Admin user helpers (uses proof-gated login cache — admin role) ──

let adminTokenCache: string | null = null;

/** Mirrors CACHE_TTL in proof-gated-topics.test.ts (24h JWT, 1h margin). */
const ADMIN_CACHE_TTL_MS = 23 * 60 * 60 * 1000;

interface ProofTokenCache {
  token?: string;
  userId?: string;
  createdAt?: number;
  baseUrl?: string;
}

/**
 * Admin token from the proof-gated login cache (.e2e-token-cache-a.json).
 *
 * The cache is validated, not merely parsed: an expired token or one minted
 * against a different deployment is rejected by the server as a bare 401,
 * which reads like "the blind route is broken on this environment" instead of
 * "this run has no admin credential". Fail with the real reason instead.
 */
function getAdminToken(): string {
  if (adminTokenCache) return adminTokenCache;

  const cacheFile = resolve(__dirname, '../../../.e2e-token-cache-a.json');
  const how =
    'Admin actions need a proof-gated login: run src/__tests__/e2e/proof-gated-topics.test.ts against ' +
    `${BASE_URL} to mint a fresh token (Google OIDC device flow), and make sure that user has ` +
    "role='admin' in that deployment's database.";

  if (!existsSync(cacheFile)) {
    throw new Error(`Admin token not available: ${cacheFile} does not exist. ${how}`);
  }

  let cached: ProofTokenCache;
  try {
    cached = JSON.parse(readFileSync(cacheFile, 'utf-8'));
  } catch (e) {
    throw new Error(
      `Admin token not available: ${cacheFile} is not valid JSON (${e instanceof Error ? e.message : String(e)}). ${how}`,
    );
  }

  if (!cached.token || typeof cached.createdAt !== 'number') {
    throw new Error(`Admin token not available: ${cacheFile} is missing token/createdAt. ${how}`);
  }

  const ageHours = (Date.now() - cached.createdAt) / 3_600_000;
  if (ageHours * 3_600_000 >= ADMIN_CACHE_TTL_MS) {
    throw new Error(
      `Admin token not available: ${cacheFile} was minted ${ageHours.toFixed(1)}h ago and the session ` +
        `JWT only lives 24h — sending it would surface as a misleading 401. ${how}`,
    );
  }

  if (!cached.baseUrl) {
    throw new Error(
      `Admin token not available: ${cacheFile} does not record which deployment it was minted against, ` +
        `so it cannot be trusted for ${BASE_URL} (a token from another environment fails as a bare 401). ${how}`,
    );
  }
  if (cached.baseUrl !== BASE_URL) {
    throw new Error(
      `Admin token not available: ${cacheFile} was minted against ${cached.baseUrl}, but this run targets ` +
        `${BASE_URL}. Sessions are not portable between deployments. ${how}`,
    );
  }

  adminTokenCache = cached.token;
  return adminTokenCache;
}

/**
 * Assert an admin credential exists before a test depends on one, so a missing
 * or stale credential is reported as itself rather than as whatever the
 * un-performed admin action would have changed.
 */
export function requireAdminToken(): void {
  getAdminToken();
}

/** Make an authenticated POST request as admin */
export async function adminPost(path: string, body?: unknown): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getAdminToken()}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

/** Make an authenticated GET request as admin */
export async function adminGet(path: string): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${getAdminToken()}` },
  });
}

/** Make an unauthenticated PATCH request */
export async function publicPatch(path: string, body?: unknown): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

// ── CDN helpers ───────────────────────────────────────────────────────
//
// The media host is NOT a constant: the server builds every public URL from
// its own `R2_PUBLIC_URL` (see `src/lib/r2.ts`), which differs per deployment
// (`stg-cdn.` on staging, `media.` on production) and is absent entirely on a
// plain local container. Hardcoding one of them makes the test assert on the
// author's environment instead of the one under test, so the origin is
// discovered from the app itself and then checked against the app's own R2
// host list — "some URL" can still never pass.

const CDN_PROBE_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';

class ObjectStorageUnavailable extends Error {
  constructor(baseUrl: string, serverMessage: string) {
    super(
      `EXTERNAL DEPENDENCY UNAVAILABLE — object storage (Cloudflare R2) for ${baseUrl}\n` +
        `  why:     POST /api/upload answered 500 and the deployment reported: "${serverMessage}"\n` +
        `           getR2Config() in src/lib/r2.ts refuses to run without credentials rather than\n` +
        `           falling back to a default, so this is missing configuration, not a broken upload\n` +
        `           path. It names all five vars whenever ANY of them is unset, so the route cannot\n` +
        `           say which one is actually absent.\n` +
        `  restore: set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME and\n` +
        `           R2_PUBLIC_URL on the target deployment, or run these cases against one where\n` +
        `           object storage is already configured.\n` +
        `  scope:   every upload-backed case is BLOCKED, not failing. Nothing is mocked, and an\n` +
        `           upload that fails for any OTHER reason is still reported as a real failure.`,
    );
    this.name = 'ObjectStorageUnavailable';
  }
}

/**
 * True only for the exact condition "this deployment has no R2 credentials".
 *
 * Deliberately narrow: it matches the literal `getR2Config()` throws in
 * src/lib/r2.ts, surfaced by the route's catch-all as a 500. A 500 from a
 * genuine upload fault (bad bucket, expired key, S3 error, timeout) does NOT
 * match and must keep failing loudly — excusing those would let a broken
 * upload path masquerade as an unconfigured environment.
 */
function errorMessageOf(bodyText: string): string {
  try {
    const parsed = JSON.parse(bodyText) as { error?: unknown };
    if (typeof parsed.error === 'string') return parsed.error;
  } catch {
    // Non-JSON body — use the raw text.
  }
  return bodyText;
}

function isMissingR2Credentials(status: number, bodyText: string): boolean {
  if (status !== 500) return false;
  const message = errorMessageOf(bodyText);
  return (
    message.includes('R2_ACCOUNT_ID') &&
    message.includes('R2_PUBLIC_URL') &&
    message.includes('environment variables are required')
  );
}

type StorageProbe = { ok: true; origin: string } | { ok: false; serverMessage: string };

/** One probe per run, shared by every caller (upload gate and CDN assertions). */
let storageProbe: Promise<StorageProbe> | null = null;

async function probeObjectStorage(): Promise<StorageProbe> {
  const override = process.env.E2E_CDN_ORIGIN;
  if (override) return { ok: true, origin: new URL(override).origin };

  const form = new FormData();
  const bytes = new Uint8Array(Buffer.from(CDN_PROBE_PNG, 'base64'));
  form.append('file', new Blob([bytes], { type: 'image/png' }), `cdn-probe-${Date.now()}.png`);
  form.append('purpose', 'post');

  const res = await fetch(`${BASE_URL}/api/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${getAuthToken()}` },
    body: form,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    if (isMissingR2Credentials(res.status, text)) {
      return { ok: false, serverMessage: errorMessageOf(text) };
    }
    // Not the unconfigured case — a real upload failure, reported as one.
    throw new Error(
      `POST /api/upload failed with ${res.status} against ${BASE_URL}: ${text}\n` +
        `This is NOT the missing-credential case — the response does not carry getR2Config()'s ` +
        `"…environment variables are required" message — so it is a genuine upload failure and is ` +
        `NOT excused by the object-storage guard.`,
    );
  }

  const { publicUrl } = (await res.json()) as { publicUrl: string };
  if (!isKnownMediaHost(new URL(publicUrl).hostname)) {
    throw new Error(
      `POST /api/upload returned ${publicUrl}, whose host is neither one of the app's known R2 hosts ` +
        `(${R2_HOSTS.join(', ')}) nor a local address — either R2_PUBLIC_URL is misconfigured or ` +
        `R2_HOSTS in src/lib/imageCacheBuster.ts is missing this host (which would also break ` +
        `cache busting).`,
    );
  }
  return { ok: true, origin: new URL(publicUrl).origin };
}

/**
 * Assert this environment can store objects at all, before a case depends on
 * it. Blocks on the missing-credential condition only; every other upload
 * fault still surfaces as a real failure.
 */
export async function requireObjectStorage(): Promise<string> {
  const result = await (storageProbe ??= probeObjectStorage());
  if (!result.ok) throw new ObjectStorageUnavailable(BASE_URL, result.serverMessage);
  return result.origin;
}

/** The origin `POST /api/upload` serves media from in THIS environment. */
export async function getCdnOrigin(): Promise<string> {
  return requireObjectStorage();
}

/**
 * A media host this machine is serving itself — the dev stack's MinIO, reached
 * over the LAN IP `scripts/dev.sh` detects (or loopback when it cannot).
 *
 * Deliberately a host-CLASS test rather than a list: the local address is the
 * developer's own LAN IP and cannot be written down in advance. A public host
 * that is not ours is neither in `R2_HOSTS` nor private, so a genuinely
 * misconfigured `R2_PUBLIC_URL` still fails.
 */
function isLocalMediaHost(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '::1' || hostname === '[::1]') return true;
  if (hostname.endsWith('.local')) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!v4) return false;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

/**
 * Where media is allowed to come from in THIS environment: the deployment's
 * CDN, or the local object store when the stack is running one.
 *
 * Both are "the app's own storage" — the distinction the assertion is really
 * making — and only one of them can be enumerated statically.
 */
export function isKnownMediaHost(hostname: string): boolean {
  return R2_HOSTS.includes(hostname) || isLocalMediaHost(hostname);
}

/** Every `<img src="...">` value in an HTML fragment, in document order. */
export function imgSrcs(html: string): string[] {
  return [...html.matchAll(/<img[^>]+src="([^"]*)"/g)].map((m) => m[1]);
}

/** Known R2 media hosts, re-exported so tests assert against the app's own list. */
export { R2_HOSTS };

// ── Cleanup helpers (used by tests' afterAll) ─────────────────────────

/** Delete a topic owned by the primary test user. */
export async function deleteTopic(topicId: string): Promise<Response> {
  return authDelete(`/api/topics/${topicId}`);
}

/** Delete a post owned by the primary test user. */
export async function deletePost(postId: string): Promise<Response> {
  return authDelete(`/api/posts/${postId}`);
}

/** Fetch all categories as `{ id, slug }` for tests that need fixed slugs. */
export async function fetchCategorySlugs(): Promise<Array<{ id: string; slug: string }>> {
  const res = await publicGet('/api/categories');
  const json = await res.json();
  return json.categories.map((c: { id: string; slug: string }) => ({ id: c.id, slug: c.slug }));
}
