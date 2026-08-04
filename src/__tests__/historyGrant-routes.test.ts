/**
 * `history_grant` ENFORCEMENT at the ROUTE layer — real local Postgres.
 *
 * The three history surfaces are called as real handlers against real rows;
 * only the session (the credential under test) and the side-effect modules
 * (redis / push / logger) are mocked. Mocking the db here would prove only that
 * some code ran — the claim being tested is that an out-of-scope row never
 * comes back, which is a property of the SQL the route builds.
 *
 * Surfaces: GET /api/topics/{id}/chat, /archive, /tak/bundles.
 * Requires the local dev DB (DATABASE_URL or default).
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage in this file
 *   authorization       → 'a HUMAN session is completely unaffected' (all three),
 *                         'grant none → 403' (all three),
 *                         'membership is checked BEFORE the grant',
 *                         'cmd is checked BEFORE the grant'
 *   boundary            → 'a message exactly N days old is returned',
 *                         'the newest-N grant returns exactly N'
 *   empty               → 'an empty topic returns 200 with no rows, not 500'
 *   malformed / absent  → 'an isAI session with a garbage or missing grant is denied'
 *   contract invocation → 'every history surface refuses a none grant' (one table,
 *                         so a new surface added without the gate stands out) and
 *                         'the 403 body names historyGrant'
 *   result integrity    → 'total is windowed too', 'paging cannot escape the window',
 *                         'bundles outside the grant are withheld and stay unacked'
 *   race / fire-and-forget → N/A: the gate adds no async side effects.
 *   UTF-8 / hostile input  → N/A at this layer: the grant is never user text on the
 *                         request, it is a stored, pre-validated field (hostile
 *                         strings are covered in historyGrant.test.ts).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import * as schema from '@/lib/db/schema';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://proofport:proofport@localhost:5432/openstoa';

// The route's own `@/lib/db` proxy resolves DATABASE_URL lazily on first use,
// so setting it before the handlers run is enough to point them at this DB.
vi.hoisted(() => {
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? 'postgresql://proofport:proofport@localhost:5432/openstoa';
});

const mocks = vi.hoisted(() => ({ getSession: vi.fn() }));

vi.mock('@/lib/session', () => ({ getSession: mocks.getSession }));
vi.mock('@/lib/redis', () => ({
  getRedis: () => ({ incr: vi.fn().mockResolvedValue(1), expire: vi.fn(), publish: vi.fn() }),
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/push', () => ({
  dispatchDummyForMessage: vi.fn().mockResolvedValue(undefined),
  dispatchCiphertextForMessage: vi.fn().mockResolvedValue(undefined),
  getPushProvider: () => null,
  getPushMode: () => 'content-free',
}));

import { GET as chatGET } from '@/app/api/topics/[topicId]/chat/route';
import { GET as archiveGET } from '@/app/api/topics/[topicId]/archive/route';
import { GET as takGET } from '@/app/api/topics/[topicId]/tak/bundles/route';
import { storeArchiveRow, storeTakBundle } from '@/lib/mls/archive';

const USER = 'hg-route-user';
const OUTSIDER = 'hg-route-outsider';
const TOPIC = '00000000-0000-4000-8000-0000000079b2';
const DEVICE = 'hg-device-1';

let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;

const DAY = 24 * 60 * 60 * 1000;
const ago = (d: number) => new Date(Date.now() - d * DAY);

const tParams = () => Promise.resolve({ topicId: TOPIC });
const req = (query = '') =>
  ({ url: `http://x/api/topics/${TOPIC}/x${query}`, json: async () => null }) as never;

/** A session shape mirroring what `getApiKeySession` puts on the wire. */
const keySession = (cmd: string[], historyGrant?: string) => ({
  userId: USER,
  nickname: 'hg_route_user',
  isAI: true,
  apiKeyId: 'key-1',
  apiKeyCmd: cmd,
  ...(historyGrant !== undefined && { apiKeyHistoryGrant: historyGrant }),
});
const humanSession = { userId: USER, nickname: 'hg_route_user', isAI: false };

const READ = ['/openstoa/chat/read'];

async function seedMessage(createdAt: Date, epoch: number): Promise<string> {
  const [row] = await db
    .insert(schema.chatMessages)
    .values({
      topicId: TOPIC,
      userId: USER,
      ciphertext: Buffer.from(`sealed-${createdAt.toISOString()}-${epoch}`),
      epoch,
      type: 'message',
      createdAt,
    })
    .returning();
  return row.id;
}

async function seedArchived(createdAt: Date, epoch: number): Promise<string> {
  const id = await seedMessage(createdAt, epoch);
  await storeArchiveRow(db as never, TOPIC, id, epoch, Buffer.from(`arch-${id}`));
  return id;
}

async function clean() {
  await db.delete(schema.takBundles).where(eq(schema.takBundles.topicId, TOPIC));
  await db.delete(schema.chatArchive).where(eq(schema.chatArchive.topicId, TOPIC));
  await db.delete(schema.chatMessages).where(eq(schema.chatMessages.topicId, TOPIC));
}

beforeAll(async () => {
  pool = new Pool({ connectionString: DATABASE_URL, max: 8 });
  db = drizzle(pool, { schema });
  await clean();
  await db.delete(schema.topicMembers).where(eq(schema.topicMembers.topicId, TOPIC));
  await db.delete(schema.topics).where(eq(schema.topics.id, TOPIC));
  for (const id of [USER, OUTSIDER]) await db.delete(schema.users).where(eq(schema.users.id, id));
  await db.insert(schema.users).values([
    { id: USER, nickname: 'hg_route_user' },
    { id: OUTSIDER, nickname: 'hg_route_outsider' },
  ]);
  await db.insert(schema.topics).values({
    id: TOPIC,
    title: 'history grant route topic',
    creatorId: USER,
    inviteCode: 'hg-route-invite',
    visibility: 'public',
  });
  await db.insert(schema.topicMembers).values({ topicId: TOPIC, userId: USER });
});

afterAll(async () => {
  await clean();
  await db.delete(schema.topicMembers).where(eq(schema.topicMembers.topicId, TOPIC));
  await db.delete(schema.topics).where(eq(schema.topics.id, TOPIC));
  for (const id of [USER, OUTSIDER]) await db.delete(schema.users).where(eq(schema.users.id, id));
  await pool.end();
});

beforeEach(async () => {
  vi.clearAllMocks();
  await clean();
});

const SURFACES: Array<[string, () => Promise<Response>]> = [
  ['chat', () => chatGET(req(), { params: tParams() }) as Promise<Response>],
  ['archive', () => archiveGET(req(), { params: tParams() })],
  ['tak/bundles', () => takGET(req(`?deviceId=${DEVICE}`), { params: tParams() })],
];

// ---------------------------------------------------------------------------
// The none grant — the gap this change closes
// ---------------------------------------------------------------------------

describe('grant `none`', () => {
  for (const [name, call] of SURFACES) {
    it(`${name}: a key WITH chat/read but grant none is refused — holding the capability is not enough`, async () => {
      mocks.getSession.mockResolvedValue(keySession(READ, 'none'));
      const res = await call();
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toContain('historyGrant');
    });
  }

  it('the refusal happens before any row is read — an out-of-scope key learns nothing', async () => {
    await seedArchived(ago(1), 0);
    mocks.getSession.mockResolvedValue(keySession(READ, 'none'));
    for (const [, call] of SURFACES) {
      const res = await call();
      expect(res.status).toBe(403);
      expect(JSON.stringify(await res.json())).not.toContain('ciphertext');
    }
  });

  it('FAIL-CLOSED: an isAI session with a missing or garbage grant is refused too', async () => {
    for (const grant of [undefined, '', 'whenever', 'FULL']) {
      mocks.getSession.mockResolvedValue(keySession(READ, grant));
      for (const [name, call] of SURFACES) {
        const res = await call();
        expect(res.status, `${name} with grant ${JSON.stringify(grant)}`).toBe(403);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Humans and `full` are untouched
// ---------------------------------------------------------------------------

describe('unbounded callers', () => {
  it('a HUMAN session is completely unaffected — full history on every surface', async () => {
    await seedArchived(ago(400), 0);
    await seedArchived(ago(1), 0);
    await storeTakBundle(db as never, TOPIC, USER, DEVICE, Buffer.from('b'), 'full');
    mocks.getSession.mockResolvedValue(humanSession);

    const chat = await (await chatGET(req(), { params: tParams() }) as Response).json();
    expect(chat.messages.length).toBe(2);
    expect(chat.total).toBe(2);

    const arch = await (await archiveGET(req(), { params: tParams() })).json();
    expect(arch.archive.length).toBe(2);

    const tak = await (await takGET(req(`?deviceId=${DEVICE}`), { params: tParams() })).json();
    expect(tak.bundles.length).toBe(1);
  });

  it('a key with grant `full` sees exactly what the human sees', async () => {
    await seedArchived(ago(400), 0);
    await seedArchived(ago(1), 0);
    await storeTakBundle(db as never, TOPIC, USER, DEVICE, Buffer.from('b'), 'full');
    mocks.getSession.mockResolvedValue(keySession(READ, 'full'));

    expect((await (await chatGET(req(), { params: tParams() }) as Response).json()).messages.length).toBe(2);
    expect((await (await archiveGET(req(), { params: tParams() })).json()).archive.length).toBe(2);
    expect((await (await takGET(req(`?deviceId=${DEVICE}`), { params: tParams() })).json()).bundles.length).toBe(1);
  });

  it('an empty topic answers 200 with no rows under a bounded grant, not 500', async () => {
    mocks.getSession.mockResolvedValue(keySession(READ, '7d'));
    const chat = await chatGET(req(), { params: tParams() }) as Response;
    expect(chat.status).toBe(200);
    expect((await chat.json()).messages).toEqual([]);

    const arch = await archiveGET(req(), { params: tParams() });
    expect(arch.status).toBe(200);
    expect((await arch.json()).archive).toEqual([]);

    const tak = await takGET(req(`?deviceId=${DEVICE}`), { params: tParams() });
    expect(tak.status).toBe(200);
    expect((await tak.json()).bundles).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Gate ORDER — the grant must not mask an earlier, stricter denial
// ---------------------------------------------------------------------------

describe('gate order', () => {
  it('membership is checked BEFORE the grant — a non-member with `full` still gets the membership 403', async () => {
    mocks.getSession.mockResolvedValue({ ...keySession(READ, 'full'), userId: OUTSIDER });
    for (const [name, call] of SURFACES) {
      const res = await call();
      expect(res.status, name).toBe(403);
      expect((await res.json()).error, name).toContain('member');
    }
  });

  it('the cmd is checked BEFORE the grant — a key without chat/read is refused for the CAPABILITY, whatever its grant', async () => {
    mocks.getSession.mockResolvedValue(keySession([], 'full'));
    for (const [name, call] of SURFACES) {
      const res = await call();
      expect(res.status, name).toBe(403);
      expect((await res.json()).error, name).toContain('/openstoa/chat/read');
    }
  });

  it('unauthenticated is still 401, never a grant 403', async () => {
    mocks.getSession.mockResolvedValue(null);
    for (const [name, call] of SURFACES) {
      expect((await call()).status, name).toBe(401);
    }
  });
});

// ---------------------------------------------------------------------------
// Bounded grants — chat history
// ---------------------------------------------------------------------------

describe('chat history under a bounded grant', () => {
  it('Nd returns only messages inside the window, and a message exactly N days old IS returned', async () => {
    const recent = await seedMessage(ago(1), 0);
    const exact = await seedMessage(new Date(Date.now() - 7 * DAY + 2000), 0); // just inside 7d
    await seedMessage(ago(30), 0);
    await seedMessage(ago(400), 0);

    mocks.getSession.mockResolvedValue(keySession(READ, '7d'));
    const body = await (await chatGET(req(), { params: tParams() }) as Response).json();
    expect(new Set(body.messages.map((m: { id: string }) => m.id))).toEqual(new Set([recent, exact]));
  });

  it('`total` is windowed too — the count does not leak how much history exists beyond the grant', async () => {
    await seedMessage(ago(1), 0);
    for (const d of [30, 60, 90, 400]) await seedMessage(ago(d), 0);

    mocks.getSession.mockResolvedValue(keySession(READ, '7d'));
    const bounded = await (await chatGET(req(), { params: tParams() }) as Response).json();
    expect(bounded.messages.length).toBe(1);
    expect(bounded.total).toBe(1);

    mocks.getSession.mockResolvedValue(keySession(READ, 'full'));
    const unbounded = await (await chatGET(req(), { params: tParams() }) as Response).json();
    expect(unbounded.total).toBe(5);
  });

  it('paging with `before=` cannot walk past the floor', async () => {
    // The bound lives in the WHERE clause, so it is re-applied on every page.
    const inside = await seedMessage(ago(1), 0);
    const old = await seedMessage(ago(400), 0);

    mocks.getSession.mockResolvedValue(keySession(READ, '7d'));
    const page = await (await chatGET(req(`?before=${inside}`), { params: tParams() }) as Response).json();
    expect(page.messages).toEqual([]);

    // The same cursor with `full` DOES reach the old message — proving the empty
    // page above came from the grant, not from the cursor.
    mocks.getSession.mockResolvedValue(keySession(READ, 'full'));
    const wide = await (await chatGET(req(`?before=${inside}`), { params: tParams() }) as Response).json();
    expect(wide.messages.map((m: { id: string }) => m.id)).toEqual([old]);
  });

  it('`since=` polling is bounded by the grant as well', async () => {
    await seedMessage(ago(400), 0);
    const recent = await seedMessage(ago(1), 0);

    mocks.getSession.mockResolvedValue(keySession(READ, '7d'));
    const body = await (
      await chatGET(req(`?since=${new Date(0).toISOString()}`), { params: tParams() }) as Response
    ).json();
    expect(body.messages.map((m: { id: string }) => m.id)).toEqual([recent]);
  });

  it('since_epoch:N returns only messages sealed at epoch N or later', async () => {
    await seedMessage(ago(1), 1);
    const e3 = await seedMessage(ago(1), 3);
    const e9 = await seedMessage(ago(1), 9);

    mocks.getSession.mockResolvedValue(keySession(READ, 'since_epoch:3'));
    const body = await (await chatGET(req(), { params: tParams() }) as Response).json();
    expect(new Set(body.messages.map((m: { id: string }) => m.id))).toEqual(new Set([e3, e9]));
  });

  it('the newest-N grant returns exactly N at the boundary, and everything when the topic is shorter', async () => {
    for (const d of [1, 2, 3, 4, 5]) await seedMessage(ago(d), 0);

    mocks.getSession.mockResolvedValue(keySession(READ, '3'));
    const three = await (await chatGET(req(), { params: tParams() }) as Response).json();
    expect(three.messages.length).toBe(3);
    expect(three.total).toBe(3);

    mocks.getSession.mockResolvedValue(keySession(READ, '99'));
    const all = await (await chatGET(req(), { params: tParams() }) as Response).json();
    expect(all.messages.length).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Bounded grants — archive
// ---------------------------------------------------------------------------

describe('archive under a bounded grant', () => {
  it('bounds on the original message age even though every row was archived just now', async () => {
    const recent = await seedArchived(ago(2), 0);
    await seedArchived(ago(400), 0);

    mocks.getSession.mockResolvedValue(keySession(READ, '7d'));
    const body = await (await archiveGET(req(), { params: tParams() })).json();
    expect(body.archive.map((r: { messageId: string }) => r.messageId)).toEqual([recent]);
  });

  it('since_epoch:N bounds by the original message epoch, not by tak_version', async () => {
    // tak_version is 0 on public topics regardless of epoch, so a tak_version
    // bound would answer differently here — this pins the correct column.
    const e5 = await seedArchived(ago(1), 5);
    await seedArchived(ago(1), 1);
    await db.update(schema.chatArchive).set({ takVersion: 0 }).where(eq(schema.chatArchive.topicId, TOPIC));

    mocks.getSession.mockResolvedValue(keySession(READ, 'since_epoch:5'));
    const body = await (await archiveGET(req(), { params: tParams() })).json();
    expect(body.archive.map((r: { messageId: string }) => r.messageId)).toEqual([e5]);
  });

  it('the keyset cursor still works under a window (page size 1, no dups)', async () => {
    const ids = [await seedArchived(ago(1), 0), await seedArchived(ago(2), 0)];
    await seedArchived(ago(400), 0);
    mocks.getSession.mockResolvedValue(keySession(READ, '7d'));

    const seen: string[] = [];
    let q = '?limit=1';
    for (let i = 0; i < 5; i++) {
      const rows = (await (await archiveGET(req(q), { params: tParams() })).json()).archive;
      if (rows.length === 0) break;
      seen.push(...rows.map((r: { messageId: string }) => r.messageId));
      const last = rows[rows.length - 1];
      q = `?limit=1&since=${encodeURIComponent(last.createdAt)}&sinceMsg=${last.messageId}`;
    }
    expect(seen.length).toBe(2);
    expect(new Set(seen)).toEqual(new Set(ids));
  });
});

// ---------------------------------------------------------------------------
// Bounded grants — TAK bundles
// ---------------------------------------------------------------------------

describe('tak bundles under a bounded grant', () => {
  const put = (scope: string) => storeTakBundle(db as never, TOPIC, USER, DEVICE, Buffer.from(`b-${scope}`), scope);

  it('withholds bundles wider than the grant and delivers the ones inside it', async () => {
    for (const s of ['full', '30d', '7d', 'since_epoch:2', 'none']) await put(s);
    mocks.getSession.mockResolvedValue(keySession(READ, '30d'));

    const scopes = (await (await takGET(req(`?deviceId=${DEVICE}`), { params: tParams() })).json()).bundles.map(
      (b: { scope: string }) => b.scope,
    );
    expect(new Set(scopes)).toEqual(new Set(['30d', '7d', 'none']));
    expect(scopes).not.toContain('full');
    expect(scopes).not.toContain('since_epoch:2'); // different shape → not provably inside
  });

  it('a withheld bundle stays UNACKED and is still delivered to a wider credential', async () => {
    await put('full');
    mocks.getSession.mockResolvedValue(keySession(READ, '7d'));
    expect((await (await takGET(req(`?deviceId=${DEVICE}`), { params: tParams() })).json()).bundles).toEqual([]);

    // Narrowing one key must not destroy history for the rest of the account.
    mocks.getSession.mockResolvedValue(keySession(READ, 'full'));
    const wide = (await (await takGET(req(`?deviceId=${DEVICE}`), { params: tParams() })).json()).bundles;
    expect(wide.map((b: { scope: string }) => b.scope)).toEqual(['full']);
  });

  it('a bundle carrying a scope the server can no longer parse is withheld', async () => {
    // Rows predating the scope allowlist, or written by a future/rolled-back
    // version. Unparseable is not "unrestricted".
    await db.insert(schema.takBundles).values({
      topicId: TOPIC, recipientUserId: USER, recipientDeviceId: DEVICE,
      ciphertext: Buffer.from('legacy'), scope: 'legacy-everything',
    });
    mocks.getSession.mockResolvedValue(keySession(READ, '30d'));
    expect((await (await takGET(req(`?deviceId=${DEVICE}`), { params: tParams() })).json()).bundles).toEqual([]);
  });
});
