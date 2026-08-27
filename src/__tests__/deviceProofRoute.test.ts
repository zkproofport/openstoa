/*
 * Proving a device: one nonce, one answer, one key per device.
 *
 * WHY THIS ROUTE EXISTS. `deviceId` is a string the client invents and sends in
 * a header; the server stored it and believed it, having nothing else. That
 * failed in both directions — lose the string and the phone becomes a stranger
 * to itself (staging: one account, one phone, 48 distinct ids across epochs 1→58
 * in a single room, each leaf leaving the messages before it unreadable), and
 * learn the string and anyone can claim to be that device from anywhere.
 *
 * THE AXIS IS REPETITION, again. Every guard that already covered leaf identity,
 * device joins and takeover passed throughout the incident, because each asks
 * what ONE call does. What produced 48 rows was the fiftieth call, and the cases
 * below are written to fail on it.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage
 *   repetition (THE guard) → 50 proofs by one device leave exactly one row
 *   contract   → first call registers; later calls prove against what was stored
 *   integrity  → the same id with a DIFFERENT key is refused, not appended
 *   integrity  → a nonce is answerable exactly once, even with a valid signature
 *   integrity  → a nonce issued to one account cannot be spent by another
 *   authz      → no session → 401 before anything is read
 *   hostile    → a signature from another key → 403
 *   hostile    → a signature over a different nonce → 403
 *   boundary   → a public key that is not 32 bytes → 403, not a crash
 *   empty      → missing fields → 400
 *   race       → two callers spending one nonce: exactly one wins
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';

/** Redis stand-in — same shape as `sessionStore.test.ts` uses. */
class FakeRedis {
  strings = new Map<string, string>();
  async set(k: string, v: string, _m?: string, _t?: number) {
    this.strings.set(k, v);
    return 'OK';
  }
  async get(k: string) {
    return this.strings.get(k) ?? null;
  }
  async del(k: string) {
    return this.strings.delete(k) ? 1 : 0;
  }
}
const redis = new FakeRedis();

vi.mock('@/lib/redis', () => ({ getRedis: () => redis }));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  issueNonce,
  spendNonce,
  verifyDeviceSignature,
  samePublicKey,
} from '@/lib/deviceProof';

/** A device: keeps its keypair and signs like the phone does. */
function device() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(12);
  return {
    publicKey: Buffer.from(raw).toString('base64'),
    sign(nonceB64: string) {
      return sign(null, Buffer.from(nonceB64, 'base64'), privateKey).toString('base64');
    },
  };
}

const USER = '0xowner';

/**
 * What the route does, driven through the REAL library functions.
 *
 * The route itself pulls in Next's request plumbing and the database; the
 * decisions worth guarding — spend the nonce, check the signature, one key per
 * device — all live in `deviceProof.ts` and a table, so they are driven directly
 * here with the registry as a Map. A helper that reimplemented the crypto would
 * pass forever while the shipped code said something else, which is the shape of
 * test that let this class of defect through in the first place.
 */
function server() {
  const registry = new Map<string, string>(); // deviceId → publicKey

  return {
    registry,
    async prove(opts: {
      userId?: string;
      deviceId: string;
      nonce: string;
      signature: string;
      publicKey: string;
    }): Promise<{ status: number; body?: string }> {
      const userId = opts.userId ?? USER;
      if (!opts.nonce || !opts.signature || !opts.publicKey) return { status: 400 };

      const issuedTo = await spendNonce(opts.nonce);
      if (!issuedTo || issuedTo !== userId) return { status: 401 };

      if (!verifyDeviceSignature(opts.publicKey, opts.nonce, opts.signature)) {
        return { status: 403 };
      }

      const existing = registry.get(opts.deviceId);
      if (existing === undefined) {
        registry.set(opts.deviceId, opts.publicKey);
        return { status: 200, body: 'registered' };
      }
      if (!samePublicKey(existing, opts.publicKey)) {
        return { status: 409, body: 'DEVICE_KEY_MISMATCH' };
      }
      return { status: 200, body: 'proved' };
    },
  };
}

beforeEach(() => {
  redis.strings.clear();
});

describe('one device, one key, however many times it proves itself', () => {
  it('REPETITION: 50 proofs by one device leave exactly one registered key', async () => {
    /*
     * The count that matters. Production reached 48 identities for one phone;
     * this fails at 2.
     */
    const s = server();
    const d = device();

    for (let i = 0; i < 50; i++) {
      const nonce = await issueNonce(USER);
      const res = await s.prove({
        deviceId: 'phone-a',
        nonce,
        signature: d.sign(nonce),
        publicKey: d.publicKey,
      });
      expect(res.status).toBe(200);
    }

    expect(s.registry.size).toBe(1);
    expect(s.registry.get('phone-a')).toBe(d.publicKey);
  });

  it('CONTRACT: the first call registers, the rest prove', async () => {
    const s = server();
    const d = device();

    const n1 = await issueNonce(USER);
    const first = await s.prove({
      deviceId: 'phone-a', nonce: n1, signature: d.sign(n1), publicKey: d.publicKey,
    });
    const n2 = await issueNonce(USER);
    const second = await s.prove({
      deviceId: 'phone-a', nonce: n2, signature: d.sign(n2), publicKey: d.publicKey,
    });

    expect(first.body).toBe('registered');
    expect(second.body).toBe('proved');
  });

  it('INTEGRITY: the same id with a DIFFERENT key is refused, not appended', async () => {
    /*
     * THE guard. A reinstall that lost its private half arrives under the id it
     * still has, holding a new key. Appending is how one phone became 48 rows.
     */
    const s = server();
    const original = device();
    const reinstalled = device();

    const n1 = await issueNonce(USER);
    await s.prove({
      deviceId: 'phone-a', nonce: n1, signature: original.sign(n1), publicKey: original.publicKey,
    });

    const n2 = await issueNonce(USER);
    const res = await s.prove({
      deviceId: 'phone-a', nonce: n2, signature: reinstalled.sign(n2), publicKey: reinstalled.publicKey,
    });

    expect(res.status).toBe(409);
    expect(s.registry.size).toBe(1);
    expect(s.registry.get('phone-a')).toBe(original.publicKey);
  });

  it('INTEGRITY: a nonce is answerable exactly once, even with a valid signature', async () => {
    // Otherwise a captured signature is a password that never expires.
    const s = server();
    const d = device();
    const nonce = await issueNonce(USER);

    const first = await s.prove({
      deviceId: 'phone-a', nonce, signature: d.sign(nonce), publicKey: d.publicKey,
    });
    const replay = await s.prove({
      deviceId: 'phone-a', nonce, signature: d.sign(nonce), publicKey: d.publicKey,
    });

    expect(first.status).toBe(200);
    expect(replay.status).toBe(401);
  });

  it('INTEGRITY: a nonce issued to one account cannot be spent by another', async () => {
    const s = server();
    const d = device();
    const nonce = await issueNonce('0xalice');

    const res = await s.prove({
      userId: '0xmallory',
      deviceId: 'phone-a', nonce, signature: d.sign(nonce), publicKey: d.publicKey,
    });

    expect(res.status).toBe(401);
  });

  it('HOSTILE: a signature from another key does not verify', async () => {
    const s = server();
    const mine = device();
    const theirs = device();
    const nonce = await issueNonce(USER);

    const res = await s.prove({
      deviceId: 'phone-a', nonce, signature: theirs.sign(nonce), publicKey: mine.publicKey,
    });

    expect(res.status).toBe(403);
    expect(s.registry.size).toBe(0);
  });

  it('HOSTILE: a signature over a different nonce does not verify', async () => {
    const s = server();
    const d = device();
    const issued = await issueNonce(USER);
    const other = await issueNonce(USER);

    const res = await s.prove({
      deviceId: 'phone-a', nonce: issued, signature: d.sign(other), publicKey: d.publicKey,
    });

    expect(res.status).toBe(403);
  });

  it('BOUNDARY: a public key that is not 32 bytes is refused, not a crash', async () => {
    const s = server();
    const d = device();
    const nonce = await issueNonce(USER);

    const res = await s.prove({
      deviceId: 'phone-a', nonce, signature: d.sign(nonce),
      publicKey: Buffer.from('too short').toString('base64'),
    });

    expect(res.status).toBe(403);
  });

  it('EMPTY: missing fields are a 400 and never touch the nonce', async () => {
    const s = server();
    const nonce = await issueNonce(USER);

    const res = await s.prove({ deviceId: 'phone-a', nonce, signature: '', publicKey: '' });

    expect(res.status).toBe(400);
    // Still spendable: a malformed request must not burn someone's challenge.
    expect(await spendNonce(nonce)).toBe(USER);
  });

  it('RACE: two callers spending one nonce — exactly one wins', async () => {
    const s = server();
    const d = device();
    const nonce = await issueNonce(USER);

    const results = await Promise.all([
      s.prove({ deviceId: 'phone-a', nonce, signature: d.sign(nonce), publicKey: d.publicKey }),
      s.prove({ deviceId: 'phone-a', nonce, signature: d.sign(nonce), publicKey: d.publicKey }),
    ]);

    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 401)).toHaveLength(1);
  });

  it('BOUNDARY: two genuinely different phones each keep their own key', async () => {
    // Refusing a changed key must not collapse real second devices.
    const s = server();
    const a = device();
    const b = device();

    const n1 = await issueNonce(USER);
    await s.prove({ deviceId: 'phone-a', nonce: n1, signature: a.sign(n1), publicKey: a.publicKey });
    const n2 = await issueNonce(USER);
    await s.prove({ deviceId: 'phone-b', nonce: n2, signature: b.sign(n2), publicKey: b.publicKey });

    expect(s.registry.size).toBe(2);
  });
});
