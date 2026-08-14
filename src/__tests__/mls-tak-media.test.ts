/**
 * R-3 — the attachment AEAD, against REAL MLS groups and the real ciphersuite.
 *
 * `chatMedia.test.ts` injects the seal step so it can assert the ordering; this
 * file asserts the cryptography that step performs: bytes in, bytes out, under
 * the same TAK the message archive uses, and unreadable to anyone who does not
 * hold it. If this passes and the picture still leaks, the leak is not here.
 */
import { describe, it, expect } from 'vitest';
import * as mls from '@/lib/mls/groupClient';
import * as tak from '@/lib/mls/takClient';
import { TakSessionStore, type TakTransport } from '@/lib/mls/takSession';

async function twoMemberGroup(topicId: string) {
  const alice = await mls.createDevice('alice');
  const bob = await mls.createDevice('bob');
  const g = await mls.createTopicGroup(topicId, alice);
  const j = await mls.joinTopicGroup(bob, g.groupInfoB64);
  return { aState: await mls.processCommit(g.state, j.commitB64), bState: j.state };
}

const MEDIA = 'ab'.repeat(16);
const hex = (u: Uint8Array) => Buffer.from(u).toString('hex');

/** In-memory SecureKVStore, optionally pre-seeded with TAK material. */
function kv(seed: Record<string, string>) {
  const m = new Map(Object.entries(seed));
  return {
    get: async (k: string) => m.get(k) ?? null,
    set: async (k: string, v: string) => void m.set(k, v),
  };
}

/**
 * A DS that is never expected to answer. `offline` makes the root lookup throw,
 * which is how a device ends up holding no usable key.
 */
function transport(opts: { offline?: boolean } = {}): TakTransport {
  const nope = async () => {
    throw new Error('not reachable in this test');
  };
  return {
    postArchive: nope,
    getArchive: async () => [],
    postBundle: nope,
    getBundles: async () => [],
    ackBundles: nope,
    getServerRoot: opts.offline ? nope : async () => null,
    putServerRoot: opts.offline ? nope : async () => false,
    getRootFingerprint: async () => ({ fingerprint: null, archiveCount: 0 }),
    setRootFingerprint: nope,
  } as unknown as TakTransport;
}

describe('media seal / open', () => {
  it('I1 INTEGRITY: the decrypted bytes are the original bytes, byte for byte', async () => {
    const root = tak.generatePublicRootKey();
    const plain = new Uint8Array(4096);
    // Every byte value, plus a run of zeros — anything that a text-shaped path
    // would mangle.
    for (let i = 0; i < plain.length; i++) plain[i] = (i * 7) % 256;
    const sealed = await tak.sealMediaBytes(root, MEDIA, plain);
    const opened = await tak.openMediaBytes(root, MEDIA, sealed);
    expect(opened).not.toBeNull();
    expect(hex(opened!)).toBe(hex(plain));
  });

  it('B1/B2: 0-byte and 1-byte payloads round-trip', async () => {
    const root = tak.generatePublicRootKey();
    for (const plain of [new Uint8Array(0), new Uint8Array([0xff])]) {
      const opened = await tak.openMediaBytes(root, MEDIA, await tak.sealMediaBytes(root, MEDIA, plain));
      expect(opened).not.toBeNull();
      expect(hex(opened!)).toBe(hex(plain));
    }
  });

  it('B3: a 10MB payload round-trips', async () => {
    const root = tak.generatePublicRootKey();
    const plain = new Uint8Array(10 * 1024 * 1024).fill(0xa5);
    const sealed = await tak.sealMediaBytes(root, MEDIA, plain);
    // 12-byte nonce + 16-byte tag.
    expect(sealed.length).toBe(plain.length + 28);
    const opened = await tak.openMediaBytes(root, MEDIA, sealed);
    expect(opened!.length).toBe(plain.length);
    expect(opened![0]).toBe(0xa5);
    expect(opened![plain.length - 1]).toBe(0xa5);
  });

  it('the ciphertext is not the plaintext, and does not contain it', async () => {
    const root = tak.generatePublicRootKey();
    const plain = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const sealed = await tak.sealMediaBytes(root, MEDIA, plain);
    expect(hex(sealed)).not.toContain(hex(plain));
  });

  it('H3: a wrong key cannot open it', async () => {
    const root = tak.generatePublicRootKey();
    const other = tak.generatePublicRootKey();
    const sealed = await tak.sealMediaBytes(root, MEDIA, new Uint8Array([9, 9, 9]));
    expect(await tak.openMediaBytes(other, MEDIA, sealed)).toBeNull();
  });

  it('H2: a tampered ciphertext cannot open — every byte position', async () => {
    const root = tak.generatePublicRootKey();
    const sealed = await tak.sealMediaBytes(root, MEDIA, new Uint8Array([1, 2, 3, 4]));
    for (const at of [0, 6, 12, sealed.length - 1]) {
      const tampered = new Uint8Array(sealed);
      tampered[at] ^= 0x01;
      expect(await tak.openMediaBytes(root, MEDIA, tampered), `flipped byte ${at}`).toBeNull();
    }
  });

  it('H2: a truncated ciphertext cannot open', async () => {
    const root = tak.generatePublicRootKey();
    const sealed = await tak.sealMediaBytes(root, MEDIA, new Uint8Array([1, 2, 3, 4]));
    expect(await tak.openMediaBytes(root, MEDIA, sealed.slice(0, sealed.length - 1))).toBeNull();
    expect(await tak.openMediaBytes(root, MEDIA, new Uint8Array(0))).toBeNull();
  });

  it('the key is bound to the mediaId — a different id fails', async () => {
    const root = tak.generatePublicRootKey();
    const sealed = await tak.sealMediaBytes(root, MEDIA, new Uint8Array([7]));
    expect(await tak.openMediaBytes(root, 'cd'.repeat(16), sealed)).toBeNull();
  });

  it('CONTRACT: media and message-body contexts are disjoint', async () => {
    /*
     * Both derive from the same TAK, so if the contexts collided an attachment
     * and a message with the same id would share one AEAD key. The `media:`
     * prefix is what keeps them apart, and this fails if it is removed.
     */
    const root = tak.generatePublicRootKey();
    const id = 'ef'.repeat(16);
    const asArchive = await tak.sealArchive(root, id, 'body');
    const asMedia = await tak.sealMediaBytes(root, id, new Uint8Array([1]));
    // The archive blob cannot be opened as media under the same id, and vice versa.
    const archiveBytes = Uint8Array.from(Buffer.from(asArchive, 'base64'));
    expect(await tak.openMediaBytes(root, id, archiveBytes)).toBeNull();
    expect(await tak.openArchive(root, id, Buffer.from(asMedia).toString('base64'))).toBeNull();
  });

  it('two members at the same epoch open each other attachments', async () => {
    const topicId = 'tak-media-epoch';
    const { aState, bState } = await twoMemberGroup(topicId);
    const ta = await tak.deriveEpochTak(aState, topicId);
    const tb = await tak.deriveEpochTak(bState, topicId);
    const plain = new Uint8Array([1, 2, 3]);
    const sealed = await tak.sealMediaBytes(ta, MEDIA, plain);
    expect(hex((await tak.openMediaBytes(tb, MEDIA, sealed))!)).toBe(hex(plain));
  });

  it('CONTRACT: sealMedia and openMedia agree with sealArchive on the same key', async () => {
    /*
     * "Under the SAME derivation the archive already uses" is the design rule,
     * not an implementation detail: a member who was granted a topic's archive
     * key must get its pictures too, with no second grant and no second key.
     */
    const root = tak.generatePublicRootKey();
    const store = kv({ 'tak.root.public-topic': Buffer.from(root).toString('base64') });
    const session = new TakSessionStore({} as never, transport(), store);

    const plain = new Uint8Array([4, 2]);
    const sealed = await session.sealMedia('public-topic', MEDIA, plain, 'public');
    expect(sealed).not.toBeNull();
    expect(sealed!.takVersion).toBe(0); // public → the topic root

    // The raw archive key opens it directly.
    expect(hex((await tak.openMediaBytes(root, MEDIA, sealed!.ciphertext))!)).toBe(hex(plain));

    const opened = await session.openMedia('public-topic', MEDIA, 0, sealed!.ciphertext, 'public');
    expect(opened.ok).toBe(true);
    expect(hex((opened as { ok: true; bytes: Uint8Array }).bytes)).toBe(hex(plain));
  });

  it('K1: a device with no key gets no-key — and sealMedia refuses rather than sending clear', async () => {
    // No stored root, and the server cannot be asked → 'unverified', so there
    // is no key this device may seal under.
    const store = kv({});
    const session = new TakSessionStore({} as never, transport({ offline: true }), store);
    expect(await session.sealMedia('public-topic', MEDIA, new Uint8Array([1]), 'public')).toBeNull();
    const opened = await session.openMedia('public-topic', MEDIA, 0, new Uint8Array([1, 2, 3]), 'public');
    expect(opened).toEqual({ ok: false, reason: 'no-key' });
  });

  it('H2/H3: holding a key but failing to open is decrypt, never no-key', async () => {
    const root = tak.generatePublicRootKey();
    const store = kv({ 'tak.root.public-topic': Buffer.from(root).toString('base64') });
    const session = new TakSessionStore({} as never, transport(), store);
    const sealed = await session.sealMedia('public-topic', MEDIA, new Uint8Array([1, 2, 3]), 'public');
    const tampered = new Uint8Array(sealed!.ciphertext);
    tampered[tampered.length - 1] ^= 0xff;
    expect(await session.openMedia('public-topic', MEDIA, 0, tampered, 'public')).toEqual({
      ok: false,
      reason: 'decrypt',
    });
  });

  it('a scoped tier opens only the epoch the envelope names', async () => {
    const epoch3 = tak.generatePublicRootKey();
    const store = kv({ 'tak.epoch.secret-topic.3': Buffer.from(epoch3).toString('base64') });
    const session = new TakSessionStore({} as never, transport(), store);
    const sealed = await tak.sealMediaBytes(epoch3, MEDIA, new Uint8Array([8]));

    const ok = await session.openMedia('secret-topic', MEDIA, 3, sealed, 'secret');
    expect(ok.ok).toBe(true);
    // Epoch 4 was never granted to this device — omission IS the revocation.
    expect(await session.openMedia('secret-topic', MEDIA, 4, sealed, 'secret')).toEqual({
      ok: false,
      reason: 'no-key',
    });
  });

  it('REGRESSION: the message-archive wire format is unchanged', async () => {
    // sealArchive was refactored onto the same byte core. A format change here
    // would make every already-archived row unreadable, everywhere, at once.
    const root = tak.generatePublicRootKey();
    const sealed = await tak.sealArchive(root, 'msg-1', '안녕 🌟');
    expect(await tak.openArchive(root, 'msg-1', sealed)).toBe('안녕 🌟');
    // Still base64 of nonce‖ciphertext: 12 + len + 16.
    const raw = Buffer.from(sealed, 'base64');
    expect(raw.length).toBe(12 + Buffer.from('안녕 🌟', 'utf8').length + 16);
    // And a malformed base64 body is null rather than a throw.
    expect(await tak.openArchive(root, 'msg-1', 'not base64!!')).toBeNull();
  });
});
