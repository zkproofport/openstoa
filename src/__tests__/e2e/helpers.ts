import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { randomBytes } from 'crypto';
import { R2_HOSTS } from '@/lib/imageCacheBuster';
import {
  OBJECT_STORAGE_UNCONFIGURED_MESSAGE,
  OBJECT_STORAGE_UNCONFIGURED_STATUS,
} from '@/lib/objectStorageStatus';

const BASE_URL = process.env.E2E_BASE_URL || 'https://stg-community.zkproofport.app';

export function getBaseUrl(): string {
  return BASE_URL;
}

/**
 * A fresh, high-entropy, IP-shaped synthetic identity — 8 random hex groups
 * joined like an IPv6 address (`randomBytes(2)` × 8, ~2^128 space), sent as
 * `X-Forwarded-For` on every `public*` request below (M-7,
 * `src/lib/mediaRateLimit.ts`).
 *
 * WHY EVERY ANONYMOUS E2E REQUEST NEEDS ITS OWN IDENTITY, LOCALLY, EVEN
 * THOUGH PRODUCTION NEEDS NONE OF THIS:
 *
 * `GET /api/media/{key}` (and any future anonymous-capable rate-limited
 * route) keys its budget on `X-Forwarded-For` when there's no session. A
 * request that sends NO such header collapses into `mediaRateLimit.ts`'s
 * shared `'unknown'` bucket — which is the correct, DELIBERATE behavior for
 * production (Cloud Run's own frontend always sets a real client IP there;
 * `'unknown'` is reachable only when nothing upstream can supply one, i.e.
 * never, in a real deployment) but is exactly the wrong shape for an E2E
 * suite: dozens of unrelated test files, each simulating a DIFFERENT
 * anonymous visitor, would otherwise all fall into that ONE shared bucket
 * and silently spend each other's budget. That is precisely what broke
 * `media-rate-limit.test.ts`'s own boundary test the first time — not
 * because of THIS mechanism (that test builds its identity explicitly, for
 * a different reason — see its own file), but as a preview of the exact
 * failure mode this default closes off: an unrelated file's guest reads,
 * run first, exhausting a bucket a LATER file's guest read would otherwise
 * have inherited.
 *
 * Attaching a real, freshly-random `X-Forwarded-For` to every `public*`
 * call means:
 *   - No anonymous E2E request ever lands in `'unknown'`, so that bucket
 *     stays exactly as unreachable in the E2E suite as it is in production.
 *   - No two `public*` calls — even in the same test, even in the same
 *     file, even in two back-to-back full-suite runs — can ever share a
 *     rate-limit identity BY ACCIDENT, because each gets its own 2^128-space
 *     draw. A test whose whole point IS accumulating one identity's spend
 *     (`media-rate-limit.test.ts`) does not go through `public*` at all —
 *     it builds its own explicit, intentionally-reused header, which this
 *     default does not touch or interfere with.
 *   - A test asserting an anonymous caller gets REFUSED (401/403/429) keeps
 *     getting refused for the real reason (visibility, or genuinely being
 *     over budget) — this only removes accidental cross-file budget
 *     inheritance, never exempts anyone from the limit itself.
 */
/**
 * WHAT KIND OF CLIENT THE SUITE IS PRETENDING TO BE.
 *
 * Chat, MLS and TAK are refused to a `web` session — the keys live on a phone
 * and a browser that joined a group could only advance epochs and post
 * ciphertext nobody would ever open. A login that declares nothing defaults to
 * `web`, which is the safe answer for a real client and the wrong one here:
 * these tests stand in for the mobile app, so they have to say so.
 *
 * The device id is per-process rather than per-call. Sharing one id across the
 * suite is what makes it ONE phone: distinct ids would look like a fleet of
 * second devices and trip the one-phone rule against the suite itself.
 */
export const E2E_DEVICE_HEADERS: Record<string, string> = {
  'x-openstoa-device-kind': 'mobile',
  'x-openstoa-device-id': `e2e-suite-${randomBytes(8).toString('hex')}`,
};

export function freshSyntheticIp(): string {
  return Array.from({ length: 8 }, () => randomBytes(2).toString('hex')).join(':');
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
    headers: { 'Content-Type': 'application/json', ...E2E_DEVICE_HEADERS },
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

/** Make an authenticated PUT request as the second user */
export async function secondUserPut(path: string, body?: unknown): Promise<Response> {
  const { token } = await getSecondUserToken();
  return fetch(`${BASE_URL}${path}`, {
    method: 'PUT',
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

/** Make an unauthenticated GET request. Carries a fresh synthetic
 *  `X-Forwarded-For` by default — see `freshSyntheticIp`'s doc comment. */
export async function publicGet(path: string): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, { headers: { 'X-Forwarded-For': freshSyntheticIp() } });
}

/** Make an unauthenticated POST request. Carries a fresh synthetic
 *  `X-Forwarded-For` by default — see `freshSyntheticIp`'s doc comment. */
export async function publicPost(path: string, body?: unknown): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': freshSyntheticIp(),
      /*
       * The device declaration rides on EVERY call, not just the ones that mint
       * a session — because several files sign in through `publicPost` and
       * patching them one at a time is how the next file added forgets. The
       * headers are inert on a request that does not create a session.
       *
       * Without it those logins default to `web`, and chat / MLS / TAK come
       * back 403 in tests that have nothing to do with device kinds.
       */
      ...E2E_DEVICE_HEADERS,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

/** Make an unauthenticated PUT request. Carries a fresh synthetic
 *  `X-Forwarded-For` by default — see `freshSyntheticIp`'s doc comment. */
export async function publicPut(path: string, body?: unknown): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': freshSyntheticIp() },
    body: body ? JSON.stringify(body) : undefined,
  });
}

/** Make an unauthenticated DELETE request. Carries a fresh synthetic
 *  `X-Forwarded-For` by default — see `freshSyntheticIp`'s doc comment. */
export async function publicDelete(path: string): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, { method: 'DELETE', headers: { 'X-Forwarded-For': freshSyntheticIp() } });
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

/** Make an unauthenticated PATCH request. Carries a fresh synthetic
 *  `X-Forwarded-For` by default — see `freshSyntheticIp`'s doc comment. */
export async function publicPatch(path: string, body?: unknown): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': freshSyntheticIp() },
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
        `  why:     POST /api/upload answered ${OBJECT_STORAGE_UNCONFIGURED_STATUS} — "${serverMessage}"\n` +
        `           getR2Config() in src/lib/r2.ts refuses to run without credentials rather than\n` +
        `           falling back to a default, so this is missing configuration, not a broken upload\n` +
        `           path. WHICH variable is unset is in the CONTAINER LOG, never in the response:\n` +
        `           \`docker logs proofport-community | grep "not configured"\`.\n` +
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
 * The `error` field of a JSON body, or the raw text when it is not JSON.
 *
 * Total by design: a body that does not parse, or carries no `error`, is not an
 * exception to handle — it simply is not the unconfigured signal, and the caller
 * treats it as the real failure it is.
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

/**
 * Is this environment simply WITHOUT object storage, as opposed to broken?
 *
 * Keyed on the ROUTE'S STATUS, because the previous version could never fire.
 * It required the response BODY to carry `getR2Config()`'s sentence naming five
 * environment variables — but `/api/upload` sends every failure through
 * `unhandledRouteError`, whose body is deliberately generic
 * (`{ error: 'Internal server error', errorId }`) and correctly so. The literal
 * never reached here, `isMissingR2Credentials` never returned true, and the
 * whole BLOCK path below was unreachable: an unconfigured environment could only
 * ever report as ten unexplained failures across eight files, each pointing at
 * application behaviour.
 *
 * "Block", not "skip": `requireObjectStorage` throws — these cases fail either
 * way. What this decides is whether they fail NAMING the missing dependency or
 * looking like an application bug.
 *
 * `/api/upload` now answers 503 with a CLASS — no variable names, no values —
 * and that is the contract. The sentence in `src/lib/r2.ts` is free to be
 * reworded; this status is not.
 *
 * Still strict in the direction that matters: 503 is the ONLY excuse. A 500, a
 * 502, a timeout or a bad publicUrl remain real failures, because a guard that
 * excuses too much is worse than no guard.
 */
export function isMissingR2Credentials(status: number, bodyText: string): boolean {
  if (status !== OBJECT_STORAGE_UNCONFIGURED_STATUS) return false;
  return errorMessageOf(bodyText) === OBJECT_STORAGE_UNCONFIGURED_MESSAGE;
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
        `This is NOT the missing-storage case — that is a 503 carrying ` +
        `"Object storage is not configured" — so it is a genuine upload failure and is ` +
        `NOT excused by the object-storage guard.`,
    );
  }

  const { publicUrl } = (await res.json()) as { publicUrl: string };
  // M-6 (docs/design/media-bucket-privatisation.md): `R2_PUBLIC_URL` is now
  // root-relative (`/api/media`) in every real deployment, so `publicUrl`
  // itself carries no hostname to validate — `new URL(publicUrl)` with no
  // base throws on a relative string. A relative URL trivially IS "our own
  // media": it can only ever resolve against the app's own origin, which is
  // exactly what R2_HOSTS/isKnownMediaHost exists to establish for the
  // absolute case. `BASE_URL` (this env's own target) is the origin for it.
  if (publicUrl.startsWith('/')) {
    return { ok: true, origin: new URL(BASE_URL).origin };
  }
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

/**
 * Resolve a `publicUrl` returned by `POST /api/upload` into something
 * directly `fetch()`-able (M-6, docs/design/media-bucket-privatisation.md).
 * Node's `fetch` throws on a bare relative string with no base, exactly the
 * shape every real deployment now returns — this is the SAME resolution a
 * browser does for free (same-origin) and the mini-app does explicitly.
 *
 * Deliberately re-exports the mini-app's REAL `absolutizeMediaUrl`, not a
 * reimplementation — an E2E test asserting "the mobile helper produces a URL
 * that actually resolves" is only meaningful if it runs the actual shipped
 * function against a real server, not a copy that could silently drift from
 * it.
 */
export { absolutizeMediaUrl as resolveMediaUrl } from '../../../packages/mobile/src/utils/absolutizeMediaUrl';

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

/**
 * The `content` of a `<meta property="$key" content="...">` (or
 * `name="$key"`, or attributes in the reverse order — Next's own renderer
 * emits `property` first, but this stays permissive so a future change to
 * how Next serializes the tag doesn't quietly break every metadata E2E
 * assertion). Mirrors the dual-pattern approach `extractMeta` in
 * `src/app/api/og/route.ts` already uses for the SAME reason, on the OTHER
 * side of OG handling (that one scrapes third-party pages; this one reads
 * back what our OWN `generateMetadata` rendered).
 *
 * Returns `null` when the tag is absent — never throws, so a test asserting
 * "this tag is missing" reads as a clean `null` check rather than a caught
 * exception.
 */
export function metaContent(html: string, key: string): string | null {
  for (const attr of ['property', 'name']) {
    const forward = new RegExp(`<meta[^>]+${attr}=["']${key}["'][^>]+content=["']([^"']*)["']`, 'i');
    const reverse = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+${attr}=["']${key}["']`, 'i');
    const m = html.match(forward) ?? html.match(reverse);
    if (m) return m[1];
  }
  return null;
}

/** The `<title>...</title>` text, or `null` if the tag is absent/empty. */
export function pageTitle(html: string): string | null {
  const m = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  return m ? m[1] : null;
}

/** The `href` of `<link rel="canonical" href="...">`, in either attribute order. */
export function canonicalLink(html: string): string | null {
  const forward = html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']*)["']/i);
  if (forward) return forward[1];
  const reverse = html.match(/<link[^>]+href=["']([^"']*)["'][^>]+rel=["']canonical["']/i);
  return reverse ? reverse[1] : null;
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
