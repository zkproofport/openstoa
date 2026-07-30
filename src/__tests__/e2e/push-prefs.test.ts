/**
 * P-M (global push toggle) + P-S (per-topic mute) end-to-end.
 *
 * Two layers, both real — no `vi.mock`, no `supertest`, no in-process app:
 *
 *   1. HTTP against the RUNNING CONTAINER (`E2E_BASE_URL`, default
 *      http://localhost:3200) for everything the preference API exposes:
 *      defaults, both toggles, idempotency, precedence, isolation, authz and
 *      input validation. Users, topics, memberships and push tokens are all
 *      provisioned over HTTP too, so the rows under test are the rows the
 *      product itself writes.
 *
 *   2. DISPATCH-SIDE verification against the SAME PostgreSQL the container
 *      writes to, driving the real `pushStore.getTopicMemberTokens` and the
 *      real `push.ts` dispatchers over those HTTP-created rows. This layer
 *      exists because suppression has no HTTP observable: the local container
 *      has no push provider configured, so "did this user get a notification?"
 *      cannot be asked over the wire. Nothing here is mocked — the only
 *      injected object is a recording provider at the outermost edge (which is
 *      the module's own injection point) and, for the fail-closed row, an
 *      executor that raises on the preference query.
 *
 * Edge-case matrix rows covered (E2E scope; the SQL-level rows live in the
 * unit suite `pushPrefs.test.ts`, the route-unit rows in `pushPrefs-routes.test.ts`):
 *
 *   default state   — no row for either table ⇒ enabled + un-muted, proven both
 *                     over HTTP and by asserting the tables are genuinely empty
 *   boundary        — 0 muted topics, 1 muted topic, every recipient excluded
 *   hostile input   — `%`, `_`, `\`, SQL-shape, `<script>`, control char, UTF-8
 *                     (Korean/emoji) and oversized topic ids in the path
 *   empty/whitespace— whitespace-only topic id kept distinct from a malformed one
 *   large           — 1 KB topic id rejected before it can reach the uuid column
 *   authz           — guest 401; authenticated NON-member 403; per-user isolation
 *   race/idempotency— double mute, double unmute, repeated global set converge
 *   ext-failure     — preference lookup error ⇒ fail CLOSED (zero recipients)
 *   contract        — removing the `filterPushRecipients` call in
 *                     `pushStore.getTopicMemberTokens` breaks a test here, and
 *                     so does bypassing `getTopicMemberTokens` in either
 *                     dispatcher
 *   integrity       — global-off beats topic-unmuted; a mute survives a global
 *                     off→on round trip instead of being reset
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq, sql } from 'drizzle-orm';
import * as schema from '@/lib/db/schema';
import { getTopicMemberTokens } from '@/lib/pushStore';
import { filterPushRecipients } from '@/lib/pushPrefs';
import {
  dispatchDummyForMessage,
  dispatchCiphertextForMessage,
  type PushProvider,
  type PushTarget,
  type DummyPushPayload,
  type CiphertextPushPayload,
} from '@/lib/push';

const BASE = process.env.E2E_BASE_URL || 'http://localhost:3200';

/** The only hosts for which the local default DB_URL below can possibly be right. */
function isLocalBase(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '::1';
  } catch {
    return false;
  }
}

// The container's own database. Same instance, same rows — this is how the
// dispatch layer observes what the HTTP layer just wrote. That invariant is
// ENFORCED in beforeAll (env guard + a live round-trip check), not assumed:
// pointing SQL at a different database than `BASE` makes every dispatch-layer
// assertion read an unrelated (usually empty) table.
const EXPLICIT_DB_URL = process.env.E2E_DB_URL ?? process.env.DATABASE_URL;
const DB_URL = EXPLICIT_DB_URL ?? 'postgresql://proofport:proofport@localhost:5432/openstoa';

const PREFS = '/api/push/preferences';
const topicPush = (id: string) => `/api/topics/${id}/push`;

// ── HTTP helpers ────────────────────────────────────────────────────────────

interface User {
  token: string;
  userId: string;
  nickname: string;
}

async function devLogin(tag: string): Promise<User> {
  const nickname = `e2e_pp_${tag}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const res = await fetch(`${BASE}/api/auth/dev-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nickname }),
  });
  if (!res.ok) throw new Error(`dev-login failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return { token: data.token, userId: data.userId, nickname: data.nickname };
}

function api(token: string) {
  const auth = { Authorization: `Bearer ${token}` };
  const json = { 'Content-Type': 'application/json', ...auth };
  return {
    get: (path: string) => fetch(`${BASE}${path}`, { headers: auth }),
    post: (path: string, body: unknown) =>
      fetch(`${BASE}${path}`, { method: 'POST', headers: json, body: JSON.stringify(body) }),
    patch: (path: string, body: unknown) =>
      fetch(`${BASE}${path}`, { method: 'PATCH', headers: json, body: JSON.stringify(body) }),
    patchRaw: (path: string, raw: string) =>
      fetch(`${BASE}${path}`, { method: 'PATCH', headers: json, body: raw }),
    del: (path: string) => fetch(`${BASE}${path}`, { method: 'DELETE', headers: auth }),
  };
}

/** dev-login + join every given topic + register one device push token. */
async function newMember(tag: string, topicIds: string[]): Promise<User> {
  const u = await devLogin(tag);
  const c = api(u.token);
  for (const t of topicIds) {
    const res = await c.post(`/api/topics/${t}/join`, {});
    expect([200, 201, 409]).toContain(res.status);
  }
  const reg = await c.post('/api/push/register', {
    routingHandle: `rh-${u.userId.slice(2, 12)}`,
    pushToken: `tok-${u.userId.slice(2, 12)}`,
    platform: 'ios',
  });
  expect(reg.status).toBe(201);
  return u;
}

async function createTopic(owner: User, title: string, categoryId: string): Promise<string> {
  const res = await api(owner.token).post('/api/topics', {
    title,
    description: 'push preference E2E',
    visibility: 'public',
    categoryId,
  });
  expect(res.status).toBe(201);
  return (await res.json()).topic.id;
}

// ── Dispatch-layer helpers (real DB, real modules) ──────────────────────────

/** Records every send instead of hitting Expo/APNs — the module's own edge. */
class CapturingProvider implements PushProvider {
  readonly sent: Array<{ target: PushTarget; payload: DummyPushPayload }> = [];
  readonly sentCt: Array<{ target: PushTarget; payload: CiphertextPushPayload }> = [];
  async send(target: PushTarget, payload: DummyPushPayload): Promise<void> {
    this.sent.push({ target, payload });
  }
  async sendCiphertext(target: PushTarget, payload: CiphertextPushPayload): Promise<void> {
    this.sentCt.push({ target, payload });
  }
}

let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;

/** userIds the real recipient resolver would notify for `topicId`. */
async function recipientIds(topicId: string, senderUserId: string): Promise<string[]> {
  const targets = await getTopicMemberTokens(db, topicId, senderUserId);
  return targets.map((t) => t.userId).sort();
}

// ── Fixtures ────────────────────────────────────────────────────────────────

let owner: User;
let memberB: User;
let memberC: User;
let outsider: User;
let mainTopic: string;
let otherTopic: string;

const UNKNOWN_TOPIC = '00000000-0000-4000-8000-00000000dead';

beforeAll(async () => {
  const health = await fetch(`${BASE}/api/health`).catch(() => null);
  if (!health || !health.ok) throw new Error(`container not reachable at ${BASE} — start it first`);

  // Guard 1 (static): a non-local BASE with no explicit DB URL would fall back
  // to the local default and quietly test two different databases.
  if (!isLocalBase(BASE) && !EXPLICIT_DB_URL) {
    throw new Error(
      `push-prefs E2E cannot run against ${BASE}: this file provisions fixtures over HTTP and then ` +
        `verifies push dispatch with SQL, so both halves must address the SAME database, and no ` +
        `E2E_DB_URL / DATABASE_URL was provided — the local default ${DB_URL} would be used and every ` +
        `dispatch assertion would read an unrelated database.\n` +
        `Fix: open a proxy to the target database (./scripts/db-proxy.sh <env> proxy) and set ` +
        `E2E_DB_URL=postgresql://USER:PASS@localhost:15432/openstoa, or run this file against a local ` +
        `container with \`npm run test:e2e:local\`.`,
    );
  }

  pool = new Pool({ connectionString: DB_URL, max: 6 });
  db = drizzle(pool, { schema });
  // Fail loudly rather than silently skipping the dispatch layer.
  await db.execute(sql`SELECT 1`);

  owner = await devLogin('owner');

  // Guard 2 (dynamic): prove the two halves really are the same database. An
  // explicitly-set-but-wrong E2E_DB_URL / DATABASE_URL passes guard 1; only a
  // live round trip — row created over HTTP, read back over SQL — catches it.
  const seen = await db.query.users.findFirst({
    where: eq(schema.users.id, owner.userId),
    columns: { id: true },
  });
  if (!seen) {
    throw new Error(
      `DB/HTTP mismatch: user ${owner.userId} was just created over HTTP at ${BASE}, but it is not ` +
        `visible through DB_URL=${DB_URL}. These point at different databases, so the dispatch-layer ` +
        `assertions below would read empty tables and pass vacuously. Point E2E_DB_URL at the database ` +
        `${BASE} actually writes to.`,
    );
  }
  const cats = await (await fetch(`${BASE}/api/categories`)).json();
  const categoryId = cats.categories[0].id;

  mainTopic = await createTopic(owner, `Push prefs main ${Date.now()}`, categoryId);
  otherTopic = await createTopic(owner, `Push prefs other ${Date.now()}`, categoryId);

  memberB = await newMember('b', [mainTopic, otherTopic]);
  memberC = await newMember('c', [mainTopic, otherTopic]);
  outsider = await devLogin('outsider'); // authenticated, joins nothing
}, 120_000);

afterAll(async () => {
  // beforeAll can bail before the pool exists (env guard); cleaning up nothing
  // must not add a second, unrelated failure on top of that one.
  if (!pool) return;

  // Best-effort: drop the preference rows this file created, then the topics.
  for (const u of [owner, memberB, memberC, outsider].filter(Boolean)) {
    await db.delete(schema.pushTopicMutes).where(eq(schema.pushTopicMutes.userId, u.userId));
    await db.delete(schema.pushPrefs).where(eq(schema.pushPrefs.userId, u.userId));
    await db.delete(schema.pushTokens).where(eq(schema.pushTokens.userId, u.userId));
  }
  if (owner) {
    for (const t of [mainTopic, otherTopic].filter(Boolean)) {
      await api(owner.token).del(`/api/topics/${t}`);
    }
  }
  await pool.end();
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. Default state — absence of a row IS the permissive default
// ═══════════════════════════════════════════════════════════════════════════

describe.sequential('P-M/P-S defaults (no rows written)', () => {
  it('a brand-new account reads enabled=true with no muted topics', async () => {
    const fresh = await devLogin('fresh');
    const res = await api(fresh.token).get(PREFS);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: true, mutedTopicIds: [] });

    // The default is the ABSENCE of a row, not a row that happens to say true —
    // that is what makes the feature safe to deploy without a backfill.
    const prefRows = await db.execute(
      sql`SELECT 1 FROM push_prefs WHERE user_id = ${fresh.userId}`,
    );
    const muteRows = await db.execute(
      sql`SELECT 1 FROM push_topic_mutes WHERE user_id = ${fresh.userId}`,
    );
    expect(prefRows.rows.length).toBe(0);
    expect(muteRows.rows.length).toBe(0);
  });

  it('a freshly joined topic reads muted=false, globalEnabled=true, willNotify=true', async () => {
    const res = await api(memberB.token).get(topicPush(mainTopic));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      topicId: mainTopic,
      muted: false,
      globalEnabled: true,
      willNotify: true,
    });
  });

  it('the dispatcher notifies every member by default (baseline for suppression)', async () => {
    const ids = await recipientIds(mainTopic, owner.userId);
    expect(ids).toContain(memberB.userId);
    expect(ids).toContain(memberC.userId);
    expect(ids).not.toContain(owner.userId); // the sender never notifies itself
    expect(ids).not.toContain(outsider.userId); // non-members contribute no token
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Authorization
// ═══════════════════════════════════════════════════════════════════════════

describe.sequential('authorization', () => {
  it('rejects unauthenticated callers with 401 on all four endpoints', async () => {
    const g1 = await fetch(`${BASE}${PREFS}`);
    expect(g1.status).toBe(401);
    const p1 = await fetch(`${BASE}${PREFS}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    expect(p1.status).toBe(401);

    const g2 = await fetch(`${BASE}${topicPush(mainTopic)}`);
    expect(g2.status).toBe(401);
    const p2 = await fetch(`${BASE}${topicPush(mainTopic)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ muted: true }),
    });
    expect(p2.status).toBe(401);
  });

  it('rejects an authenticated NON-member with 403 on GET and PATCH', async () => {
    const c = api(outsider.token);
    expect((await c.get(topicPush(mainTopic))).status).toBe(403);

    const patch = await c.patch(topicPush(mainTopic), { muted: true });
    expect(patch.status).toBe(403);

    // …and the rejected call wrote nothing.
    const rows = await db.execute(
      sql`SELECT 1 FROM push_topic_mutes WHERE user_id = ${outsider.userId}`,
    );
    expect(rows.rows.length).toBe(0);
  });

  it('404s a well-formed but non-existent topic id', async () => {
    const c = api(memberB.token);
    expect((await c.get(topicPush(UNKNOWN_TOPIC))).status).toBe(404);
    expect((await c.patch(topicPush(UNKNOWN_TOPIC), { muted: true })).status).toBe(404);
  });

  it('is per-user scoped: one user\'s settings never move another\'s', async () => {
    expect((await api(memberB.token).patch(PREFS, { enabled: false })).status).toBe(200);
    const cView = await api(memberC.token).get(PREFS);
    expect((await cView.json()).enabled).toBe(true);
    // restore
    expect((await api(memberB.token).patch(PREFS, { enabled: true })).status).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Malformed / hostile topic ids
// ═══════════════════════════════════════════════════════════════════════════

describe.sequential('malformed and hostile topic ids', () => {
  const HOSTILE = [
    ['plain garbage', 'not-a-uuid'],
    ['whitespace only', '%20%20%20'],
    ['ilike wildcard', '%25'],
    ['underscore wildcard', '_'],
    ['backslash escape', '%5C'],
    ['SQL shape', encodeURIComponent(`' OR '1'='1`)],
    ['script tag', encodeURIComponent('<script>alert(1)</script>')],
    ['uuid with a trailing quote', encodeURIComponent(`${UNKNOWN_TOPIC}'`)],
    ['korean', encodeURIComponent('토픽아이디')],
    ['emoji', encodeURIComponent('🌟🌟🌟')],
    ['control char', encodeURIComponent('abc\u0001def')],
  ] as const;

  for (const [label, raw] of HOSTILE) {
    it(`400s GET and PATCH for a ${label} topic id`, async () => {
      const c = api(memberB.token);
      expect((await c.get(topicPush(raw))).status).toBe(400);
      expect((await c.patch(topicPush(raw), { muted: true })).status).toBe(400);
    });
  }

  it('400s a 1 KB topic id without letting it reach the uuid column', async () => {
    const huge = 'a'.repeat(1024);
    const c = api(memberB.token);
    expect((await c.get(topicPush(huge))).status).toBe(400);
    expect((await c.patch(topicPush(huge), { muted: true })).status).toBe(400);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Body validation — a mis-typed value must never be read as "off"
// ═══════════════════════════════════════════════════════════════════════════

describe.sequential('request body validation', () => {
  it('400s a non-boolean `enabled` on the global switch and leaves it on', async () => {
    const u = await devLogin('vg');
    const c = api(u.token);
    for (const body of [{}, { enabled: 'false' }, { enabled: 'true' }, { enabled: 0 }, { enabled: 1 }, { enabled: null }]) {
      expect((await c.patch(PREFS, body)).status).toBe(400);
    }
    expect((await c.patchRaw(PREFS, 'not json')).status).toBe(400);

    // Still the default — no rejected call leaked through as an opt-out.
    expect((await (await c.get(PREFS)).json()).enabled).toBe(true);
    const rows = await db.execute(sql`SELECT 1 FROM push_prefs WHERE user_id = ${u.userId}`);
    expect(rows.rows.length).toBe(0);
  });

  it('400s a non-boolean `muted` on the per-topic switch and writes nothing', async () => {
    const u = await newMember('vt', [mainTopic]);
    const c = api(u.token);
    for (const body of [{}, { muted: 'true' }, { muted: 'false' }, { muted: 1 }, { muted: 0 }, { muted: null }]) {
      expect((await c.patch(topicPush(mainTopic), body)).status).toBe(400);
    }
    expect((await c.patchRaw(topicPush(mainTopic), '{')).status).toBe(400);

    const rows = await db.execute(
      sql`SELECT 1 FROM push_topic_mutes WHERE user_id = ${u.userId}`,
    );
    expect(rows.rows.length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Global switch — round trip, idempotency, dispatch effect
// ═══════════════════════════════════════════════════════════════════════════

describe.sequential('P-M global switch', () => {
  it('turning it off suppresses that user only, leaving other members alone', async () => {
    // Compare the recipient set BEFORE and AFTER so the assertion stays exact
    // ("B and nobody else was dropped") without depending on how many other
    // members earlier tests happen to have added to the topic.
    const beforeMain = await recipientIds(mainTopic, owner.userId);
    const beforeOther = await recipientIds(otherTopic, owner.userId);
    expect(beforeMain).toContain(memberB.userId);
    expect(beforeOther).toContain(memberB.userId);

    const res = await api(memberB.token).patch(PREFS, { enabled: false });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: false, mutedTopicIds: [] });

    // Contract: the real resolver both dispatchers use now drops B and only B.
    expect(await recipientIds(mainTopic, owner.userId)).toEqual(
      beforeMain.filter((id) => id !== memberB.userId),
    );
    expect(await recipientIds(mainTopic, owner.userId)).toContain(memberC.userId);
    // …and B is gone from EVERY topic, not just this one.
    expect(await recipientIds(otherTopic, owner.userId)).toEqual(
      beforeOther.filter((id) => id !== memberB.userId),
    );
  });

  it('is idempotent — setting false twice returns the same body and one row', async () => {
    const again = await api(memberB.token).patch(PREFS, { enabled: false });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ enabled: false, mutedTopicIds: [] });

    const rows = await db.execute(
      sql`SELECT enabled FROM push_prefs WHERE user_id = ${memberB.userId}`,
    );
    expect(rows.rows.length).toBe(1);
    expect((rows.rows[0] as { enabled: boolean }).enabled).toBe(false);
  });

  it('reports willNotify=false for a topic that was never muted (global wins)', async () => {
    const res = await api(memberB.token).get(topicPush(mainTopic));
    const body = await res.json();
    expect(body).toEqual({
      topicId: mainTopic,
      muted: false,
      globalEnabled: false,
      willNotify: false,
    });
  });

  it('turning it back on restores delivery', async () => {
    const before = await recipientIds(mainTopic, owner.userId);
    expect(before).not.toContain(memberB.userId);

    const res = await api(memberB.token).patch(PREFS, { enabled: true });
    expect(res.status).toBe(200);
    expect((await res.json()).enabled).toBe(true);
    expect(await recipientIds(mainTopic, owner.userId)).toEqual([...before, memberB.userId].sort());
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. Per-topic mute — round trip, scoping, idempotency, dispatch effect
// ═══════════════════════════════════════════════════════════════════════════

describe.sequential('P-S per-topic mute', () => {
  it('muting one topic silences ONLY that topic', async () => {
    const beforeMain = await recipientIds(mainTopic, owner.userId);
    const beforeOther = await recipientIds(otherTopic, owner.userId);
    expect(beforeMain).toContain(memberB.userId);

    const res = await api(memberB.token).patch(topicPush(mainTopic), { muted: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      topicId: mainTopic,
      muted: true,
      changed: true,
      globalEnabled: true,
      willNotify: false,
    });

    expect(await recipientIds(mainTopic, owner.userId)).toEqual(
      beforeMain.filter((id) => id !== memberB.userId),
    );
    // The other topic B is a member of is untouched — same set as before.
    expect(await recipientIds(otherTopic, owner.userId)).toEqual(beforeOther);
    expect(beforeOther).toContain(memberB.userId);
  });

  it('surfaces the mute in the global preference read', async () => {
    const body = await (await api(memberB.token).get(PREFS)).json();
    expect(body.enabled).toBe(true);
    expect(body.mutedTopicIds).toEqual([mainTopic]);
  });

  it('is idempotent — a second mute reports changed=false and leaves one row', async () => {
    const res = await api(memberB.token).patch(topicPush(mainTopic), { muted: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      topicId: mainTopic,
      muted: true,
      changed: false,
      globalEnabled: true,
      willNotify: false,
    });

    const rows = await db.execute(
      sql`SELECT 1 FROM push_topic_mutes WHERE user_id = ${memberB.userId} AND topic_id = ${mainTopic}::uuid`,
    );
    expect(rows.rows.length).toBe(1);
  });

  it('two concurrent mutes converge on a single row (race)', async () => {
    const u = await newMember('race', [mainTopic]);
    const c = api(u.token);
    const [r1, r2] = await Promise.all([
      c.patch(topicPush(mainTopic), { muted: true }),
      c.patch(topicPush(mainTopic), { muted: true }),
    ]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const b1 = await r1.json();
    const b2 = await r2.json();
    expect(b1.muted).toBe(true);
    expect(b2.muted).toBe(true);
    // Exactly one of the two actually wrote; both agree on the final state.
    expect([b1.changed, b2.changed].filter(Boolean).length).toBe(1);

    const rows = await db.execute(
      sql`SELECT 1 FROM push_topic_mutes WHERE user_id = ${u.userId} AND topic_id = ${mainTopic}::uuid`,
    );
    expect(rows.rows.length).toBe(1);
  });

  it('unmuting restores delivery and reports changed=true', async () => {
    const before = await recipientIds(mainTopic, owner.userId);
    expect(before).not.toContain(memberB.userId);

    const res = await api(memberB.token).patch(topicPush(mainTopic), { muted: false });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      topicId: mainTopic,
      muted: false,
      changed: true,
      globalEnabled: true,
      willNotify: true,
    });
    expect(await recipientIds(mainTopic, owner.userId)).toEqual([...before, memberB.userId].sort());
  });

  it('is idempotent in the other direction too — a second unmute is changed=false', async () => {
    const res = await api(memberB.token).patch(topicPush(mainTopic), { muted: false });
    expect(res.status).toBe(200);
    expect((await res.json()).changed).toBe(false);

    const body = await (await api(memberB.token).get(PREFS)).json();
    expect(body.mutedTopicIds).toEqual([]);
    const rows = await db.execute(
      sql`SELECT 1 FROM push_topic_mutes WHERE user_id = ${memberB.userId}`,
    );
    expect(rows.rows.length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. Precedence — the global switch wins, and mutes survive it
// ═══════════════════════════════════════════════════════════════════════════

describe.sequential('precedence: global off beats topic un-muted', () => {
  it('an un-muted topic still does not notify while the global switch is off', async () => {
    const u = await newMember('prec', [mainTopic]);
    const c = api(u.token);

    // Explicitly un-muted (a real row deletion, not just "never muted").
    expect((await c.patch(topicPush(mainTopic), { muted: true })).status).toBe(200);
    expect((await c.patch(topicPush(mainTopic), { muted: false })).status).toBe(200);
    expect((await c.patch(PREFS, { enabled: false })).status).toBe(200);

    const view = await (await c.get(topicPush(mainTopic))).json();
    expect(view).toEqual({
      topicId: mainTopic,
      muted: false,
      globalEnabled: false,
      willNotify: false,
    });
    expect(await recipientIds(mainTopic, owner.userId)).not.toContain(u.userId);
  });

  it('per-topic mutes are preserved across a global off → on round trip', async () => {
    const u = await newMember('preserve', [mainTopic, otherTopic]);
    const c = api(u.token);
    expect((await c.patch(topicPush(mainTopic), { muted: true })).status).toBe(200);

    const off = await (await c.patch(PREFS, { enabled: false })).json();
    expect(off).toEqual({ enabled: false, mutedTopicIds: [mainTopic] });

    const on = await (await c.patch(PREFS, { enabled: true })).json();
    expect(on).toEqual({ enabled: true, mutedTopicIds: [mainTopic] });

    // Back on globally, still muted here, still audible there.
    expect(await recipientIds(mainTopic, owner.userId)).not.toContain(u.userId);
    expect(await recipientIds(otherTopic, owner.userId)).toContain(u.userId);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. Dispatch contract — the filter cannot be removed silently
// ═══════════════════════════════════════════════════════════════════════════

describe.sequential('dispatch contract', () => {
  it('BOTH dispatchers skip a muted member and still reach the others', async () => {
    const muted = await newMember('dm', [mainTopic]);
    const heard = await newMember('dh', [mainTopic]);
    expect((await api(muted.token).patch(topicPush(mainTopic), { muted: true })).status).toBe(200);

    const dummy = new CapturingProvider();
    await dispatchDummyForMessage(db, mainTopic, owner.userId, dummy);
    const dummyTokens = dummy.sent.map((s) => s.target.pushToken);
    expect(dummyTokens).toContain(`tok-${heard.userId.slice(2, 12)}`);
    expect(dummyTokens).not.toContain(`tok-${muted.userId.slice(2, 12)}`);

    const ct = new CapturingProvider();
    await dispatchCiphertextForMessage(
      db,
      {
        topicId: mainTopic,
        senderUserId: owner.userId,
        messageId: 'e2e-msg-1',
        sealedCiphertextB64: 'AAECAwQ=',
        epoch: 1,
      },
      ct,
    );
    const ctTokens = ct.sentCt.map((s) => s.target.pushToken);
    expect(ctTokens).toContain(`tok-${heard.userId.slice(2, 12)}`);
    expect(ctTokens).not.toContain(`tok-${muted.userId.slice(2, 12)}`);

    // The muted user is a real, current, token-holding member — the exclusion
    // is the preference filter, not an accident of membership or registration.
    const member = await db.execute(
      sql`SELECT 1 FROM topic_members WHERE topic_id = ${mainTopic}::uuid AND user_id = ${muted.userId}`,
    );
    expect(member.rows.length).toBe(1);
    const tok = await db.execute(
      sql`SELECT 1 FROM push_tokens WHERE user_id = ${muted.userId}`,
    );
    expect(tok.rows.length).toBe(1);
  });

  it('fails CLOSED: a preference lookup error drops every recipient', async () => {
    const survivors = await filterPushRecipients(
      { execute: async () => { throw new Error('simulated preference lookup failure'); } },
      mainTopic,
      [{ userId: memberB.userId }, { userId: memberC.userId }],
    );
    expect(survivors).toEqual([]);
  });

  it('fails CLOSED through getTopicMemberTokens, proving the filter is invoked', async () => {
    // First execute() is the member-token join (passed through to the real DB);
    // the SECOND is the preference lookup, which raises. If the
    // `filterPushRecipients` call in pushStore.getTopicMemberTokens were
    // removed, there would BE no second call and this would return recipients.
    let calls = 0;
    const flaky = {
      execute: async (q: Parameters<typeof db.execute>[0]) => {
        calls += 1;
        if (calls === 1) return db.execute(q);
        throw new Error('simulated preference lookup failure');
      },
    };
    const targets = await getTopicMemberTokens(
      flaky as unknown as Parameters<typeof getTopicMemberTokens>[0],
      mainTopic,
      owner.userId,
    );
    expect(calls).toBe(2);
    expect(targets).toEqual([]);
  });
});
