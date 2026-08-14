import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import {
  authGet,
  authPost,
  secondUserPost,
  getSecondUserToken,
  publicPost,
  fetchCategorySlugs,
  deleteTopic,
} from './helpers';
import { placeholderGroupCipher } from '@/lib/crypto/groupCipherPlaceholder';
import { envGate, announceEnvGates } from './db-helpers';

/**
 * R-1 E2E: `chat_messages.ciphertext` is reclaimed once every device owed a
 * message has fetched it AND an archive row exists (src/lib/chatDeliveryPurge.ts).
 * `src/__tests__/chatDeliveryPurge.test.ts` already exercises `isPurgeable` and
 * the SQL directly against a local Postgres connection; this file is the
 * missing HTTP layer — driving the same guard through the real
 * `POST /chat/delivered` and `POST /archive` routes against the running
 * container, the way a real client would.
 *
 * TWO STRUCTURAL CONSTRAINTS shape every case below:
 *
 * 1. `sweepTopicDelivery` throttles to one real pass per topic per
 *    `DELIVERY_SWEEP_INTERVAL_MS` (60s), in an in-process Map this test process
 *    cannot reach (`resetDeliverySweepThrottle` is not reachable over HTTP —
 *    per the task brief, not attempted here). A topic never swept before is
 *    swept IMMEDIATELY on its first ack/archive call, so every case below uses
 *    a FRESH topic and fires exactly ONE HTTP call that can trigger a sweep
 *    (the delivery ack) as its last setup step — any earlier ack or archive
 *    call on that same topic would consume the free pass and leave the
 *    assertion racing a 60s throttle.
 * 2. To prove a sweep actually RAN (not just "hasn't happened yet"), most
 *    cases send a CONTROL message the same ack call is expected to purge
 *    alongside the message under test — a positive, fast, unambiguous signal
 *    that the fire-and-forget pass executed, instead of a bare timed wait.
 *
 * Non-focal setup (archive rows, delivery cursors with precise
 * firstSeenAt/deliveredThrough boundaries) is written directly to Postgres —
 * legitimate per the task's "direct DB access for setup" allowance, and the
 * only way to hit exact matrix boundaries without spending the one free sweep
 * per topic on a setup call. The ack call under test is always the real
 * `POST /chat/delivered` route.
 */

const DB_URL = process.env.DATABASE_URL ?? null;
const DEVICE_B = 'e2e-r1-purge-device-b';

interface WireMessage {
  id: string;
  type: string;
  message: string | null;
  sealed: { ciphertext: string; epoch: number; takVersion: number | null } | null;
  createdAt: string;
}

let client: Client | null = null;
let categoryId: string;
const createdTopicIds: string[] = [];

function db(): Client {
  if (!client) throw new Error('DATABASE_URL required for this case — see .env.test.local');
  return client;
}

async function createTopic(title: string): Promise<string> {
  const res = await authPost('/api/topics', {
    title: `${title} ${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    description: 'R-1 delivery purge E2E',
    visibility: 'public',
    categoryId,
  });
  expect(res.status).toBe(201);
  const id = (await res.json()).topic.id as string;
  createdTopicIds.push(id);
  return id;
}

type Poster = (path: string, body?: unknown) => Promise<Response>;

async function send(
  topicId: string,
  text: string,
  post: Poster = authPost,
): Promise<{ id: string; createdAt: string }> {
  const sealed = await placeholderGroupCipher.seal(topicId, text);
  const res = await post(`/api/topics/${topicId}/chat`, { ciphertext: sealed.ciphertext, epoch: sealed.epoch });
  expect(res.status).toBe(201);
  const json = await res.json();
  return { id: json.message.id as string, createdAt: json.message.createdAt as string };
}

async function historySince(
  topicId: string,
  sinceIso: string,
  get: (path: string) => Promise<Response> = authGet,
): Promise<WireMessage[]> {
  const res = await get(`/api/topics/${topicId}/chat?since=${encodeURIComponent(sinceIso)}&limit=500`);
  expect(res.status).toBe(200);
  return (await res.json()).messages as WireMessage[];
}

async function findMessage(
  topicId: string,
  messageId: string,
  sinceIso: string,
  get: (path: string) => Promise<Response> = authGet,
): Promise<WireMessage> {
  const found = (await historySince(topicId, sinceIso, get)).find((m) => m.id === messageId);
  if (!found) throw new Error(`message ${messageId} not found in ${topicId} since ${sinceIso}`);
  return found;
}

const POLL_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 300;

/** Positive assertion: poll until the message's live ciphertext is gone. */
async function waitForPurged(topicId: string, messageId: string, sinceIso: string): Promise<void> {
  const start = Date.now();
  let msg = await findMessage(topicId, messageId, sinceIso);
  while (Date.now() - start < POLL_TIMEOUT_MS && msg.sealed !== null) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    msg = await findMessage(topicId, messageId, sinceIso);
  }
  if (msg.sealed !== null) {
    throw new Error(`message ${messageId} in ${topicId} was not purged within ${POLL_TIMEOUT_MS}ms`);
  }
}

/** Negative assertion: the message's ciphertext must NOT disappear across a short settle window. */
async function assertStaysDelivered(topicId: string, messageId: string, sinceIso: string, windowMs = 2500): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < windowMs) {
    const msg = await findMessage(topicId, messageId, sinceIso);
    if (msg.sealed === null) {
      throw new Error(`message ${messageId} in ${topicId} was purged when the guard should have blocked it`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function insertArchive(topicId: string, messageId: string): Promise<void> {
  await db().query(
    `INSERT INTO chat_archive (topic_id, message_id, tak_version, ciphertext) VALUES ($1, $2, 1, $3)`,
    [topicId, messageId, Buffer.from(`archived-${messageId}`, 'utf-8')],
  );
}

async function deleteArchive(topicId: string, messageId: string): Promise<void> {
  await db().query(`DELETE FROM chat_archive WHERE topic_id = $1 AND message_id = $2`, [topicId, messageId]);
}

async function insertCursor(
  topicId: string,
  deviceId: string,
  userId: string,
  opts: { firstSeenAt: Date; deliveredThrough: Date; lastSeenAt?: Date },
): Promise<void> {
  await db().query(
    `INSERT INTO chat_delivery_cursors (topic_id, device_id, user_id, delivered_through, first_seen_at, last_seen_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [topicId, deviceId, userId, opts.deliveredThrough, opts.firstSeenAt, opts.lastSeenAt ?? new Date()],
  );
}

async function selectCursor(
  topicId: string,
  deviceId: string,
): Promise<{ delivered_through: Date; first_seen_at: Date } | null> {
  const res = await db().query<{ delivered_through: Date; first_seen_at: Date }>(
    `SELECT delivered_through, first_seen_at FROM chat_delivery_cursors WHERE topic_id = $1 AND device_id = $2`,
    [topicId, deviceId],
  );
  return res.rows[0] ?? null;
}

async function selectCiphertext(messageId: string): Promise<Buffer | null> {
  const res = await db().query<{ ciphertext: Buffer | null }>(
    `SELECT ciphertext FROM chat_messages WHERE id = $1`,
    [messageId],
  );
  return res.rows[0]?.ciphertext ?? null;
}

const hoursBefore = (iso: string, hours: number) => new Date(new Date(iso).getTime() - hours * 3_600_000);
/**
 * A "definitely delivered" watermark for a message.
 *
 * NOT the message's own `createdAt`. Postgres timestamptz has microsecond
 * resolution; `createdAt` round-trips through JSON at millisecond resolution
 * (`Date#toJSON`), so the value a client ever sees is the FLOOR of the true
 * column value. Acking exactly that floor back can still land microseconds
 * BEFORE the true `created_at`, which the inclusive `delivered_through <
 * created_at` guard reads as "still owed" — not a bug in the guard (no real
 * client can ever observe more precision than the wire format gives it
 * either), but it means "delivered through X" must never be tested with X's
 * own timestamp verbatim. A few ms of slack clears it unambiguously.
 */
const msAfter = (iso: string, ms = 5) => new Date(new Date(iso).getTime() + ms);

describe.sequential('Chat delivery purge (R-1) — real HTTP against the running container', () => {
  beforeAll(async () => {
    // See db-helpers.ts: console output at module-collection time is not
    // reliably surfaced by vitest's reporter, so the warning is printed from
    // a hook instead — the counting itself already happened at collection
    // time, in the it.skipIf(envGate(...)) calls below.
    announceEnvGates('chat-delivery-purge.test.ts');

    const cats = await fetchCategorySlugs();
    expect(cats.length).toBeGreaterThan(0);
    categoryId = cats[0].id;
    if (DB_URL) {
      client = new Client({ connectionString: DB_URL });
      await client.connect();
    }
  });

  afterAll(async () => {
    for (const id of createdTopicIds) {
      try {
        await deleteTopic(id);
      } catch {
        // best-effort cleanup
      }
    }
    if (client) await client.end();
  });

  // ── 1. CONTRACT: an outstanding device blocks the purge ──────────────────
  it.skipIf(envGate('DATABASE_URL'))('1. CONTRACT: a device owed the message blocks its purge', async () => {
    const topicId = await createTopic('R1 purge blocks');
    const anchor = await send(topicId, 'anchor');
    const { userId: bId } = await getSecondUserToken();
    const join = await secondUserPost(`/api/topics/${topicId}/join`);
    expect([200, 201]).toContain(join.status);

    // A control message B WILL be acked through (proves the sweep really ran),
    // and the target message B is deliberately never acked through.
    const control = await send(topicId, 'control-purges');
    const target = await send(topicId, 'target-blocked');
    await insertArchive(topicId, control.id);
    await insertArchive(topicId, target.id);

    // B "was in the group" before both messages and has fetched through the
    // control message only — the target is still outstanding for B.
    await insertCursor(topicId, DEVICE_B, bId, {
      firstSeenAt: hoursBefore(control.createdAt, 1),
      deliveredThrough: msAfter(control.createdAt),
    });

    // The one HTTP call that may trigger a sweep for this topic — matches the
    // DB state (idempotent GREATEST), so it also IS the trigger.
    const ack = await secondUserPost(`/api/topics/${topicId}/chat/delivered`, {
      deviceId: DEVICE_B,
      through: msAfter(control.createdAt).toISOString(),
    });
    expect(ack.status).toBe(200);

    await waitForPurged(topicId, control.id, anchor.createdAt); // proves the sweep ran
    await assertStaysDelivered(topicId, target.id, anchor.createdAt); // the actual guard

    // Evidence: the row survives in the DB too, not just in the API response.
    expect(await selectCiphertext(target.id)).not.toBeNull();
  });

  // ── 2. CONTRACT: ack releases the live copy; the archive row survives ────
  it.skipIf(envGate('DATABASE_URL'))('2. CONTRACT: acking through the message purges ciphertext, archive row survives', async () => {
    const topicId = await createTopic('R1 purge releases');
    const anchor = await send(topicId, 'anchor');
    const { userId: bId } = await getSecondUserToken();
    const join = await secondUserPost(`/api/topics/${topicId}/join`);
    expect([200, 201]).toContain(join.status);

    const target = await send(topicId, 'target-released');
    await insertArchive(topicId, target.id);
    await insertCursor(topicId, DEVICE_B, bId, {
      firstSeenAt: hoursBefore(target.createdAt, 1),
      deliveredThrough: hoursBefore(target.createdAt, 1), // not yet delivered
    });

    const before = await findMessage(topicId, target.id, anchor.createdAt);
    expect(before.sealed).not.toBeNull();

    const ack = await secondUserPost(`/api/topics/${topicId}/chat/delivered`, {
      deviceId: DEVICE_B,
      through: msAfter(target.createdAt).toISOString(),
    });
    expect(ack.status).toBe(200);

    await waitForPurged(topicId, target.id, anchor.createdAt);
    expect(await selectCiphertext(target.id)).toBeNull();

    // The whole point: history is gone, the archive copy is not.
    const archiveRes = await authGet(`/api/topics/${topicId}/archive`);
    expect(archiveRes.status).toBe(200);
    const { archive } = await archiveRes.json();
    const row = archive.find((a: { messageId: string }) => a.messageId === target.id);
    expect(row).toBeTruthy();
    expect(Buffer.from(row.ciphertext, 'base64').toString('utf-8')).toBe(`archived-${target.id}`);
  });

  // ── 3. INTEGRITY: the archive guard is unconditional ─────────────────────
  it.skipIf(envGate('DATABASE_URL'))('3. INTEGRITY: a delivered message with no archive row is never purged', async () => {
    const topicId = await createTopic('R1 purge archive guard');
    const anchor = await send(topicId, 'anchor');
    const { userId: bId } = await getSecondUserToken();
    const join = await secondUserPost(`/api/topics/${topicId}/join`);
    expect([200, 201]).toContain(join.status);

    const control = await send(topicId, 'control-purges');
    const target = await send(topicId, 'target-no-archive');

    await insertArchive(topicId, control.id); // kept — this one purges
    await insertArchive(topicId, target.id); // simulate archiveOnSend having landed once...
    await deleteArchive(topicId, target.id); // ...then lost, per the file header's failure mode

    // B is fully delivered for BOTH messages — the ONLY thing standing between
    // `target` and deletion is the missing archive row.
    const ack = await secondUserPost(`/api/topics/${topicId}/chat/delivered`, {
      deviceId: DEVICE_B,
      through: msAfter(target.createdAt).toISOString(),
    });
    expect(ack.status).toBe(200);

    await waitForPurged(topicId, control.id, anchor.createdAt); // proves the sweep ran
    await assertStaysDelivered(topicId, target.id, anchor.createdAt);
    expect(await selectCiphertext(target.id)).not.toBeNull();
  });

  // ── 4. BOUNDARY: a later joiner is not owed the message ──────────────────
  it.skipIf(envGate('DATABASE_URL'))('4. BOUNDARY: a device whose cursor starts after the message does not block it', async () => {
    const topicId = await createTopic('R1 purge later joiner');
    const anchor = await send(topicId, 'anchor');
    const { userId: bId } = await getSecondUserToken();
    const join = await secondUserPost(`/api/topics/${topicId}/join`);
    expect([200, 201]).toContain(join.status);

    const prior = await send(topicId, 'prior-anchor-for-through');
    const target = await send(topicId, 'target-later-joiner');
    await insertArchive(topicId, target.id);

    // B's cursor starts AFTER `target` was sent (a later joiner) and has only
    // delivered through `prior` — strictly before `target`. If firstSeenAt were
    // not checked, this row would BLOCK the purge; it must not.
    await insertCursor(topicId, DEVICE_B, bId, {
      firstSeenAt: new Date(new Date(target.createdAt).getTime() + 3_600_000),
      deliveredThrough: new Date(prior.createdAt),
    });

    const ack = await secondUserPost(`/api/topics/${topicId}/chat/delivered`, {
      deviceId: DEVICE_B,
      through: prior.createdAt, // deliberately does NOT cover `target`
    });
    expect(ack.status).toBe(200);

    await waitForPurged(topicId, target.id, anchor.createdAt);

    // Evidence the purge was NOT because B "delivered" it — B's watermark
    // never moved past `prior`, strictly before `target.createdAt`.
    const cursor = await selectCursor(topicId, DEVICE_B);
    expect(cursor).not.toBeNull();
    expect(cursor!.delivered_through.getTime()).toBeLessThan(new Date(target.createdAt).getTime());
  });

  // ── 5. INTEGRITY: system rows are never touched ───────────────────────────
  it.skipIf(envGate('DATABASE_URL'))('5. INTEGRITY: join/leave system rows survive a sweep that purges a sibling message', async () => {
    const topicId = await createTopic('R1 purge system rows');
    const anchor = await send(topicId, 'anchor');
    const { userId: bId } = await getSecondUserToken();
    const join = await secondUserPost(`/api/topics/${topicId}/join`);
    expect([200, 201]).toContain(join.status);

    const joinRow = (await historySince(topicId, anchor.createdAt)).find(
      (m) => m.type === 'join' && m.message?.includes('joined'),
    );
    expect(joinRow).toBeTruthy();

    const target = await send(topicId, 'target-purges');
    await insertArchive(topicId, target.id);
    await insertCursor(topicId, DEVICE_B, bId, {
      firstSeenAt: hoursBefore(target.createdAt, 1),
      deliveredThrough: hoursBefore(target.createdAt, 1),
    });

    const ack = await secondUserPost(`/api/topics/${topicId}/chat/delivered`, {
      deviceId: DEVICE_B,
      through: msAfter(target.createdAt).toISOString(),
    });
    expect(ack.status).toBe(200);

    await waitForPurged(topicId, target.id, anchor.createdAt); // sweep really ran

    const joinRowAfter = await findMessage(topicId, joinRow!.id, anchor.createdAt);
    expect(joinRowAfter.type).toBe('join');
    expect(joinRowAfter.message).toBe(joinRow!.message);
    expect(joinRowAfter.createdAt).toBe(joinRow!.createdAt);
    expect(joinRowAfter.sealed).toBeNull(); // system rows never carry ciphertext to begin with
  });

  // ── 6. AUTHZ: only a member's own device may move a delivery mark ────────
  it('6. AUTHZ: non-member gets 403, guest gets 401', async () => {
    const topicId = await createTopic('R1 purge authz');

    const nonMember = await secondUserPost(`/api/topics/${topicId}/chat/delivered`, {
      deviceId: 'e2e-non-member-device',
      through: new Date().toISOString(),
    });
    expect(nonMember.status).toBe(403);

    const guest = await publicPost(`/api/topics/${topicId}/chat/delivered`, {
      deviceId: 'e2e-guest-device',
      through: new Date().toISOString(),
    });
    expect(guest.status).toBe(401);

    if (DB_URL) {
      const nonMemberRow = await selectCursor(topicId, 'e2e-non-member-device');
      expect(nonMemberRow).toBeNull(); // rejected before it could corrupt a cursor
    }
  });

  // ── 7. HOSTILE: malformed deviceId / through is rejected, not corrupted ──
  it.skipIf(envGate('DATABASE_URL'))('7. HOSTILE: junk deviceId/through are rejected with 400, not stored', async () => {
    const topicId = await createTopic('R1 purge hostile input');
    const join = await secondUserPost(`/api/topics/${topicId}/join`);
    expect([200, 201]).toContain(join.status);
    const nowIso = new Date().toISOString();

    const emptyDevice = await secondUserPost(`/api/topics/${topicId}/chat/delivered`, { deviceId: '', through: nowIso });
    expect(emptyDevice.status).toBe(400);

    const whitespaceDevice = await secondUserPost(`/api/topics/${topicId}/chat/delivered`, {
      deviceId: '   ',
      through: nowIso,
    });
    expect(whitespaceDevice.status).toBe(400);

    // Public contract caps deviceId at 128 chars (OpenAPI maxLength on this route).
    const tooLongDevice = await secondUserPost(`/api/topics/${topicId}/chat/delivered`, {
      deviceId: 'x'.repeat(129),
      through: nowIso,
    });
    expect(tooLongDevice.status).toBe(400);

    const missingThrough = await secondUserPost(`/api/topics/${topicId}/chat/delivered`, {
      deviceId: DEVICE_B,
      through: '',
    });
    expect(missingThrough.status).toBe(400);

    const garbageThrough = await secondUserPost(`/api/topics/${topicId}/chat/delivered`, {
      deviceId: DEVICE_B,
      through: 'not-a-timestamp',
    });
    expect(garbageThrough.status).toBe(400);

    // None of the above may have created a cursor row.
    expect(await selectCursor(topicId, DEVICE_B)).toBeNull();
    expect(await selectCursor(topicId, 'x'.repeat(129))).toBeNull();

    // A SQL-shaped but well-formed (parameterized-query-safe) deviceId under
    // the length cap is accepted and stored verbatim — proves the value is
    // bound as data, never concatenated into the statement.
    const hostileButValid = "e2e-'; DROP TABLE chat_delivery_cursors; --";
    const accepted = await secondUserPost(`/api/topics/${topicId}/chat/delivered`, {
      deviceId: hostileButValid,
      through: nowIso,
    });
    expect(accepted.status).toBe(200);
    const stored = await selectCursor(topicId, hostileButValid);
    expect(stored).not.toBeNull();
  });

  // ── 8. EXT-DEP: the 30-day grace cap ──────────────────────────────────────
  // Not exercised here. `scheduleDeliverySweep` (called from both the ack and
  // archive routes) always calls `sweepTopicDelivery` with no `opts`, so
  // `DELIVERY_GRACE_DAYS` (30) is hardcoded at the HTTP layer with no override
  // reachable from a client — reaching it in an E2E test would require 30 real
  // days or manipulating the server clock, neither of which this suite can do.
  // The boundary (`createdAt` exactly at, and one second past, the grace
  // floor) is exercised with an injectable `now` in
  // `src/__tests__/chatDeliveryPurge.test.ts` ('BOUNDARY: the grace cap
  // releases a message no device ever fetched').
});
