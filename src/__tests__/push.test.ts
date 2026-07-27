/**
 * Phase 6 push notifications — server data layer + content-free dispatch
 * (design §13, D12/D13/D14). Mirrors mls-archive.test.ts: the invariants live in
 * SQL + a small pure dispatcher, so the store is exercised against a real local
 * Postgres and the dispatch against an injected fake provider (no APNs/FCM).
 *
 * Covers the Phase 6 edge matrix rows the SERVER owns at the unit layer:
 *   platform  — ios vs android stored + returned verbatim
 *   race      — re-register same handle = token rotation (upsert, not a dup)
 *   contract  — dispatch queries members EXCLUDING the sender; non-members get
 *               NO token in the dispatch set
 *   integrity — SI-1: the dummy payload carries ZERO message content
 *               (exactly {title, body:'New message', data:{topicId}} — no
 *               ciphertext / plaintext / sender / message field)
 *   graceful  — unconfigured provider (null) → dispatch is a no-op, never throws
 *   validation — isValidPlatform allowlist
 *
 * Requires the local dev DB (DATABASE_URL or default), like mls-archive.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import * as schema from '@/lib/db/schema';
import {
  upsertToken,
  deleteToken,
  getTopicMemberTokens,
  isValidPlatform,
} from '@/lib/pushStore';
import {
  dispatchDummyForMessage,
  buildDummyPayload,
  type PushProvider,
  type PushTarget,
  type DummyPushPayload,
} from '@/lib/push';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://proofport:proofport@localhost:5432/openstoa';

const SENDER = 'push-test-sender';
const MEMBER_B = 'push-test-member-b';
const MEMBER_C = 'push-test-member-c';
const NON_MEMBER = 'push-test-nonmember';
const TOPIC = '00000000-0000-4000-8000-0000000075a6'; // fixed test uuid
const ALL_USERS = [SENDER, MEMBER_B, MEMBER_C, NON_MEMBER];

let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;

/** Fake provider capturing every (target, payload) it is asked to send. */
class CapturingProvider implements PushProvider {
  readonly sent: Array<{ target: PushTarget; payload: DummyPushPayload }> = [];
  async send(target: PushTarget, payload: DummyPushPayload): Promise<void> {
    this.sent.push({ target, payload });
  }
}

async function cleanPush() {
  for (const u of ALL_USERS) {
    await db.delete(schema.pushTokens).where(eq(schema.pushTokens.userId, u));
  }
}

beforeAll(async () => {
  pool = new Pool({ connectionString: DATABASE_URL, max: 8 });
  db = drizzle(pool, { schema });
  await db.delete(schema.topicMembers).where(eq(schema.topicMembers.topicId, TOPIC));
  await cleanPush();
  await db.delete(schema.topics).where(eq(schema.topics.id, TOPIC));
  for (const u of ALL_USERS) await db.delete(schema.users).where(eq(schema.users.id, u));
  await db.insert(schema.users).values(
    ALL_USERS.map((id) => ({ id, nickname: `push_test_${id.slice(-6)}` })),
  );
  await db.insert(schema.topics).values({
    id: TOPIC,
    title: 'Push test topic',
    creatorId: SENDER,
    inviteCode: 'push-invite-code',
    visibility: 'public',
  });
  // Members: SENDER, B, C — NOT the non-member.
  await db.insert(schema.topicMembers).values([
    { topicId: TOPIC, userId: SENDER, role: 'owner' },
    { topicId: TOPIC, userId: MEMBER_B, role: 'member' },
    { topicId: TOPIC, userId: MEMBER_C, role: 'member' },
  ]);
});

afterAll(async () => {
  await db.delete(schema.topicMembers).where(eq(schema.topicMembers.topicId, TOPIC));
  await cleanPush();
  await db.delete(schema.topics).where(eq(schema.topics.id, TOPIC));
  for (const u of ALL_USERS) await db.delete(schema.users).where(eq(schema.users.id, u));
  await pool.end();
});

beforeEach(cleanPush);

describe('isValidPlatform (validation allowlist)', () => {
  it('accepts ios/android, rejects everything else', () => {
    expect(isValidPlatform('ios')).toBe(true);
    expect(isValidPlatform('android')).toBe(true);
    for (const bad of ['IOS', 'web', '', ' ', 'windows', 0, null, undefined, {}]) {
      expect(isValidPlatform(bad)).toBe(false);
    }
  });
});

describe('pushStore.upsertToken (register + rotation)', () => {
  it('stores ios/android platform verbatim (platform branch)', async () => {
    await upsertToken(db, MEMBER_B, 'handle-ios', 'tok-ios', 'ios');
    await upsertToken(db, MEMBER_C, 'handle-android', 'tok-android', 'android');
    const targets = await getTopicMemberTokens(db, TOPIC, SENDER);
    const byUser = Object.fromEntries(targets.map((t) => [t.userId, t]));
    expect(byUser[MEMBER_B].platform).toBe('ios');
    expect(byUser[MEMBER_C].platform).toBe('android');
  });

  it('re-registering the SAME handle rotates the token (upsert, not a dup)', async () => {
    const id1 = await upsertToken(db, MEMBER_B, 'handle-1', 'tok-old', 'ios');
    const id2 = await upsertToken(db, MEMBER_B, 'handle-1', 'tok-new', 'android');
    expect(id1).toBe(id2); // same row
    const rows = await db.query.pushTokens.findMany({ where: eq(schema.pushTokens.userId, MEMBER_B) });
    expect(rows).toHaveLength(1); // no duplicate
    expect(rows[0].pushToken).toBe('tok-new');
    expect(rows[0].platform).toBe('android');
  });

  it('deleteToken removes only the caller-scoped handle and reports the count', async () => {
    await upsertToken(db, MEMBER_B, 'handle-x', 'tok-x', 'ios');
    expect(await deleteToken(db, MEMBER_B, 'handle-x')).toBe(1);
    expect(await deleteToken(db, MEMBER_B, 'handle-x')).toBe(0); // already gone
    // A different user cannot delete B's handle (scoped by user_id).
    await upsertToken(db, MEMBER_B, 'handle-y', 'tok-y', 'ios');
    expect(await deleteToken(db, MEMBER_C, 'handle-y')).toBe(0);
  });
});

describe('getTopicMemberTokens (member exclusion — contract)', () => {
  it('excludes the sender and every non-member', async () => {
    await upsertToken(db, SENDER, 'h-sender', 'tok-sender', 'ios');
    await upsertToken(db, MEMBER_B, 'h-b', 'tok-b', 'ios');
    await upsertToken(db, MEMBER_C, 'h-c', 'tok-c', 'android');
    await upsertToken(db, NON_MEMBER, 'h-nm', 'tok-nm', 'ios'); // registered but not a member

    const targets = await getTopicMemberTokens(db, TOPIC, SENDER);
    const userIds = targets.map((t) => t.userId).sort();
    expect(userIds).toEqual([MEMBER_B, MEMBER_C]); // no sender, no non-member
  });

  it('returns one entry per device when a member holds several handles', async () => {
    await upsertToken(db, MEMBER_B, 'h-b1', 'tok-b1', 'ios');
    await upsertToken(db, MEMBER_B, 'h-b2', 'tok-b2', 'android');
    const targets = await getTopicMemberTokens(db, TOPIC, SENDER);
    expect(targets.filter((t) => t.userId === MEMBER_B)).toHaveLength(2);
  });
});

describe('dispatchDummyForMessage (content-free fan-out)', () => {
  it('SI-1: payload carries ZERO message content and only the topic id', async () => {
    await upsertToken(db, MEMBER_B, 'h-b', 'tok-b', 'ios');
    await upsertToken(db, MEMBER_C, 'h-c', 'tok-c', 'android');
    const provider = new CapturingProvider();

    await dispatchDummyForMessage(db, TOPIC, SENDER, provider);

    expect(provider.sent).toHaveLength(2);
    for (const { payload } of provider.sent) {
      // Exactly {title, body, data} — no ciphertext/plaintext/sender/message.
      expect(Object.keys(payload).sort()).toEqual(['body', 'data', 'title']);
      expect(payload.title).toBe('OpenStoa');
      expect(payload.body).toBe('New message');
      expect(Object.keys(payload.data)).toEqual(['topicId']);
      expect(payload.data.topicId).toBe(TOPIC);
      // Belt-and-suspenders: no content-bearing keys anywhere in the payload.
      const flat = JSON.stringify(payload).toLowerCase();
      for (const forbidden of ['ciphertext', 'plaintext', 'sender', '"message"', 'nickname']) {
        expect(flat.includes(forbidden)).toBe(false);
      }
    }
  });

  it('sends to members only, excluding the sender + non-members (contract)', async () => {
    await upsertToken(db, SENDER, 'h-sender', 'tok-sender', 'ios');
    await upsertToken(db, MEMBER_B, 'h-b', 'tok-b', 'ios');
    await upsertToken(db, NON_MEMBER, 'h-nm', 'tok-nm', 'ios');
    const provider = new CapturingProvider();

    await dispatchDummyForMessage(db, TOPIC, SENDER, provider);

    const tokens = provider.sent.map((s) => s.target.pushToken).sort();
    expect(tokens).toEqual(['tok-b']); // not tok-sender, not tok-nm
  });

  it('graceful no-op when provider is null (push unconfigured) — never throws', async () => {
    await upsertToken(db, MEMBER_B, 'h-b', 'tok-b', 'ios');
    await expect(dispatchDummyForMessage(db, TOPIC, SENDER, null)).resolves.toBeUndefined();
  });

  it('no-op (no send) when no other member has a token', async () => {
    // Only the sender has a token → nothing to dispatch.
    await upsertToken(db, SENDER, 'h-sender', 'tok-sender', 'ios');
    const provider = new CapturingProvider();
    await dispatchDummyForMessage(db, TOPIC, SENDER, provider);
    expect(provider.sent).toHaveLength(0);
  });

  it('one failing device does not abort the fan-out', async () => {
    await upsertToken(db, MEMBER_B, 'h-b', 'tok-b', 'ios');
    await upsertToken(db, MEMBER_C, 'h-c', 'tok-c', 'android');
    let calls = 0;
    const flaky: PushProvider = {
      async send(target) {
        calls++;
        if (target.pushToken === 'tok-b') throw new Error('APNs 400');
      },
    };
    await expect(dispatchDummyForMessage(db, TOPIC, SENDER, flaky)).resolves.toBeUndefined();
    expect(calls).toBe(2); // both attempted despite one throwing
  });
});

describe('buildDummyPayload', () => {
  it('is a pure content-free constant per topic', () => {
    expect(buildDummyPayload(TOPIC)).toEqual({
      title: 'OpenStoa',
      body: 'New message',
      data: { topicId: TOPIC },
    });
  });
});
