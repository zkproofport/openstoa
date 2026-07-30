/**
 * Phase 7 push notifications — Phase B ciphertext dispatch (design §13.5, D14).
 * Mirrors push.test.ts: the fan-out invariants live in SQL exercised against a
 * real local Postgres, and the payload/mode logic in pure functions exercised
 * against injected fake providers (no APNs/FCM). Covers the Phase 7 edge matrix
 * rows the SERVER owns:
 *   boundary  — payload just under the size cap → ciphertext sent; just over →
 *               content-free dummy fallback
 *   hostile   — missing/empty ct or a bad epoch → dummy fallback
 *   empty     — no other member with a token → no dispatch
 *   contract  — dispatch excludes the sender + all non-members (reuse Phase 6)
 *   integrity — SI-1: payload carries only the OPAQUE ct (== the passed sealed
 *               bytes), zero plaintext / sender / nickname
 *   graceful  — null provider → no-op, never throws
 *   mode      — getPushMode(): content-free default, ciphertext only on the
 *               exact PUSH_MODE=ciphertext
 *
 * Requires the local dev DB (DATABASE_URL or default), like push.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import * as schema from '@/lib/db/schema';
import { upsertToken } from '@/lib/pushStore';
import {
  dispatchCiphertextForMessage,
  buildCiphertextPayload,
  getPushMode,
  PUSH_MAX_PAYLOAD_BYTES,
  type PushProvider,
  type PushTarget,
  type DummyPushPayload,
  type CiphertextPushPayload,
} from '@/lib/push';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://proofport:proofport@localhost:5432/openstoa';

const SENDER = 'pushct-test-sender';
const MEMBER_B = 'pushct-test-member-b';
const MEMBER_C = 'pushct-test-member-c';
const NON_MEMBER = 'pushct-test-nonmember';
const TOPIC = '00000000-0000-4000-8000-0000000075c7'; // fixed test uuid (distinct from push.test.ts)
const MESSAGE_ID = '00000000-0000-4000-8000-0000000075c8';
const ALL_USERS = [SENDER, MEMBER_B, MEMBER_C, NON_MEMBER];

let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;

/** Records which delivery path (content-free vs ciphertext) each device took. */
class CapturingProvider implements PushProvider {
  readonly dummies: Array<{ target: PushTarget; payload: DummyPushPayload }> = [];
  readonly ciphertexts: Array<{ target: PushTarget; payload: CiphertextPushPayload }> = [];
  async send(target: PushTarget, payload: DummyPushPayload): Promise<void> {
    this.dummies.push({ target, payload });
  }
  async sendCiphertext(target: PushTarget, payload: CiphertextPushPayload): Promise<void> {
    this.ciphertexts.push({ target, payload });
  }
}

/** A provider WITHOUT ciphertext support — dispatch must fall back to send(). */
class DummyOnlyProvider implements PushProvider {
  readonly dummies: Array<{ target: PushTarget; payload: DummyPushPayload }> = [];
  async send(target: PushTarget, payload: DummyPushPayload): Promise<void> {
    this.dummies.push({ target, payload });
  }
}

function input(overrides: Partial<Parameters<typeof dispatchCiphertextForMessage>[1]> = {}) {
  return {
    topicId: TOPIC,
    senderUserId: SENDER,
    messageId: MESSAGE_ID,
    sealedCiphertextB64: 'c2VhbGVkLW9wYXF1ZS1ieXRlcw==', // "sealed-opaque-bytes"
    epoch: 3,
    ...overrides,
  };
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
    ALL_USERS.map((id) => ({ id, nickname: `pushct_test_${id.slice(-6)}` })),
  );
  await db.insert(schema.topics).values({
    id: TOPIC,
    title: 'Push ciphertext test topic',
    creatorId: SENDER,
    inviteCode: 'pushct-invite-code',
    visibility: 'public',
  });
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

describe('getPushMode (mode switch)', () => {
  const orig = process.env.PUSH_MODE;
  afterAll(() => {
    if (orig === undefined) delete process.env.PUSH_MODE;
    else process.env.PUSH_MODE = orig;
  });
  it('defaults to content-free and only flips on the exact string "ciphertext"', () => {
    delete process.env.PUSH_MODE;
    expect(getPushMode()).toBe('content-free');
    process.env.PUSH_MODE = 'ciphertext';
    expect(getPushMode()).toBe('ciphertext');
    for (const bad of ['content-free', 'Ciphertext', 'CIPHERTEXT', 'yes', '', ' ciphertext']) {
      process.env.PUSH_MODE = bad;
      expect(getPushMode()).toBe('content-free');
    }
  });
});

describe('buildCiphertextPayload (shape + SI-1 + size cap)', () => {
  it('SI-1: carries ONLY the opaque ct (verbatim) — no plaintext/sender/nickname', () => {
    const p = buildCiphertextPayload(input())!;
    expect(p).not.toBeNull();
    // ct is the exact base64 we passed — server never decoded/re-encoded it.
    expect(p.data.ct).toBe('c2VhbGVkLW9wYXF1ZS1ieXRlcw==');
    expect(p.title).toBe('OpenStoa');
    expect(p.body).toBe('New message'); // pre-decrypt placeholder the NSE overwrites
    expect(p.mutableContent).toBe(true);
    expect(p.dataOnly).toBe(true);
    expect(Object.keys(p.data).sort()).toEqual(['ct', 'epoch', 'messageId', 'topicId']);
    expect(p.data.topicId).toBe(TOPIC);
    expect(p.data.messageId).toBe(MESSAGE_ID);
    expect(p.data.epoch).toBe(3);
    // No content-bearing / identity keys anywhere in the payload.
    const flat = JSON.stringify(p).toLowerCase();
    for (const forbidden of ['plaintext', 'sender', 'nickname', 'author', 'userid']) {
      expect(flat.includes(forbidden)).toBe(false);
    }
  });

  it('boundary: payload just under the cap keeps the ciphertext; just over drops it (null → dummy)', () => {
    // Size the base64 ct so the encoded payload straddles PUSH_MAX_PAYLOAD_BYTES:
    // the non-ct overhead (keys + topic/message uuids + flags) is well under 300 B.
    // Just under: a ct that lands below the cap.
    const under = 'A'.repeat(PUSH_MAX_PAYLOAD_BYTES - 300);
    const pUnder = buildCiphertextPayload(input({ sealedCiphertextB64: under }));
    expect(pUnder).not.toBeNull();
    expect(pUnder!.data.ct).toBe(under);
    expect(Buffer.byteLength(JSON.stringify(pUnder), 'utf8')).toBeLessThanOrEqual(PUSH_MAX_PAYLOAD_BYTES);
    // Just over: a ct that pushes the encoded payload past the cap → null (dummy fallback).
    const over = 'A'.repeat(PUSH_MAX_PAYLOAD_BYTES + 100);
    expect(buildCiphertextPayload(input({ sealedCiphertextB64: over }))).toBeNull();
  });

  it('hostile: missing/empty ct, empty messageId, or a bad epoch → null (dummy fallback)', () => {
    expect(buildCiphertextPayload(input({ sealedCiphertextB64: '' }))).toBeNull();
    expect(buildCiphertextPayload(input({ sealedCiphertextB64: undefined as never }))).toBeNull();
    expect(buildCiphertextPayload(input({ messageId: '' }))).toBeNull();
    expect(buildCiphertextPayload(input({ epoch: -1 }))).toBeNull();
    expect(buildCiphertextPayload(input({ epoch: 1.5 }))).toBeNull();
    expect(buildCiphertextPayload(input({ epoch: NaN }))).toBeNull();
    expect(buildCiphertextPayload(input({ epoch: 'x' as never }))).toBeNull();
  });
});

describe('buildCiphertextPayload — TAK preview fields (act/tv, design §13.6 A)', () => {
  const ACT = 'dGFrLXNlYWxlZC1wcmV2aWV3'; // "tak-sealed-preview"

  it('carries the TAK copy verbatim as act/tv when both fields are valid', () => {
    const p = buildCiphertextPayload(input({ archiveCiphertextB64: ACT, takVersion: 7 }))!;
    expect(p).not.toBeNull();
    expect(p.data.act).toBe(ACT); // verbatim — the server holds no key for it
    expect(p.data.tv).toBe(7);
    expect(p.data.ct).toBe('c2VhbGVkLW9wYXF1ZS1ieXRlcw=='); // MLS ct unchanged
    expect(p.data.epoch).toBe(3);
    expect(Object.keys(p.data).sort()).toEqual(['act', 'ct', 'epoch', 'messageId', 'topicId', 'tv']);
    // Still SI-1: nothing but opaque bytes + routing ids.
    const flat = JSON.stringify(p).toLowerCase();
    for (const forbidden of ['plaintext', 'sender', 'nickname', 'author', 'userid']) {
      expect(flat.includes(forbidden)).toBe(false);
    }
  });

  it('takVersion 0 (public archive root) is valid, not treated as missing', () => {
    const p = buildCiphertextPayload(input({ archiveCiphertextB64: ACT, takVersion: 0 }))!;
    expect(p.data.tv).toBe(0);
    expect(p.data.act).toBe(ACT);
  });

  it('absent preview → payload without act/tv (unchanged Phase B shape)', () => {
    const p = buildCiphertextPayload(input())!;
    expect(p.data.act).toBeUndefined();
    expect(p.data.tv).toBeUndefined();
    expect(Object.keys(p.data).sort()).toEqual(['ct', 'epoch', 'messageId', 'topicId']);
  });

  it('hostile: a bad preview drops ONLY act/tv — never nulls the whole payload', () => {
    const bad = [
      { archiveCiphertextB64: '', takVersion: 1 },
      { archiveCiphertextB64: undefined as never, takVersion: 1 },
      { archiveCiphertextB64: 123 as never, takVersion: 1 },
      { archiveCiphertextB64: ACT, takVersion: -1 },
      { archiveCiphertextB64: ACT, takVersion: 1.5 },
      { archiveCiphertextB64: ACT, takVersion: NaN },
      { archiveCiphertextB64: ACT, takVersion: Number.MAX_VALUE },
      { archiveCiphertextB64: ACT, takVersion: '2' as never },
      { archiveCiphertextB64: ACT, takVersion: undefined },
      { archiveCiphertextB64: ACT }, // takVersion omitted entirely
    ];
    for (const o of bad) {
      const p = buildCiphertextPayload(input(o));
      expect(p).not.toBeNull();
      expect(p!.data.act).toBeUndefined();
      expect(p!.data.tv).toBeUndefined();
      expect(p!.data.ct).toBe('c2VhbGVkLW9wYXF1ZS1ieXRlcw=='); // the message still pushes
    }
  });

  it('boundary: a payload exactly at the cap is kept; one byte over sheds act/tv', () => {
    // Grow act until the payload is exactly PUSH_MAX_PAYLOAD_BYTES.
    const fit = (() => {
      let n = PUSH_MAX_PAYLOAD_BYTES - 300;
      for (;;) {
        const p = buildCiphertextPayload(input({ archiveCiphertextB64: 'A'.repeat(n), takVersion: 1 }))!;
        const size = Buffer.byteLength(JSON.stringify(p), 'utf8');
        if (size === PUSH_MAX_PAYLOAD_BYTES) return n;
        if (size > PUSH_MAX_PAYLOAD_BYTES) throw new Error('overshot the cap while sizing');
        n++;
      }
    })();
    const atCap = buildCiphertextPayload(input({ archiveCiphertextB64: 'A'.repeat(fit), takVersion: 1 }))!;
    expect(Buffer.byteLength(JSON.stringify(atCap), 'utf8')).toBe(PUSH_MAX_PAYLOAD_BYTES);
    expect(atCap.data.act).toBeDefined();

    // One byte over: act/tv are shed (they are the optional preview), and the
    // resulting ct-only payload is still within budget.
    const over = buildCiphertextPayload(input({ archiveCiphertextB64: 'A'.repeat(fit + 1), takVersion: 1 }))!;
    expect(over).not.toBeNull();
    expect(over.data.act).toBeUndefined();
    expect(over.data.tv).toBeUndefined();
    expect(Buffer.byteLength(JSON.stringify(over), 'utf8')).toBeLessThanOrEqual(PUSH_MAX_PAYLOAD_BYTES);
  });

  it('boundary: when even ct alone is over the cap it still returns null (dummy)', () => {
    const p = buildCiphertextPayload(
      input({
        sealedCiphertextB64: 'A'.repeat(PUSH_MAX_PAYLOAD_BYTES + 100),
        archiveCiphertextB64: 'B'.repeat(100),
        takVersion: 1,
      }),
    );
    expect(p).toBeNull();
  });
});

describe('dispatchCiphertextForMessage (fan-out + fallback)', () => {
  it('SI-1 + contract: sends the opaque ciphertext to members only (excl. sender + non-member)', async () => {
    await upsertToken(db, SENDER, 'h-sender', 'tok-sender', 'ios');
    await upsertToken(db, MEMBER_B, 'h-b', 'tok-b', 'ios');
    await upsertToken(db, MEMBER_C, 'h-c', 'tok-c', 'android');
    await upsertToken(db, NON_MEMBER, 'h-nm', 'tok-nm', 'ios');
    const provider = new CapturingProvider();

    await dispatchCiphertextForMessage(db, input(), provider);

    expect(provider.dummies).toHaveLength(0); // in-budget → ciphertext path only
    const tokens = provider.ciphertexts.map((c) => c.target.pushToken).sort();
    expect(tokens).toEqual(['tok-b', 'tok-c']); // not sender, not non-member
    for (const { payload } of provider.ciphertexts) {
      expect(payload.data.ct).toBe('c2VhbGVkLW9wYXF1ZS1ieXRlcw==');
      expect(payload.data.topicId).toBe(TOPIC);
      const flat = JSON.stringify(payload).toLowerCase();
      for (const forbidden of ['plaintext', 'sender', 'nickname']) {
        expect(flat.includes(forbidden)).toBe(false);
      }
    }
  });

  it('the TAK preview reaches every recipient device (act/tv), sender still excluded', async () => {
    await upsertToken(db, SENDER, 'h-sender', 'tok-sender', 'ios');
    await upsertToken(db, MEMBER_B, 'h-b', 'tok-b', 'ios');
    await upsertToken(db, MEMBER_C, 'h-c', 'tok-c', 'android');
    const provider = new CapturingProvider();

    await dispatchCiphertextForMessage(
      db,
      input({ archiveCiphertextB64: 'dGFrLXNlYWxlZC1wcmV2aWV3', takVersion: 4 }),
      provider,
    );

    expect(provider.dummies).toHaveLength(0);
    expect(provider.ciphertexts.map((c) => c.target.pushToken).sort()).toEqual(['tok-b', 'tok-c']);
    for (const { payload } of provider.ciphertexts) {
      expect(payload.data.act).toBe('dGFrLXNlYWxlZC1wcmV2aWV3');
      expect(payload.data.tv).toBe(4);
    }
  });

  it('a malformed TAK preview still dispatches the ciphertext push (no act/tv)', async () => {
    await upsertToken(db, MEMBER_B, 'h-b', 'tok-b', 'ios');
    const provider = new CapturingProvider();
    await dispatchCiphertextForMessage(db, input({ archiveCiphertextB64: '', takVersion: -3 }), provider);
    expect(provider.dummies).toHaveLength(0);
    expect(provider.ciphertexts).toHaveLength(1);
    expect(provider.ciphertexts[0].payload.data.act).toBeUndefined();
    expect(provider.ciphertexts[0].payload.data.ct).toBe('c2VhbGVkLW9wYXF1ZS1ieXRlcw==');
  });

  it('size-cap: an over-budget ciphertext falls back to the content-free dummy', async () => {
    await upsertToken(db, MEMBER_B, 'h-b', 'tok-b', 'ios');
    const provider = new CapturingProvider();
    const over = 'A'.repeat(PUSH_MAX_PAYLOAD_BYTES + 100);

    await dispatchCiphertextForMessage(db, input({ sealedCiphertextB64: over }), provider);

    expect(provider.ciphertexts).toHaveLength(0);
    expect(provider.dummies).toHaveLength(1);
    // The dummy carries zero content — exactly {title, body, data:{topicId}}.
    expect(Object.keys(provider.dummies[0].payload).sort()).toEqual(['body', 'data', 'title']);
    expect(Object.keys(provider.dummies[0].payload.data)).toEqual(['topicId']);
  });

  it('hostile: missing ct/epoch falls back to the content-free dummy', async () => {
    await upsertToken(db, MEMBER_B, 'h-b', 'tok-b', 'ios');
    const provider = new CapturingProvider();
    await dispatchCiphertextForMessage(db, input({ sealedCiphertextB64: '' }), provider);
    expect(provider.ciphertexts).toHaveLength(0);
    expect(provider.dummies).toHaveLength(1);
  });

  it('a provider without ciphertext support falls back to the content-free dummy', async () => {
    await upsertToken(db, MEMBER_B, 'h-b', 'tok-b', 'ios');
    const provider = new DummyOnlyProvider();
    await dispatchCiphertextForMessage(db, input(), provider);
    expect(provider.dummies).toHaveLength(1);
    expect(Object.keys(provider.dummies[0].payload.data)).toEqual(['topicId']);
  });

  it('graceful: null provider → no-op, never throws', async () => {
    await upsertToken(db, MEMBER_B, 'h-b', 'tok-b', 'ios');
    await expect(dispatchCiphertextForMessage(db, input(), null)).resolves.toBeUndefined();
  });

  it('empty: no other member with a token → no send', async () => {
    await upsertToken(db, SENDER, 'h-sender', 'tok-sender', 'ios'); // only the sender
    const provider = new CapturingProvider();
    await dispatchCiphertextForMessage(db, input(), provider);
    expect(provider.ciphertexts).toHaveLength(0);
    expect(provider.dummies).toHaveLength(0);
  });

  it('one failing device does not abort the fan-out', async () => {
    await upsertToken(db, MEMBER_B, 'h-b', 'tok-b', 'ios');
    await upsertToken(db, MEMBER_C, 'h-c', 'tok-c', 'android');
    let calls = 0;
    const flaky: PushProvider = {
      async send() {},
      async sendCiphertext(target) {
        calls++;
        if (target.pushToken === 'tok-b') throw new Error('APNs 400');
      },
    };
    await expect(dispatchCiphertextForMessage(db, input(), flaky)).resolves.toBeUndefined();
    expect(calls).toBe(2); // both attempted despite one throwing
  });
});
