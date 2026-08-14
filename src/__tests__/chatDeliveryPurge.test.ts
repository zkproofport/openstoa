/**
 * Reclaiming the LIVE copy — the pure rule, and the statement that acts on it.
 *
 * Two layers on purpose. `isPurgeable` is where every rule is decided and can
 * be interrogated one condition at a time; the SQL is one statement with four
 * predicates and cannot be asked WHY it spared a row. Both are exercised here
 * against the same scenarios, because the failure that matters is the two
 * disagreeing — a rule that says "keep" while the statement deletes is a
 * message the user will never see again.
 *
 * The SQL half needs the local dev DB (DATABASE_URL or default), for the same
 * reason `archiveRetentionSweep.test.ts` does: every claim here is a property
 * of the statement, and a mocked executor would prove only that a function was
 * called.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage in this file
 *   integrity (THE guard) → 'a message with NO archive row is never purged',
 *                           incl. past the grace cap and in a one-member topic
 *   boundary              → 0 / 1 / many devices; cursor exactly AT the message
 *                           instant; the grace edge and one second past it;
 *                           the staleness edge
 *   authorization         → a device belonging to a REMOVED member stops
 *                           blocking; route-level gates live in the route test
 *   race                  → a message sent DURING a purge survives it; an ack
 *                           landing mid-purge cannot lose a message
 *   contract              → system rows are never touched; `chat_archive` is
 *                           never touched; the throttle runs at most once per
 *                           interval; a failed sweep is swallowed
 *   result integrity      → never reaches another topic's rows
 *   empty/null/undefined  → no devices at all; no cursor rows; a NULL ciphertext
 *                           row is a no-op rather than an error
 *   hostile input         → a topic id that does not exist purges nothing
 *   UTF-8 / large         → N/A at this layer: the statement reads timestamps
 *                           and ids, never user text. Device-id shape is
 *                           validated at the route (see its own test).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import * as schema from '@/lib/db/schema';
import {
  DELIVERY_GRACE_DAYS,
  DELIVERY_SWEEP_INTERVAL_MS,
  DEVICE_STALE_DAYS,
  isPurgeable,
  purgeDeliveredCiphertext,
  resetDeliverySweepThrottle,
  scheduleDeliverySweep,
  sweepTopicDelivery,
  type OwedDevice,
} from '@/lib/chatDeliveryPurge';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://proofport:proofport@localhost:5432/openstoa';

const DAY_MS = 86_400_000;
const NOW = new Date('2026-08-14T00:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);

// ─── The pure rule ───────────────────────────────────────────────────────────

/** A device that is a current member, seen just now, and up to date. */
function device(over: Partial<OwedDevice> = {}): OwedDevice {
  return {
    firstSeenAt: ago(30 * DAY_MS),
    lastSeenAt: NOW,
    deliveredThrough: NOW,
    isMember: true,
    ...over,
  };
}

describe('isPurgeable — the archive guard', () => {
  it('INTEGRITY: a message with NO archive row is NEVER purged', () => {
    /*
     * The load-bearing one. `archiveOnSend` is fire-and-forget and can fail, and
     * in a one-member topic every device has "delivered" it the instant it is
     * sent — so this check is the only thing between a failed upload and a
     * message that is simply gone.
     */
    expect(isPurgeable({ createdAt: ago(DAY_MS), hasArchiveRow: false, devices: [], now: NOW })).toBe(false);
  });

  it('INTEGRITY: the grace cap does NOT override the archive guard', () => {
    // The cap relaxes the delivery half only. A year-old message with no
    // archive copy is still the only copy.
    expect(
      isPurgeable({ createdAt: ago(365 * DAY_MS), hasArchiveRow: false, devices: [], now: NOW }),
    ).toBe(false);
  });

  it('BOUNDARY: a one-member topic purges as soon as the archive row exists', () => {
    // Delivery is trivially satisfied here, which is exactly why the archive
    // check carries the whole weight.
    expect(isPurgeable({ createdAt: ago(1000), hasArchiveRow: true, devices: [], now: NOW })).toBe(true);
  });
});

describe('isPurgeable — who is owed', () => {
  const base = { createdAt: ago(DAY_MS), hasArchiveRow: true, now: NOW };

  it('a device that has NOT fetched it blocks the purge', () => {
    expect(isPurgeable({ ...base, devices: [device({ deliveredThrough: ago(2 * DAY_MS) })] })).toBe(false);
  });

  it('BOUNDARY: a cursor exactly AT the message instant counts as delivered', () => {
    // "delivered through T" includes T. The other reading would hold every
    // message hostage to a millisecond.
    const createdAt = ago(DAY_MS);
    expect(isPurgeable({ ...base, createdAt, devices: [device({ deliveredThrough: createdAt })] })).toBe(true);
    expect(
      isPurgeable({
        ...base,
        createdAt,
        devices: [device({ deliveredThrough: new Date(createdAt.getTime() - 1) })],
      }),
    ).toBe(false);
  });

  it('INTEGRITY: a device that joined AFTER the message is not owed it', () => {
    /*
     * Measured, not assumed: MLS gives a later-added leaf no past-epoch
     * secrets, so those rows are undecryptable to it whether or not the server
     * still holds them. It reads them from `chat_archive`.
     */
    const createdAt = ago(DAY_MS);
    const late = device({ firstSeenAt: new Date(createdAt.getTime() + 1), deliveredThrough: ago(10 * DAY_MS) });
    expect(isPurgeable({ ...base, createdAt, devices: [late] })).toBe(true);
  });

  it('BOUNDARY: a device first seen exactly AT the message instant IS owed it', () => {
    const createdAt = ago(DAY_MS);
    const exact = device({ firstSeenAt: createdAt, deliveredThrough: ago(10 * DAY_MS) });
    expect(isPurgeable({ ...base, createdAt, devices: [exact] })).toBe(false);
  });

  it('AUTHZ: a device whose account has left the topic is owed nothing', () => {
    const gone = device({ isMember: false, deliveredThrough: ago(10 * DAY_MS) });
    expect(isPurgeable({ ...base, devices: [gone] })).toBe(true);
  });

  it('BOUNDARY: many devices — one straggler is enough to block', () => {
    const devices = [device(), device(), device({ deliveredThrough: ago(5 * DAY_MS) }), device()];
    expect(isPurgeable({ ...base, devices })).toBe(false);
    expect(isPurgeable({ ...base, devices: devices.filter((_, i) => i !== 2) })).toBe(true);
  });
});

describe('isPurgeable — staleness and the grace cap', () => {
  const base = { hasArchiveRow: true, now: NOW };

  it('a device silent past the staleness floor stops blocking', () => {
    // Clearing browser data abandons a leaf that never acks again. Without
    // this, "everyone has it" is never true and nothing is ever purged.
    const stale = device({
      lastSeenAt: ago((DEVICE_STALE_DAYS + 1) * DAY_MS),
      deliveredThrough: ago(10 * DAY_MS),
    });
    expect(isPurgeable({ ...base, createdAt: ago(DAY_MS), devices: [stale] })).toBe(true);
  });

  it('BOUNDARY: a device seen exactly AT the staleness floor still blocks', () => {
    const edge = device({
      lastSeenAt: ago(DEVICE_STALE_DAYS * DAY_MS),
      deliveredThrough: ago(10 * DAY_MS),
    });
    expect(isPurgeable({ ...base, createdAt: ago(DAY_MS), devices: [edge] })).toBe(false);
  });

  it('BOUNDARY: the grace cap releases a message no device ever fetched', () => {
    const blocking = device({ deliveredThrough: ago(400 * DAY_MS), firstSeenAt: ago(400 * DAY_MS) });
    const justInside = ago((DELIVERY_GRACE_DAYS - 1) * DAY_MS);
    const justPast = ago((DELIVERY_GRACE_DAYS + 1) * DAY_MS);
    expect(isPurgeable({ ...base, createdAt: justInside, devices: [blocking] })).toBe(false);
    expect(isPurgeable({ ...base, createdAt: justPast, devices: [blocking] })).toBe(true);
  });

  it('the caller may narrow both windows (the SQL takes the same options)', () => {
    const blocking = device({ deliveredThrough: ago(10 * DAY_MS), firstSeenAt: ago(10 * DAY_MS) });
    expect(
      isPurgeable({ ...base, createdAt: ago(2 * DAY_MS), devices: [blocking], graceDays: 1 }),
    ).toBe(true);
  });
});

// ─── The statement ───────────────────────────────────────────────────────────

const USER_A = 'delivery-purge-user-a';
const USER_B = 'delivery-purge-user-b';
const TOPIC = '00000000-0000-4000-8000-000000000050';
const TOPIC_OTHER = '00000000-0000-4000-8000-000000000051';
const ALL_TOPICS = [TOPIC, TOPIC_OTHER];

let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;

/** One live message with an exact creation instant. Returns its id. */
async function seedMessage(
  topicId: string,
  createdAt: Date,
  opts: { type?: string; ciphertext?: Buffer | null } = {},
): Promise<string> {
  const type = opts.type ?? 'message';
  const ct = opts.ciphertext === undefined ? Buffer.from('sealed') : opts.ciphertext;
  const res = await db.execute(sql`
    INSERT INTO chat_messages (topic_id, user_id, ciphertext, epoch, type, created_at, system_text)
    VALUES (${topicId}, ${USER_A}, ${ct}, 1, ${type}, ${createdAt.toISOString()}::timestamptz,
            ${type === 'message' ? null : 'joined'})
    RETURNING id
  `);
  return (res as unknown as { rows: Array<{ id: string }> }).rows[0].id;
}

async function seedArchive(topicId: string, messageId: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO chat_archive (topic_id, message_id, tak_version, ciphertext)
    VALUES (${topicId}, ${messageId}::uuid, 1, ${Buffer.from('archived')})
    ON CONFLICT DO NOTHING
  `);
}

async function seedCursor(
  topicId: string,
  deviceId: string,
  userId: string,
  c: { deliveredThrough: Date; firstSeenAt?: Date; lastSeenAt?: Date },
): Promise<void> {
  await db.execute(sql`
    INSERT INTO chat_delivery_cursors (topic_id, device_id, user_id, delivered_through, first_seen_at, last_seen_at)
    VALUES (${topicId}, ${deviceId}, ${userId}, ${c.deliveredThrough.toISOString()}::timestamptz,
            ${(c.firstSeenAt ?? ago(60 * DAY_MS)).toISOString()}::timestamptz,
            ${(c.lastSeenAt ?? NOW).toISOString()}::timestamptz)
    ON CONFLICT (topic_id, device_id) DO UPDATE
      SET delivered_through = EXCLUDED.delivered_through,
          first_seen_at = EXCLUDED.first_seen_at,
          last_seen_at = EXCLUDED.last_seen_at
  `);
}

async function ciphertextOf(messageId: string): Promise<Buffer | null> {
  const res = await db.execute(sql`SELECT ciphertext FROM chat_messages WHERE id = ${messageId}::uuid`);
  return (res as unknown as { rows: Array<{ ciphertext: Buffer | null }> }).rows[0]?.ciphertext ?? null;
}

beforeAll(async () => {
  pool = new Pool({ connectionString: DATABASE_URL });
  db = drizzle(pool, { schema });
  for (const [id, nickname] of [[USER_A, 'delivery-a'], [USER_B, 'delivery-b']] as const) {
    await db.execute(sql`
      INSERT INTO users (id, nickname) VALUES (${id}, ${nickname})
      ON CONFLICT (id) DO NOTHING
    `);
  }
  for (const topicId of ALL_TOPICS) {
    await db.execute(sql`
      INSERT INTO topics (id, title, creator_id, invite_code)
      VALUES (${topicId}::uuid, 'delivery purge', ${USER_A}, ${'inv-' + topicId.slice(-6)})
      ON CONFLICT (id) DO NOTHING
    `);
    await db.execute(sql`
      INSERT INTO topic_members (topic_id, user_id, role)
      VALUES (${topicId}::uuid, ${USER_A}, 'owner')
      ON CONFLICT DO NOTHING
    `);
  }
});

afterAll(async () => {
  for (const topicId of ALL_TOPICS) {
    await db.execute(sql`DELETE FROM chat_delivery_cursors WHERE topic_id = ${topicId}::uuid`);
    await db.execute(sql`DELETE FROM chat_archive WHERE topic_id = ${topicId}::uuid`);
    await db.execute(sql`DELETE FROM chat_messages WHERE topic_id = ${topicId}::uuid`);
    await db.execute(sql`DELETE FROM topic_members WHERE topic_id = ${topicId}::uuid`);
    await db.execute(sql`DELETE FROM topics WHERE id = ${topicId}::uuid`);
  }
  await db.execute(sql`DELETE FROM users WHERE id IN (${USER_A}, ${USER_B})`);
  await pool.end();
});

beforeEach(async () => {
  resetDeliverySweepThrottle();
  for (const topicId of ALL_TOPICS) {
    await db.execute(sql`DELETE FROM chat_delivery_cursors WHERE topic_id = ${topicId}::uuid`);
    await db.execute(sql`DELETE FROM chat_archive WHERE topic_id = ${topicId}::uuid`);
    await db.execute(sql`DELETE FROM chat_messages WHERE topic_id = ${topicId}::uuid`);
  }
  await db.execute(sql`
    DELETE FROM topic_members WHERE topic_id = ${TOPIC}::uuid AND user_id = ${USER_B}
  `);
});

describe('purgeDeliveredCiphertext — the guard, in SQL', () => {
  it('INTEGRITY: a message with NO archive row survives, even fully delivered', async () => {
    const id = await seedMessage(TOPIC, ago(DAY_MS));
    await seedCursor(TOPIC, 'dev-1', USER_A, { deliveredThrough: NOW });

    expect(await purgeDeliveredCiphertext(db, TOPIC, NOW)).toBe(0);
    expect(await ciphertextOf(id)).not.toBeNull();
  });

  it('INTEGRITY: past the grace cap, a message with no archive row STILL survives', async () => {
    const id = await seedMessage(TOPIC, ago((DELIVERY_GRACE_DAYS + 5) * DAY_MS));
    expect(await purgeDeliveredCiphertext(db, TOPIC, NOW)).toBe(0);
    expect(await ciphertextOf(id)).not.toBeNull();
  });

  it('CONTRACT: archived and delivered → the live copy goes, the row stays', async () => {
    const id = await seedMessage(TOPIC, ago(DAY_MS));
    await seedArchive(TOPIC, id);
    await seedCursor(TOPIC, 'dev-1', USER_A, { deliveredThrough: NOW });

    expect(await purgeDeliveredCiphertext(db, TOPIC, NOW)).toBe(1);
    expect(await ciphertextOf(id)).toBeNull();
    const row = await db.execute(sql`SELECT id FROM chat_messages WHERE id = ${id}::uuid`);
    expect((row as unknown as { rows: unknown[] }).rows).toHaveLength(1);
  });

  it('CONTRACT: `chat_archive` is never touched by this sweep', async () => {
    const id = await seedMessage(TOPIC, ago(DAY_MS));
    await seedArchive(TOPIC, id);
    await seedCursor(TOPIC, 'dev-1', USER_A, { deliveredThrough: NOW });
    await purgeDeliveredCiphertext(db, TOPIC, NOW);

    const res = await db.execute(sql`SELECT ciphertext FROM chat_archive WHERE message_id = ${id}::uuid`);
    const rows = (res as unknown as { rows: Array<{ ciphertext: Buffer }> }).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].ciphertext).not.toBeNull();
  });
});

describe('purgeDeliveredCiphertext — who blocks it, in SQL', () => {
  it('an undelivered device blocks it', async () => {
    const id = await seedMessage(TOPIC, ago(DAY_MS));
    await seedArchive(TOPIC, id);
    await seedCursor(TOPIC, 'dev-1', USER_A, { deliveredThrough: ago(2 * DAY_MS) });

    expect(await purgeDeliveredCiphertext(db, TOPIC, NOW)).toBe(0);
    expect(await ciphertextOf(id)).not.toBeNull();
  });

  it('BOUNDARY: a cursor exactly AT the message instant releases it', async () => {
    const createdAt = ago(DAY_MS);
    const id = await seedMessage(TOPIC, createdAt);
    await seedArchive(TOPIC, id);
    await seedCursor(TOPIC, 'dev-1', USER_A, { deliveredThrough: createdAt });

    expect(await purgeDeliveredCiphertext(db, TOPIC, NOW)).toBe(1);
  });

  it('INTEGRITY: a device that joined after the message does not block it', async () => {
    const createdAt = ago(2 * DAY_MS);
    const id = await seedMessage(TOPIC, createdAt);
    await seedArchive(TOPIC, id);
    await seedCursor(TOPIC, 'late', USER_A, {
      deliveredThrough: ago(10 * DAY_MS),
      firstSeenAt: ago(DAY_MS),
    });

    expect(await purgeDeliveredCiphertext(db, TOPIC, NOW)).toBe(1);
  });

  it('a device silent past the staleness floor does not block it', async () => {
    const id = await seedMessage(TOPIC, ago(DAY_MS));
    await seedArchive(TOPIC, id);
    await seedCursor(TOPIC, 'abandoned', USER_A, {
      deliveredThrough: ago(20 * DAY_MS),
      lastSeenAt: ago((DEVICE_STALE_DAYS + 1) * DAY_MS),
    });

    expect(await purgeDeliveredCiphertext(db, TOPIC, NOW)).toBe(1);
  });

  it('AUTHZ: a cursor whose account is no longer a member does not block it', async () => {
    const id = await seedMessage(TOPIC, ago(DAY_MS));
    await seedArchive(TOPIC, id);
    // USER_B has a cursor but no membership row — removed after acking nothing.
    await seedCursor(TOPIC, 'ex-member-device', USER_B, { deliveredThrough: ago(10 * DAY_MS) });

    expect(await purgeDeliveredCiphertext(db, TOPIC, NOW)).toBe(1);
  });

  it('a SECOND member device that has not caught up blocks it (per device, not per user)', async () => {
    const id = await seedMessage(TOPIC, ago(DAY_MS));
    await seedArchive(TOPIC, id);
    await seedCursor(TOPIC, 'laptop', USER_A, { deliveredThrough: NOW });
    await seedCursor(TOPIC, 'phone', USER_A, { deliveredThrough: ago(3 * DAY_MS) });

    expect(await purgeDeliveredCiphertext(db, TOPIC, NOW)).toBe(0);
  });

  it('BOUNDARY: past the grace cap it goes even with a device that never fetched it', async () => {
    const old = await seedMessage(TOPIC, ago((DELIVERY_GRACE_DAYS + 1) * DAY_MS));
    const recent = await seedMessage(TOPIC, ago(DAY_MS));
    await seedArchive(TOPIC, old);
    await seedArchive(TOPIC, recent);
    await seedCursor(TOPIC, 'never', USER_A, {
      deliveredThrough: ago(400 * DAY_MS),
      firstSeenAt: ago(400 * DAY_MS),
    });

    expect(await purgeDeliveredCiphertext(db, TOPIC, NOW)).toBe(1);
    expect(await ciphertextOf(old)).toBeNull();
    expect(await ciphertextOf(recent)).not.toBeNull();
  });
});

describe('purgeDeliveredCiphertext — what it must not reach', () => {
  it('CONTRACT: a system row is never touched', async () => {
    // join/leave rows carry public text and a NULL ciphertext; they are not
    // this column's business and must not be counted as purged either.
    const id = await seedMessage(TOPIC, ago(DAY_MS), { type: 'join', ciphertext: null });
    await seedArchive(TOPIC, id);
    await seedCursor(TOPIC, 'dev-1', USER_A, { deliveredThrough: NOW });

    expect(await purgeDeliveredCiphertext(db, TOPIC, NOW)).toBe(0);
  });

  it('EMPTY: an already-purged row is a no-op, not an error or a double count', async () => {
    const id = await seedMessage(TOPIC, ago(DAY_MS));
    await seedArchive(TOPIC, id);
    await seedCursor(TOPIC, 'dev-1', USER_A, { deliveredThrough: NOW });

    expect(await purgeDeliveredCiphertext(db, TOPIC, NOW)).toBe(1);
    expect(await purgeDeliveredCiphertext(db, TOPIC, NOW)).toBe(0);
  });

  it('INTEGRITY: never reaches another topic’s rows', async () => {
    const mine = await seedMessage(TOPIC, ago(DAY_MS));
    const theirs = await seedMessage(TOPIC_OTHER, ago(DAY_MS));
    await seedArchive(TOPIC, mine);
    await seedArchive(TOPIC_OTHER, theirs);
    await seedCursor(TOPIC, 'dev-1', USER_A, { deliveredThrough: NOW });
    await seedCursor(TOPIC_OTHER, 'dev-1', USER_A, { deliveredThrough: ago(5 * DAY_MS) });

    expect(await purgeDeliveredCiphertext(db, TOPIC, NOW)).toBe(1);
    expect(await ciphertextOf(theirs)).not.toBeNull();
  });

  it('HOSTILE: a topic id that does not exist purges nothing', async () => {
    const absent = '00000000-0000-4000-8000-0000000000ff';
    expect(await purgeDeliveredCiphertext(db, absent, NOW)).toBe(0);
  });

  it('RACE: a message sent DURING the pass survives it', async () => {
    /*
     * The purge decides against `now`, and a message written after that instant
     * is outside every predicate that could release it — it has no archive row
     * yet and no cursor covers it.
     */
    const fresh = await seedMessage(TOPIC, new Date(NOW.getTime() + 5_000));
    const settled = await seedMessage(TOPIC, ago(DAY_MS));
    await seedArchive(TOPIC, settled);
    await seedCursor(TOPIC, 'dev-1', USER_A, { deliveredThrough: NOW });

    expect(await purgeDeliveredCiphertext(db, TOPIC, NOW)).toBe(1);
    expect(await ciphertextOf(fresh)).not.toBeNull();
  });
});

describe('the sweep around it', () => {
  it('CONTRACT: the throttle runs the purge at most once per interval', async () => {
    const id = await seedMessage(TOPIC, ago(DAY_MS));
    await seedArchive(TOPIC, id);
    await seedCursor(TOPIC, 'dev-1', USER_A, { deliveredThrough: NOW });

    expect(await sweepTopicDelivery(db, TOPIC, NOW)).toEqual({ swept: true, purged: 1 });
    const second = await sweepTopicDelivery(db, TOPIC, new Date(NOW.getTime() + 1_000));
    expect(second).toEqual({ swept: false, purged: 0 });

    const later = new Date(NOW.getTime() + DELIVERY_SWEEP_INTERVAL_MS + 1);
    expect((await sweepTopicDelivery(db, TOPIC, later)).swept).toBe(true);
  });

  it('CONTRACT: a failed sweep is swallowed, never thrown at the request', async () => {
    const broken = {
      execute: async () => {
        throw new Error('connection reset');
      },
    };
    expect(() => scheduleDeliverySweep(broken, TOPIC, NOW)).not.toThrow();
    // Let the rejected promise settle so an unhandled rejection would surface.
    await new Promise((r) => setTimeout(r, 10));
  });
});
