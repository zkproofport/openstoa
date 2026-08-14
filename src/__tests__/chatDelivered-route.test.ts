/**
 * The delivery-ack route — real local Postgres.
 *
 * The cursor this endpoint writes is what releases the server's only live copy
 * of a message, so the claims worth defending are all about what a caller must
 * NOT be able to do with it: move another device's mark, move their own
 * backwards, or declare the future delivered. None of those can be checked with
 * a mocked database, because each is a statement about the row that ends up
 * stored.
 *
 * Only the session and the sweep are mocked — the sweep because "the route asks
 * for a purge" is a contract about a call, and its behaviour is pinned in
 * `chatDeliveryPurge.test.ts` against the same real database.
 *
 * Requires the local dev DB (DATABASE_URL or default).
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage in this file
 *   authorization     → guest (401), non-member (403), a device id claimed by
 *                       ANOTHER account (403), and the ack that is refused
 *                       writes nothing
 *   contract          → a first ack creates the row with first_seen = now; the
 *                       route schedules a sweep for the topic in the URL
 *   integrity         → the mark only moves FORWARD; a future mark is clamped
 *                       to the server clock, never trusted
 *   race              → two acks landing together converge on the HIGHER mark
 *   boundary          → a mark exactly equal to the stored one; the device-id
 *                       length cap at, and one past, the limit
 *   empty/null/undef  → missing body, missing/empty/whitespace deviceId, and
 *                       missing/null/invalid `through`, each asserted separately
 *   UTF-8             → a Korean + emoji device id round-trips intact
 *   hostile input     → SQL-shaped and wildcard-shaped device ids are stored as
 *                       data, never interpreted
 *   very large input  → a 10 000-character device id is refused
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import * as schema from '@/lib/db/schema';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://proofport:proofport@localhost:5432/openstoa';

vi.hoisted(() => {
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? 'postgresql://proofport:proofport@localhost:5432/openstoa';
});

const mocks = vi.hoisted(() => ({ getSession: vi.fn(), scheduleDeliverySweep: vi.fn() }));

vi.mock('@/lib/session', () => ({ getSession: mocks.getSession }));
vi.mock('@/lib/chatDeliveryPurge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/chatDeliveryPurge')>()),
  scheduleDeliverySweep: mocks.scheduleDeliverySweep,
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { POST } = await import('@/app/api/topics/[topicId]/chat/delivered/route');

const USER_A = 'delivered-route-user-a';
const USER_B = 'delivered-route-user-b';
const TOPIC = '00000000-0000-4000-8000-000000000060';
const OTHER_TOPIC = '00000000-0000-4000-8000-000000000061';

let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;

function post(topicId: string, body: unknown): Promise<Response> {
  return POST(
    new Request(`http://localhost/api/topics/${topicId}/chat/delivered`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }) as never,
    { params: Promise.resolve({ topicId }) },
  ) as unknown as Promise<Response>;
}

async function cursorRow(topicId: string, deviceId: string) {
  const res = await db.execute(sql`
    SELECT user_id, delivered_through, first_seen_at, last_seen_at
    FROM chat_delivery_cursors WHERE topic_id = ${topicId}::uuid AND device_id = ${deviceId}
  `);
  return (
    res as unknown as {
      rows: Array<{ user_id: string; delivered_through: Date; first_seen_at: Date; last_seen_at: Date }>;
    }
  ).rows[0];
}

beforeAll(async () => {
  pool = new Pool({ connectionString: DATABASE_URL });
  db = drizzle(pool, { schema });
  for (const [id, nickname] of [[USER_A, 'delivered-a'], [USER_B, 'delivered-b']] as const) {
    await db.execute(sql`INSERT INTO users (id, nickname) VALUES (${id}, ${nickname}) ON CONFLICT (id) DO NOTHING`);
  }
  for (const topicId of [TOPIC, OTHER_TOPIC]) {
    await db.execute(sql`
      INSERT INTO topics (id, title, creator_id, invite_code)
      VALUES (${topicId}::uuid, 'delivered route', ${USER_A}, ${'ack-' + topicId.slice(-6)})
      ON CONFLICT (id) DO NOTHING
    `);
  }
  // USER_A is a member of TOPIC only; USER_B is a member of TOPIC as well, so
  // the device-ownership case is about the DEVICE and not about membership.
  for (const userId of [USER_A, USER_B]) {
    await db.execute(sql`
      INSERT INTO topic_members (topic_id, user_id, role) VALUES (${TOPIC}::uuid, ${userId}, 'member')
      ON CONFLICT DO NOTHING
    `);
  }
});

afterAll(async () => {
  for (const topicId of [TOPIC, OTHER_TOPIC]) {
    await db.execute(sql`DELETE FROM chat_delivery_cursors WHERE topic_id = ${topicId}::uuid`);
    await db.execute(sql`DELETE FROM topic_members WHERE topic_id = ${topicId}::uuid`);
    await db.execute(sql`DELETE FROM topics WHERE id = ${topicId}::uuid`);
  }
  await db.execute(sql`DELETE FROM users WHERE id IN (${USER_A}, ${USER_B})`);
  await pool.end();
});

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.getSession.mockResolvedValue({ userId: USER_A, nickname: 'delivered-a' });
  await db.execute(sql`DELETE FROM chat_delivery_cursors WHERE topic_id = ${TOPIC}::uuid`);
});

describe('authorization', () => {
  it('AUTHZ: a guest is refused and writes nothing', async () => {
    mocks.getSession.mockResolvedValue(null);
    const res = await post(TOPIC, { deviceId: 'dev-1', through: new Date().toISOString() });
    expect(res.status).toBe(401);
    expect(await cursorRow(TOPIC, 'dev-1')).toBeUndefined();
  });

  it('AUTHZ: a non-member is refused and writes nothing', async () => {
    const res = await post(OTHER_TOPIC, { deviceId: 'dev-1', through: new Date().toISOString() });
    expect(res.status).toBe(403);
    expect(await cursorRow(OTHER_TOPIC, 'dev-1')).toBeUndefined();
  });

  it('AUTHZ: a device id claimed by ANOTHER account is refused, and the mark does not move', async () => {
    /*
     * The device id is client-supplied — it is the MLS leaf id — so without this
     * binding one member could ack on behalf of another member's device and
     * hurry along the deletion of messages that device has never fetched.
     */
    const mine = new Date('2026-08-01T00:00:00.000Z');
    await post(TOPIC, { deviceId: 'shared-name', through: mine.toISOString() });

    mocks.getSession.mockResolvedValue({ userId: USER_B, nickname: 'delivered-b' });
    const res = await post(TOPIC, { deviceId: 'shared-name', through: '2026-08-10T00:00:00.000Z' });
    expect(res.status).toBe(403);

    const row = await cursorRow(TOPIC, 'shared-name');
    expect(row.user_id).toBe(USER_A);
    expect(new Date(row.delivered_through).toISOString()).toBe(mine.toISOString());
  });
});

describe('what gets stored', () => {
  it('CONTRACT: a first ack creates the row for this device and account', async () => {
    const through = new Date(Date.now() - 60_000);
    const res = await post(TOPIC, { deviceId: 'laptop', through: through.toISOString() });
    expect(res.status).toBe(200);

    const row = await cursorRow(TOPIC, 'laptop');
    expect(row.user_id).toBe(USER_A);
    expect(new Date(row.delivered_through).getTime()).toBe(through.getTime());
    // first_seen is NOW, not the mark: a device is owed nothing sent before it
    // appeared, and back-dating that would make it owed the whole history.
    expect(new Date(row.first_seen_at).getTime()).toBeGreaterThan(through.getTime());
  });

  it('INTEGRITY: the mark only moves FORWARD', async () => {
    const later = new Date('2026-08-10T00:00:00.000Z');
    await post(TOPIC, { deviceId: 'laptop', through: later.toISOString() });

    const res = await post(TOPIC, { deviceId: 'laptop', through: '2026-08-01T00:00:00.000Z' });
    expect(res.status).toBe(200);
    const row = await cursorRow(TOPIC, 'laptop');
    expect(new Date(row.delivered_through).toISOString()).toBe(later.toISOString());
    // …and the response tells the truth about what is stored.
    expect(new Date((await res.json()).deliveredThrough).toISOString()).toBe(later.toISOString());
  });

  it('INTEGRITY: a mark in the FUTURE is clamped to the server clock', async () => {
    // Otherwise a device with a skewed clock — or one that simply sends
    // year 9999 — declares every message it has never seen delivered.
    const before = Date.now();
    const res = await post(TOPIC, { deviceId: 'liar', through: '9999-01-01T00:00:00.000Z' });
    expect(res.status).toBe(200);

    const stored = new Date((await cursorRow(TOPIC, 'liar')).delivered_through).getTime();
    expect(stored).toBeGreaterThanOrEqual(before);
    expect(stored).toBeLessThanOrEqual(Date.now());
  });

  it('BOUNDARY: re-acking the SAME instant is accepted and changes nothing', async () => {
    const at = new Date('2026-08-05T00:00:00.000Z');
    await post(TOPIC, { deviceId: 'laptop', through: at.toISOString() });
    const res = await post(TOPIC, { deviceId: 'laptop', through: at.toISOString() });
    expect(res.status).toBe(200);
    expect(new Date((await cursorRow(TOPIC, 'laptop')).delivered_through).toISOString()).toBe(at.toISOString());
  });

  it('RACE: two acks landing together converge on the HIGHER mark', async () => {
    /*
     * An SSE settle and a catch-up pass finishing at once. Whichever statement
     * commits last, the lower mark must not win: a rewind re-blocks messages the
     * device has already taken delivery of.
     */
    const low = '2026-08-02T00:00:00.000Z';
    const high = '2026-08-09T00:00:00.000Z';
    await Promise.all([
      post(TOPIC, { deviceId: 'racer', through: high }),
      post(TOPIC, { deviceId: 'racer', through: low }),
    ]);
    expect(new Date((await cursorRow(TOPIC, 'racer')).delivered_through).toISOString()).toBe(
      new Date(high).toISOString(),
    );
  });

  it('CONTRACT: the route schedules a sweep for the topic in the URL', async () => {
    // Deleting this call would quietly turn the whole feature off: the cursor
    // would keep moving and nothing would ever be reclaimed.
    await post(TOPIC, { deviceId: 'laptop', through: new Date().toISOString() });
    expect(mocks.scheduleDeliverySweep).toHaveBeenCalledTimes(1);
    expect(mocks.scheduleDeliverySweep.mock.calls[0][1]).toBe(TOPIC);
  });
});

describe('input validation', () => {
  it('EMPTY: a missing body is refused', async () => {
    const res = await post(TOPIC, 'not json');
    expect(res.status).toBe(400);
  });

  it('EMPTY: deviceId missing, empty and whitespace-only are each refused', async () => {
    for (const deviceId of [undefined, null, '', '   ']) {
      const res = await post(TOPIC, { deviceId, through: new Date().toISOString() });
      expect(res.status, String(deviceId)).toBe(400);
    }
  });

  it('EMPTY: `through` missing, null and unparseable are each refused', async () => {
    for (const through of [undefined, null, '', 'yesterday', '2026-13-45']) {
      const res = await post(TOPIC, { deviceId: 'dev-1', through });
      expect(res.status, String(through)).toBe(400);
    }
    expect(await cursorRow(TOPIC, 'dev-1')).toBeUndefined();
  });

  it('LARGE: a 10 000-character device id is refused', async () => {
    const res = await post(TOPIC, { deviceId: 'x'.repeat(10_000), through: new Date().toISOString() });
    expect(res.status).toBe(400);
  });

  it('BOUNDARY: the device-id cap is exact — 128 passes, 129 is refused', async () => {
    const at = new Date().toISOString();
    expect((await post(TOPIC, { deviceId: 'a'.repeat(128), through: at })).status).toBe(200);
    expect((await post(TOPIC, { deviceId: 'a'.repeat(129), through: at })).status).toBe(400);
  });

  it('UTF-8: a Korean and emoji device id round-trips intact', async () => {
    const deviceId = '기기-🌟-1';
    const res = await post(TOPIC, { deviceId, through: new Date().toISOString() });
    expect(res.status).toBe(200);
    expect(await cursorRow(TOPIC, deviceId)).toBeDefined();
  });

  it('HOSTILE: SQL-shaped and wildcard device ids are stored as data, not interpreted', async () => {
    const nasty = ["'; DROP TABLE chat_delivery_cursors; --", '%_\\', '<script>alert(1)</script>'];
    for (const deviceId of nasty) {
      const res = await post(TOPIC, { deviceId, through: new Date().toISOString() });
      expect(res.status, deviceId).toBe(200);
      expect(await cursorRow(TOPIC, deviceId), deviceId).toBeDefined();
    }
    // The table is still there, which is the point of the first one.
    const still = await db.execute(sql`SELECT count(*)::int AS n FROM chat_delivery_cursors`);
    expect((still as unknown as { rows: Array<{ n: number }> }).rows[0].n).toBeGreaterThan(0);
  });
});
