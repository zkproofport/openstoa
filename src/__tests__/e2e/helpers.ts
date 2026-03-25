import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

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
    body: JSON.stringify({ nickname: `e2e_second_${Date.now().toString(36)}` }),
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

/** Get admin token from proof-gated login cache (.e2e-token-cache-a.json) */
function getAdminToken(): string {
  if (adminTokenCache) return adminTokenCache;
  const cacheFile = resolve(__dirname, '../../../.e2e-token-cache-a.json');
  if (!existsSync(cacheFile)) {
    throw new Error('Admin token not available — run proof-gated-topics.test.ts first to create .e2e-token-cache-a.json');
  }
  const cached = JSON.parse(readFileSync(cacheFile, 'utf-8'));
  adminTokenCache = cached.token;
  return adminTokenCache!;
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
