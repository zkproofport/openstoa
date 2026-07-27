/**
 * Phase 5 AI-member grant endpoints against a REAL running container over HTTP
 * (no mocks). Covers the edge-case matrix rows the server owns for grant CRUD +
 * authorization + validation:
 *
 *   authz     — guest 401; non-member 403; non-owner member 403; owner 200/201;
 *               member GET 200; bot self-revoke 200.
 *   boundary  — depth 0/1/3 ok, 4 → 400; historyGrant none/full/since_epoch:N/Nd ok, garbage → 400.
 *   empty     — missing aiUserId / cmd → 400.
 *   hostile   — non-owner grant 403; unknown cmd → 400; empty cmd → 400.
 *   race      — concurrent double-revoke is deterministic (exactly one 200, one 404).
 *   contract  — created grant stores cmd/scope and echoes them back (metadata only, SI-1).
 *   D9        — the bot joins with its OWN KeyPackage; its device/leaf differs from any human's
 *               (zero human key sharing), and its last-resort KeyPackage is reusable.
 *
 * The AI `isAI`-enforcement branch (chat send / history read 403 without a grant)
 * is proven at the unit level (src/__tests__/ai-grants.test.ts) because
 * /api/auth/dev-login cannot mint an isAI session.
 *
 * Self-contained: each test provisions users via /api/auth/dev-login (non-prod).
 */
import { describe, it, expect, beforeAll } from 'vitest';

const BASE = process.env.E2E_BASE_URL || 'http://localhost:3200';

async function devLogin(prefix = 'ai'): Promise<{ token: string; userId: string }> {
  const nickname = `e2e_${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
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
    get: (path: string) => fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } }),
    post: (path: string, body?: unknown) =>
      fetch(`${BASE}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    del: (path: string) => fetch(`${BASE}${path}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }),
  };
}

const B64 = (s: string) => Buffer.from(s).toString('base64');
const AI_ID = '0xaibot0000000000000000000000000000000000000000000000000000000001';

describe('P5 AI grants (E2E, real container)', () => {
  let owner: { token: string; userId: string };
  let member: { token: string; userId: string };
  let outsider: { token: string; userId: string };
  let topicId: string;

  beforeAll(async () => {
    const health = await fetch(`${BASE}/api/health`).catch(() => null);
    if (!health || !health.ok) throw new Error(`container not reachable at ${BASE} — start it first`);

    owner = await devLogin('owner');
    member = await devLogin('member');
    outsider = await devLogin('outsider');

    const cats = await authed(owner.token).get('/api/categories');
    const categoryId = (await cats.json()).categories[0].id;
    const res = await authed(owner.token).post('/api/topics', {
      title: `E2E AI grants ${Date.now()}`,
      description: 'AI grant tests',
      visibility: 'public',
      categoryId,
    });
    expect(res.status).toBe(201);
    topicId = (await res.json()).topic.id;

    const join = await authed(member.token).post(`/api/topics/${topicId}/join`);
    expect([200, 201]).toContain(join.status);
  });

  const grantsPath = () => `/api/topics/${topicId}/ai/grants`;

  describe('authz', () => {
    it('guest → 401 on POST/GET', async () => {
      expect((await fetch(`${BASE}${grantsPath()}`)).status).toBe(401);
      const post = await fetch(`${BASE}${grantsPath()}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ aiUserId: AI_ID, cmd: ['/ai/summarize'], historyGrant: 'none' }),
      });
      expect(post.status).toBe(401);
    });

    it('non-member → 403 on POST and GET', async () => {
      const o = authed(outsider.token);
      expect((await o.post(grantsPath(), { aiUserId: AI_ID, cmd: ['/ai/summarize'], historyGrant: 'none' })).status).toBe(403);
      expect((await o.get(grantsPath())).status).toBe(403);
    });

    it('non-owner member cannot grant → 403 (hostile)', async () => {
      const res = await authed(member.token).post(grantsPath(), { aiUserId: AI_ID, cmd: ['/ai/summarize'], historyGrant: 'none' });
      expect(res.status).toBe(403);
    });

    it('member can list grants → 200', async () => {
      const res = await authed(member.token).get(grantsPath());
      expect(res.status).toBe(200);
      expect(Array.isArray((await res.json()).grants)).toBe(true);
    });
  });

  describe('owner create + contract', () => {
    it('owner grants an AI → 201, echoes cmd/scope (metadata only, SI-1)', async () => {
      const res = await authed(owner.token).post(grantsPath(), {
        aiUserId: AI_ID,
        cmd: ['/openstoa/chat/send', '/openstoa/post/read'],
        historyGrant: '7d',
        dpopJkt: 'jkt-abc',
        consentAnchor: '0xeas_uid',
      });
      expect(res.status).toBe(201);
      const { grant } = await res.json();
      expect(grant.aiUserId).toBe(AI_ID);
      expect(grant.cmd).toEqual(['/openstoa/chat/send', '/openstoa/post/read']);
      expect(grant.historyGrant).toBe('7d');
      expect(grant.depth).toBe(1);
      // No key/plaintext material on the wire (SI-1).
      const blob = JSON.stringify(grant).toLowerCase();
      expect(blob).not.toContain('"key"');
      expect(blob).not.toContain('privatekey');
    });

    it('a member now sees the active grant in the list', async () => {
      const res = await authed(member.token).get(grantsPath());
      const { grants } = await res.json();
      expect(grants.some((g: { aiUserId: string }) => g.aiUserId === AI_ID)).toBe(true);
    });
  });

  describe('boundary — depth + historyGrant', () => {
    it('depth 0/1/3 accepted (0 = no sub-delegation)', async () => {
      for (const depth of [0, 1, 3]) {
        const res = await authed(owner.token).post(grantsPath(), { aiUserId: `${AI_ID}${depth}`, cmd: ['/ai/summarize'], historyGrant: 'none', depth });
        expect(res.status).toBe(201);
      }
    });
    it('depth 4 → 400', async () => {
      const res = await authed(owner.token).post(grantsPath(), { aiUserId: AI_ID, cmd: ['/ai/summarize'], historyGrant: 'none', depth: 4 });
      expect(res.status).toBe(400);
    });
    it('historyGrant none/full/since_epoch:N/Nd accepted', async () => {
      for (const historyGrant of ['none', 'full', 'since_epoch:5', '30d']) {
        const res = await authed(owner.token).post(grantsPath(), { aiUserId: `${AI_ID}h`, cmd: ['/ai/summarize'], historyGrant });
        expect(res.status).toBe(201);
      }
    });
    it('garbage historyGrant → 400', async () => {
      for (const historyGrant of ['everything', 'since_epoch:', 'drop table', '']) {
        const res = await authed(owner.token).post(grantsPath(), { aiUserId: AI_ID, cmd: ['/ai/summarize'], historyGrant });
        expect(res.status).toBe(400);
      }
    });
  });

  describe('empty + hostile input → 400', () => {
    it('missing aiUserId → 400', async () => {
      const res = await authed(owner.token).post(grantsPath(), { cmd: ['/ai/summarize'], historyGrant: 'none' });
      expect(res.status).toBe(400);
    });
    it('empty cmd array → 400', async () => {
      const res = await authed(owner.token).post(grantsPath(), { aiUserId: AI_ID, cmd: [], historyGrant: 'none' });
      expect(res.status).toBe(400);
    });
    it('unknown cmd → 400', async () => {
      const res = await authed(owner.token).post(grantsPath(), { aiUserId: AI_ID, cmd: ['/root/delete'], historyGrant: 'none' });
      expect(res.status).toBe(400);
    });
  });

  describe('revoke — authz + race', () => {
    async function createGrant(aiUserId: string): Promise<string> {
      const res = await authed(owner.token).post(grantsPath(), { aiUserId, cmd: ['/ai/summarize'], historyGrant: 'none' });
      expect(res.status).toBe(201);
      return (await res.json()).grant.id;
    }

    it('400 on invalid grantId, 404 on unknown grantId', async () => {
      expect((await authed(owner.token).del(`${grantsPath()}/not-a-uuid`)).status).toBe(400);
      expect((await authed(owner.token).del(`${grantsPath()}/00000000-0000-0000-0000-0000000000ff`)).status).toBe(404);
    });

    it('non-owner member cannot revoke → 403', async () => {
      const id = await createGrant(`${AI_ID}rev1`);
      const res = await authed(member.token).del(`${grantsPath()}/${id}`);
      expect(res.status).toBe(403);
    });

    it('owner revokes → 200, and it disappears from the active list immediately', async () => {
      const aiId = `${AI_ID}rev2`;
      const id = await createGrant(aiId);
      const res = await authed(owner.token).del(`${grantsPath()}/${id}`);
      expect(res.status).toBe(200);
      expect((await res.json()).revoked).toBe(true);
      const { grants } = await (await authed(member.token).get(grantsPath())).json();
      expect(grants.some((g: { id: string }) => g.id === id)).toBe(false);
    });

    it('the bot itself can revoke its own grant → 200', async () => {
      // A dev-login user whose userId IS the grant's aiUserId models the bot.
      const bot = await devLogin('bot');
      const res0 = await authed(owner.token).post(grantsPath(), { aiUserId: bot.userId, cmd: ['/ai/summarize'], historyGrant: 'none' });
      expect(res0.status).toBe(201);
      const id = (await res0.json()).grant.id;
      const res = await authed(bot.token).del(`${grantsPath()}/${id}`);
      expect(res.status).toBe(200);
    });

    it('concurrent double-revoke is deterministic — exactly one 200, one 404 (race)', async () => {
      const id = await createGrant(`${AI_ID}race`);
      const [a, b] = await Promise.all([
        authed(owner.token).del(`${grantsPath()}/${id}`),
        authed(owner.token).del(`${grantsPath()}/${id}`),
      ]);
      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([200, 404]);
    });
  });

  describe('D9 — zero human key sharing (bot joins with its OWN KeyPackage)', () => {
    it('bot leaf/device differs from human, and its last-resort KeyPackage is reusable', async () => {
      // Owner (human) publishes a normal device KeyPackage.
      const HUMAN_DEV = `human-owner-${Date.now().toString(36)}`;
      const pubHuman = await authed(owner.token).post(`/api/topics/${topicId}/mls/key-packages`, {
        keyPackage: B64('human-owner-keypackage-bytes'),
        deviceId: HUMAN_DEV,
      });
      expect(pubHuman.status).toBe(201);

      // Bot user joins and publishes its OWN reusable (last-resort) KeyPackage.
      const bot = await devLogin('botkp');
      expect([200, 201]).toContain((await authed(bot.token).post(`/api/topics/${topicId}/join`)).status);
      const BOT_DEV = `bot-device-${Date.now().toString(36)}`;
      const pubBot = await authed(bot.token).post(`/api/topics/${topicId}/mls/key-packages`, {
        keyPackage: B64('bot-own-keypackage-bytes'),
        deviceId: BOT_DEV,
        isLastResort: true,
      });
      expect(pubBot.status).toBe(201);

      // Owner consumes each — proving the bot has its OWN distinct leaf/device
      // (no human key was reused for the AI).
      const humanKp = await (await authed(owner.token).get(`/api/topics/${topicId}/mls/key-packages?userId=${owner.userId}&deviceId=${HUMAN_DEV}`)).json();
      const botKp = await (await authed(owner.token).get(`/api/topics/${topicId}/mls/key-packages?userId=${bot.userId}&deviceId=${BOT_DEV}`)).json();
      expect(humanKp.deviceId).toBe(HUMAN_DEV);
      expect(botKp.deviceId).toBe(BOT_DEV);
      expect(botKp.deviceId).not.toBe(humanKp.deviceId);
      expect(botKp.keyPackage).not.toBe(humanKp.keyPackage);
      expect(botKp.isLastResort).toBe(true);

      // Last-resort reusability: consuming the bot package again still returns it.
      const botKp2 = await (await authed(owner.token).get(`/api/topics/${topicId}/mls/key-packages?userId=${bot.userId}&deviceId=${BOT_DEV}`)).json();
      expect(botKp2.id).toBe(botKp.id);
    });
  });
});
