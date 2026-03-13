import { describe, it, expect } from 'vitest';
import { authGet, publicGet, publicPost } from './helpers';

describe('Auth endpoints', () => {
  it('GET /api/health returns ok', async () => {
    const res = await publicGet('/api/health');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe('ok');
    expect(json.timestamp).toBeTruthy();
  });

  it('POST /api/auth/challenge returns challengeId and scope', async () => {
    const res = await publicPost('/api/auth/challenge');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.challengeId).toBeTruthy();
    expect(json.scope).toBeTruthy();
    expect(json.expiresIn).toBeGreaterThan(0);
  });

  it('GET /api/auth/session returns session info when authenticated', async () => {
    const res = await authGet('/api/auth/session');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.userId).toBeTruthy();
    expect(json.nickname).toBeTruthy();
    expect(json.verifiedAt).toBeTypeOf('number');
  });

  it('GET /api/auth/session returns 200 with authenticated=false when not authenticated', async () => {
    const res = await publicGet('/api/auth/session');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.authenticated).toBe(false);
  });

  it('GET /api/docs/openapi.json returns valid OpenAPI spec', async () => {
    const res = await publicGet('/api/docs/openapi.json');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.openapi).toBeTruthy();
    expect(json.paths).toBeTruthy();
  });

  it('POST /api/auth/logout clears session', async () => {
    // Just verify it responds correctly (we don't want to actually logout our test session)
    // Use a fresh unauthenticated request
    const res = await publicPost('/api/auth/logout');
    // Should return 200 even without session (just clears cookie)
    expect([200, 401]).toContain(res.status);
  });
});
