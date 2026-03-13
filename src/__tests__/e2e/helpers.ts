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

/** Make an authenticated DELETE request */
export async function authDelete(path: string): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${getAuthToken()}` },
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
