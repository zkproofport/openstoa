/**
 * P-Q push preview (design §13.6 strategy A) — the client half.
 *
 * The iOS Notification Service Extension may NOT decrypt the live MLS ciphertext:
 * that consumes a forward-secret ratchet key and desyncs the app. It decrypts a
 * copy sealed under the topic's TAK instead — a stable key, so opening it costs
 * nothing. These tests pin the exact bytes/JSON contract the extension has to
 * reimplement in Swift:
 *
 *   pushArchive.ct = base64(nonce ‖ AEAD(HKDF(TAK, "openstoa-archive/v1:push-preview"), body))
 *   pushArchive.takVersion = 0 for a public topic (archive root), else the MLS epoch
 *   Keychain value       = base64 of the 32 raw TAK bytes (sealForPush().takB64)
 *
 * Covered matrix rows: integrity (round-trip + verbatim key), boundary (empty /
 * very large body), UTF-8 (Korean + emoji + control chars), hostile (wrong key,
 * wrong context, tampered blob), race (two seals never reuse a nonce), and
 * graceful degradation (a broken MLS state yields null, never a throw).
 */
import { describe, it, expect } from 'vitest';
import { MlsSessionStore, type MlsTransport, type CommitLogEntry, type SecureKVStore } from '@/lib/mls/mlsSession';
import { TakSessionStore, type TakTransport, type TakBundleRow, type ArchiveEntry } from '@/lib/mls/takSession';
import { openPushPreview, openArchive, PUSH_PREVIEW_CONTEXT_ID } from '@/lib/mls/takClient';
import { parseCommitFraming } from '@/lib/mls/framing';

const unb64 = (s: string) => {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

class MemoryDS implements MlsTransport {
  groups = new Map<string, { groupInfo: string; epoch: number; groupId: string }>();
  commits = new Map<string, CommitLogEntry[]>();
  async getGroupInfo(t: string) {
    return this.groups.get(t)?.groupInfo ?? null;
  }
  async postGroupInfo(t: string, gi: string, gid: string) {
    if (this.groups.has(t)) return false;
    this.groups.set(t, { groupInfo: gi, epoch: 0, groupId: gid });
    this.commits.set(t, []);
    return true;
  }
  async postCommit(t: string, commitB64: string, giB64: string) {
    const g = this.groups.get(t);
    if (!g) return { ok: false };
    const framing = parseCommitFraming(unb64(commitB64));
    if (framing.epoch !== g.epoch) return { ok: false };
    g.epoch = framing.epoch + 1;
    g.groupInfo = giB64;
    this.commits.get(t)!.push({ epoch: g.epoch, commit: commitB64, welcome: null });
    return { ok: true, epoch: g.epoch };
  }
  async getCommitsSince(t: string, since: number) {
    return (this.commits.get(t) ?? []).filter((c) => c.epoch > since);
  }
}

class MemoryTak implements TakTransport {
  archive = new Map<string, ArchiveEntry[]>();
  async postArchive(t: string, messageId: string, takVersion: number, ciphertext: string) {
    const list = this.archive.get(t) ?? [];
    list.push({ messageId, takVersion, ciphertext, createdAt: new Date().toISOString() });
    this.archive.set(t, list);
  }
  async getArchive(t: string) {
    return this.archive.get(t) ?? [];
  }
  async postBundle() {}
  async getBundles(): Promise<TakBundleRow[]> {
    return [];
  }
  async ackBundles() {}
  fingerprints = new Map<string, string>();
  async getServerRoot(): Promise<Uint8Array | null> {
    return null;
  }
  async putServerRoot(): Promise<boolean> {
    return true;
  }
  async getRootFingerprint(t: string) {
    return { fingerprint: this.fingerprints.get(t) ?? null, archiveCount: (this.archive.get(t) ?? []).length };
  }
  async setRootFingerprint(t: string, fingerprint: string) {
    const cur = this.fingerprints.get(t);
    if (cur === undefined) {
      this.fingerprints.set(t, fingerprint);
      return { fingerprint, claimed: true };
    }
    return { fingerprint: cur, claimed: cur === fingerprint };
  }
}

function memKv(): SecureKVStore {
  const m = new Map<string, string>();
  return { get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, v) };
}

function makeClient(ds: MemoryDS, tt: MemoryTak, identity: string) {
  const kv = memKv();
  const mls = new MlsSessionStore(ds, identity, kv);
  const tak = new TakSessionStore(mls, tt, kv);
  return { mls, tak };
}

describe('sealForPush — public topic (archive root, tak_version 0)', () => {
  it('integrity: the NSE contract round-trips with only the Keychain value', async () => {
    const alice = makeClient(new MemoryDS(), new MemoryTak(), 'alice');
    const seal = await alice.tak.sealForPush('pub-1', 'hello preview', 'public');
    expect(seal).not.toBeNull();
    expect(seal!.takVersion).toBe(0); // public → the shared archive root
    // takB64 is exactly the 32 raw TAK bytes the extension reads from the Keychain,
    // and that value alone must be enough to recover the body.
    const key = unb64(seal!.takB64);
    expect(key.length).toBe(32);
    expect(await openPushPreview(key, seal!.ct)).toBe('hello preview');
  });

  it('the same root is reused across sends (a cached Keychain item stays valid)', async () => {
    const alice = makeClient(new MemoryDS(), new MemoryTak(), 'alice');
    const a = await alice.tak.sealForPush('pub-2', 'first', 'public');
    const b = await alice.tak.sealForPush('pub-2', 'second', 'public');
    expect(a!.takB64).toBe(b!.takB64);
    expect(await openPushPreview(unb64(a!.takB64), b!.ct)).toBe('second');
  });

  it('race/nonce: two seals of the SAME body produce different ciphertexts', async () => {
    const alice = makeClient(new MemoryDS(), new MemoryTak(), 'alice');
    const a = await alice.tak.sealForPush('pub-3', 'same body', 'public');
    const b = await alice.tak.sealForPush('pub-3', 'same body', 'public');
    expect(a!.ct).not.toBe(b!.ct); // fresh random nonce per seal
    expect(await openPushPreview(unb64(a!.takB64), a!.ct)).toBe('same body');
    expect(await openPushPreview(unb64(b!.takB64), b!.ct)).toBe('same body');
  });

  it('another member handed the archive root can open a preview it never sent', async () => {
    const ds = new MemoryDS();
    const tt = new MemoryTak();
    const alice = makeClient(ds, tt, 'alice');
    const seal = await alice.tak.sealForPush('pub-4', 'from alice', 'public');
    // Bob's device: it holds the root (delivered by the normal TAK bundle flow)
    // and nothing else — exactly the NSE's position.
    expect(await openPushPreview(unb64(seal!.takB64), seal!.ct)).toBe('from alice');
  });
});

describe('sealForPush — scoped topic (per-epoch TAK, tak_version = epoch)', () => {
  it('private: takVersion is the live MLS epoch and the key opens the preview', async () => {
    const ds = new MemoryDS();
    const tt = new MemoryTak();
    const alice = makeClient(ds, tt, 'sc-alice');
    await alice.mls.seal('sc-1', 'bootstrap'); // creates the group at epoch 0
    const seal = await alice.tak.sealForPush('sc-1', 'private preview', 'private');
    expect(seal!.takVersion).toBe(0); // epoch 0
    expect(await openPushPreview(unb64(seal!.takB64), seal!.ct)).toBe('private preview');
  });

  it('secret behaves like private (scoped tier, not the public root)', async () => {
    const ds = new MemoryDS();
    const tt = new MemoryTak();
    const alice = makeClient(ds, tt, 'sc-bob');
    await alice.mls.seal('sc-2', 'bootstrap');
    const scoped = await alice.tak.sealForPush('sc-2', 'x', 'secret');
    const pub = await alice.tak.sealForPush('sc-2', 'x', 'public');
    // A scoped topic must NOT be sealed under the public archive root.
    expect(scoped!.takB64).not.toBe(pub!.takB64);
  });

  it('the epoch TAK is cached, so archiveOnSend under the same epoch matches', async () => {
    const ds = new MemoryDS();
    const tt = new MemoryTak();
    const alice = makeClient(ds, tt, 'sc-carol');
    await alice.mls.seal('sc-3', 'bootstrap');
    const seal = await alice.tak.sealForPush('sc-3', 'body', 'private');
    await alice.tak.archiveOnSend('sc-3', 'msg-1', 'body', 'private');
    const [row] = await tt.getArchive('sc-3');
    expect(row.takVersion).toBe(seal!.takVersion); // same key version for both copies
    // ...and that same key opens the archived copy under the MESSAGE-ID context.
    expect(await openArchive(unb64(seal!.takB64), 'msg-1', row.ciphertext)).toBe('body');
  });
});

describe('takForPush — the receive-side keychain mirror', () => {
  it('returns the SAME key/version a sender would seal with', async () => {
    const alice = makeClient(new MemoryDS(), new MemoryTak(), 'r-1');
    const seal = await alice.tak.sealForPush('r-t1', 'body', 'public');
    const ref = await alice.tak.takForPush('r-t1', 'public');
    expect(ref).not.toBeNull();
    expect(ref!.takB64).toBe(seal!.takB64);
    expect(ref!.takVersion).toBe(seal!.takVersion);
    // A reader that only mirrored the key can still open a preview it received.
    expect(await openPushPreview(unb64(ref!.takB64), seal!.ct)).toBe('body');
  });

  it('scoped topics report the live epoch as the version', async () => {
    const ds = new MemoryDS();
    const alice = makeClient(ds, new MemoryTak(), 'r-2');
    await alice.mls.seal('r-t2', 'bootstrap');
    const ref = await alice.tak.takForPush('r-t2', 'private');
    expect(ref!.takVersion).toBe(0);
    expect(unb64(ref!.takB64).length).toBe(32);
  });

  it('returns null (nothing to mirror) instead of throwing when state is missing', async () => {
    const brokenMls = {
      readState: async () => {
        throw new Error('no local group state');
      },
      // Registered by the store's constructor: it takes the per-epoch key for
      // every epoch the device passes through. A fake without it cannot
      // construct, and this fake is deliberately broken elsewhere.
      setEpochListener: () => {},
    } as unknown as MlsSessionStore;
    const tak = new TakSessionStore(brokenMls, new MemoryTak(), memKv());
    await expect(tak.takForPush('missing', 'private')).resolves.toBeNull();
  });
});

describe('sealForPush — hostile input and degradation', () => {
  it('context binding: the preview does NOT open under a message-id context', async () => {
    const alice = makeClient(new MemoryDS(), new MemoryTak(), 'h-1');
    const seal = await alice.tak.sealForPush('h-t1', 'bound', 'public');
    const key = unb64(seal!.takB64);
    expect(await openArchive(key, 'some-message-id', seal!.ct)).toBeNull();
    // Only the documented constant context works.
    expect(await openArchive(key, PUSH_PREVIEW_CONTEXT_ID, seal!.ct)).toBe('bound');
  });

  it('a wrong key or a tampered blob decrypts to null, never throws', async () => {
    const alice = makeClient(new MemoryDS(), new MemoryTak(), 'h-2');
    const seal = await alice.tak.sealForPush('h-t2', 'secret body', 'public');
    expect(await openPushPreview(new Uint8Array(32), seal!.ct)).toBeNull(); // wrong key
    const key = unb64(seal!.takB64);
    const flipped = seal!.ct.slice(0, -8) + (seal!.ct.slice(-8) === 'AAAAAAAA' ? 'BBBBBBBB' : 'AAAAAAAA');
    expect(await openPushPreview(key, flipped)).toBeNull(); // tampered
    expect(await openPushPreview(key, '')).toBeNull(); // empty
    expect(await openPushPreview(key, 'not base64!!')).toBeNull(); // garbage
  });

  it('boundary: empty and very large bodies both round-trip', async () => {
    const alice = makeClient(new MemoryDS(), new MemoryTak(), 'h-3');
    const empty = await alice.tak.sealForPush('h-t3', '', 'public');
    expect(await openPushPreview(unb64(empty!.takB64), empty!.ct)).toBe('');
    const big = 'x'.repeat(64 * 1024);
    const large = await alice.tak.sealForPush('h-t3', big, 'public');
    expect(await openPushPreview(unb64(large!.takB64), large!.ct)).toBe(big);
  });

  it('UTF-8: Korean, emoji, and control characters survive verbatim', async () => {
    const alice = makeClient(new MemoryDS(), new MemoryTak(), 'h-4');
    for (const body of ['회의 3시에 시작합니다', '🌟🎉 emoji 섞임 🇰🇷', 'tab\tnewline\nnull-ish end']) {
      const seal = await alice.tak.sealForPush('h-t4', body, 'public');
      expect(await openPushPreview(unb64(seal!.takB64), seal!.ct)).toBe(body);
    }
  });

  it('graceful: a broken MLS state yields null (sending must never break)', async () => {
    const kv = memKv();
    const brokenMls = {
      readState: async () => {
        throw new Error('no local group state');
      },
      // Registered by the store's constructor: it takes the per-epoch key for
      // every epoch the device passes through. A fake without it cannot
      // construct, and this fake is deliberately broken elsewhere.
      setEpochListener: () => {},
    } as unknown as MlsSessionStore;
    const tak = new TakSessionStore(brokenMls, new MemoryTak(), kv);
    await expect(tak.sealForPush('missing', 'body', 'private')).resolves.toBeNull();
  });

  it('graceful: a failing key store yields null rather than throwing', async () => {
    const badKv: SecureKVStore = {
      get: async () => {
        throw new Error('keychain unavailable');
      },
      set: async () => {},
    };
    const ds = new MemoryDS();
    const tak = new TakSessionStore(new MlsSessionStore(ds, 'g-1', memKv()), new MemoryTak(), badKv);
    await expect(tak.sealForPush('pub-broken', 'body', 'public')).resolves.toBeNull();
  });
});
