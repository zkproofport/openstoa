/**
 * Phase 6 push registration (design §13, D13 near-blind gateway) against a REAL
 * running container over HTTP. POST/DELETE /api/push/register map an opaque
 * client-generated routingHandle → OS push token; there is no user parameter, so
 * a caller can only ever register/delete its OWN token.
 *
 * Covers the Phase 6 edge matrix rows exercised at the HTTP layer:
 *   authz     — guest 401 (POST + DELETE); per-user isolation (no user param)
 *   boundary  — routingHandle/pushToken empty → 400; oversized → 400; at-cap → 201
 *   hostile   — invalid platform → 400; non-JSON body → 400
 *   empty     — missing fields → 400
 *   race      — re-register same handle = rotation (both 201, single row proven
 *               by DELETE removing exactly 1)
 *   platform  — ios AND android both accepted (201)
 *
 * (Content-free dispatch + member-exclusion live in the unit suite — push.test.ts —
 * since they need an internal provider mock the HTTP surface can't inject.)
 *
 * Runs against E2E_BASE_URL (default local container http://localhost:3200). Each
 * test provisions its own user via /api/auth/dev-login (non-production only).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { PUSH_HANDLE_MAX_BYTES, PUSH_TOKEN_MAX_BYTES } from '@/lib/pushStore';

const BASE = process.env.E2E_BASE_URL || 'http://localhost:3200';

async function devLogin(): Promise<{ token: string; userId: string }> {
  const nickname = `e2e_push_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const res = await fetch(`${BASE}/api/auth/dev-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nickname }),
  });
  if (!res.ok) throw new Error(`dev-login failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return { token: data.token, userId: data.userId };
}

function authed(token: string) {
  return {
    post: (path: string, body: unknown) =>
      fetch(`${BASE}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      }),
    postRaw: (path: string, raw: string) =>
      fetch(`${BASE}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: raw,
      }),
    del: (path: string) => fetch(`${BASE}${path}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }),
  };
}

const REG = '/api/push/register';

describe('P6 push registration (E2E, real container)', () => {
  let userA: { token: string; userId: string };

  beforeAll(async () => {
    const health = await fetch(`${BASE}/api/health`).catch(() => null);
    if (!health || !health.ok) throw new Error(`container not reachable at ${BASE} — start it first`);
    userA = await devLogin();
  });

  describe('authz', () => {
    it('rejects guests (no token) on POST and DELETE', async () => {
      const post = await fetch(`${BASE}${REG}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ routingHandle: 'h', pushToken: 't', platform: 'ios' }),
      });
      expect(post.status).toBe(401);
      const del = await fetch(`${BASE}${REG}?routingHandle=h`, { method: 'DELETE' });
      expect(del.status).toBe(401);
    });

    it('is per-user scoped: user B cannot delete user A\'s handle (no user param exists)', async () => {
      const a = authed(userA.token);
      expect((await a.post(REG, { routingHandle: 'iso-handle', pushToken: 'tok-a', platform: 'ios' })).status).toBe(201);

      const userB = await devLogin();
      // B deleting the same handle string only affects B's own (empty) namespace.
      const bDel = await authed(userB.token).del(`${REG}?routingHandle=iso-handle`);
      expect(bDel.status).toBe(200);
      expect((await bDel.json()).removed).toBe(0);

      // A's handle is still there → A removes exactly its own 1 row.
      const aDel = await a.del(`${REG}?routingHandle=iso-handle`);
      expect((await aDel.json()).removed).toBe(1);
    });
  });

  describe('platform branch', () => {
    it('accepts both ios and android', async () => {
      const a = authed(userA.token);
      expect((await a.post(REG, { routingHandle: 'p-ios', pushToken: 'tok', platform: 'ios' })).status).toBe(201);
      expect((await a.post(REG, { routingHandle: 'p-and', pushToken: 'tok', platform: 'android' })).status).toBe(201);
    });
  });

  describe('validation (hostile / boundary / empty)', () => {
    it('rejects invalid platform, missing fields, and non-JSON with 400', async () => {
      const a = authed(userA.token);
      expect((await a.post(REG, { routingHandle: 'h', pushToken: 't', platform: 'web' })).status).toBe(400);
      expect((await a.post(REG, { routingHandle: 'h', pushToken: 't' })).status).toBe(400); // missing platform
      expect((await a.post(REG, { pushToken: 't', platform: 'ios' })).status).toBe(400); // missing routingHandle
      expect((await a.post(REG, { routingHandle: 'h', platform: 'ios' })).status).toBe(400); // missing pushToken
      expect((await a.post(REG, {})).status).toBe(400);
      expect((await a.postRaw(REG, 'not json')).status).toBe(400);
    });

    it('rejects empty and whitespace-only routingHandle/pushToken', async () => {
      const a = authed(userA.token);
      expect((await a.post(REG, { routingHandle: '', pushToken: 't', platform: 'ios' })).status).toBe(400);
      expect((await a.post(REG, { routingHandle: '   ', pushToken: 't', platform: 'ios' })).status).toBe(400);
      expect((await a.post(REG, { routingHandle: 'h', pushToken: '', platform: 'ios' })).status).toBe(400);
      expect((await a.post(REG, { routingHandle: 'h', pushToken: '   ', platform: 'ios' })).status).toBe(400);
    });

    it('enforces size caps (SI-4): cap+1 → 400, at-cap → 201', async () => {
      const a = authed(userA.token);
      const overHandle = 'x'.repeat(PUSH_HANDLE_MAX_BYTES + 1);
      const overToken = 'y'.repeat(PUSH_TOKEN_MAX_BYTES + 1);
      expect((await a.post(REG, { routingHandle: overHandle, pushToken: 't', platform: 'ios' })).status).toBe(400);
      expect((await a.post(REG, { routingHandle: 'h', pushToken: overToken, platform: 'ios' })).status).toBe(400);

      const atHandle = 'x'.repeat(PUSH_HANDLE_MAX_BYTES);
      const atToken = 'y'.repeat(PUSH_TOKEN_MAX_BYTES);
      expect((await a.post(REG, { routingHandle: atHandle, pushToken: atToken, platform: 'android' })).status).toBe(201);
    });
  });

  describe('register / rotate / delete', () => {
    it('re-registering the same handle rotates (both 201, single row → DELETE removes 1)', async () => {
      const u = await devLogin();
      const a = authed(u.token);
      expect((await a.post(REG, { routingHandle: 'rot', pushToken: 'tok-old', platform: 'ios' })).status).toBe(201);
      expect((await a.post(REG, { routingHandle: 'rot', pushToken: 'tok-new', platform: 'android' })).status).toBe(201);
      // If the second call had duplicated instead of upserting, removed would be 2.
      const del = await a.del(`${REG}?routingHandle=rot`);
      expect(del.status).toBe(200);
      expect((await del.json()).removed).toBe(1);
    });

    it('DELETE requires routingHandle and is a no-op for unknown handles', async () => {
      const a = authed(userA.token);
      expect((await a.del(REG)).status).toBe(400); // missing routingHandle
      const del = await a.del(`${REG}?routingHandle=never-registered`);
      expect(del.status).toBe(200);
      expect((await del.json()).removed).toBe(0);
    });
  });
});
