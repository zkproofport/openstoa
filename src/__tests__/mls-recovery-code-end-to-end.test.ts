/**
 * The recovery code actually recovers a real message. End to end, no fakes in
 * the middle.
 *
 * WHY THIS FILE EXISTS. The recovery plumbing was covered in two halves that
 * never met:
 *
 *   mls-key-manager.test.ts:102   code → master_key            ✔
 *   mls-key-manager.test.ts:81    master_key → TAK keychain    ✔ — but the
 *                                 "keychain" is {'tak.root.topicA': 'cm9vdA=='},
 *                                 the word "root" in base64. Not a key.
 *   nothing                       TAK key → an actual message  ✘
 *
 * Each half passes against a synthetic value handed to it, so both could pass
 * while the join between them was broken and nobody would learn it from a green
 * suite. What the sheet promises the person is the WHOLE chain: keep this code
 * and your messages come back. This file is that sentence, executed.
 *
 * The user asked for it in exactly those terms — "복구 키로 복호화 온전히 되는
 * 거 테스트는 되었어? 그게 되어야 복구 가능하다고 문구를 넣을 수 있는 건데" —
 * and they were right that it had not been.
 *
 * NOTHING IS STUBBED between the code and the plaintext: real MLS, real TAK
 * sealing, real AES-GCM, real key wrapping. Only the transport is in memory,
 * and it stores opaque bytes exactly as the server does.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage
 *   contract   → sealed → lost → recovered → the SAME words come back
 *   integrity  → the wiped device reads nothing BEFORE the code is used, so the
 *                pass is attributable to recovery and not to a device that
 *                could read all along
 *   hostile    → a different code of the same shape recovers nothing
 *   boundary   → the keychain step is load-bearing: master_key alone is not
 *                enough, which is what makes the server backup necessary
 *   累積       → 12 messages archived across two epochs all return, not just
 *                the first — a keychain that restored one root would pass a
 *                single-message test
 *   idempotent → recovering twice on the same device is not destructive
 */
import { describe, it, expect } from 'vitest';
import * as km from '@/lib/mls/keyManager';
import * as kb from '@/lib/mls/keyBackup';
import { MlsSessionStore, type MlsTransport, type CommitLogEntry, type SecureKVStore } from '@/lib/mls/mlsSession';
import { TakSessionStore, type TakTransport, type TakBundleRow, type ArchiveEntry } from '@/lib/mls/takSession';
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

interface StoredBundle extends TakBundleRow {
  recipientUserId: string;
  recipientDeviceId: string;
  delivered: boolean;
}

class MemoryTak implements TakTransport {
  archive = new Map<string, ArchiveEntry[]>();
  bundles = new Map<string, StoredBundle[]>();
  private seq = 0;
  private next() {
    return String(this.seq++).padStart(6, '0');
  }
  async postArchive(t: string, messageId: string, takVersion: number, ciphertext: string) {
    const list = this.archive.get(t) ?? [];
    if (list.some((r) => r.messageId === messageId)) return;
    list.push({ messageId, takVersion, ciphertext, createdAt: new Date().toISOString() });
    this.archive.set(t, list);
  }
  async getArchive(t: string) {
    return [...(this.archive.get(t) ?? [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  async postBundle(t: string, recipientUserId: string, recipientDeviceId: string, bundle: string, scope: string) {
    const list = this.bundles.get(t) ?? [];
    if (list.some((b) => b.recipientDeviceId === recipientDeviceId && b.scope === scope && !b.delivered)) return;
    list.push({ id: this.next(), bundle, scope, createdAt: new Date().toISOString(), recipientUserId, recipientDeviceId, delivered: false });
    this.bundles.set(t, list);
  }
  async getBundles(t: string, deviceId: string) {
    return (this.bundles.get(t) ?? []).filter((b) => b.recipientDeviceId === deviceId && !b.delivered);
  }
  async ackBundles(t: string, deviceId: string, ids: string[]) {
    for (const b of this.bundles.get(t) ?? []) {
      if (b.recipientDeviceId === deviceId && ids.includes(b.id)) b.delivered = true;
    }
  }
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

/**
 * One phone. `kv` is handed in so a "new phone" is literally a new Map — the
 * device losing its keys is modelled by NOT passing the old one, rather than by
 * a wipe function that could quietly leave something behind.
 */
function phone(ds: MemoryDS, tt: MemoryTak, identity: string, kv: SecureKVStore = memKv()) {
  const mls = new MlsSessionStore(ds, identity, kv);
  const tak = new TakSessionStore(mls, tt, kv);
  return { mls, tak, kv };
}

/** The server's two backup columns. Opaque blobs, exactly like the real rows. */
interface Server {
  wrappedMaster: string | null;
  takBackup: string | null;
}

/**
 * Everything the person does BEFORE losing the phone: talk, then set up
 * recovery. Returns the code they were shown and the server state.
 */
async function useThenBackUp(ds: MemoryDS, tt: MemoryTak, topic: string, bodies: string[]) {
  const old = phone(ds, tt, 'alice');
  for (const [i, body] of bodies.entries()) {
    await old.mls.seal(topic, body);
    await old.tak.archiveOnSend(topic, `m-${String(i).padStart(4, '0')}`, body, 'public');
  }

  const server: Server = { wrappedMaster: null, takBackup: null };
  const masterKey = await km.loadOrCreateMasterKey(old.kv);
  await km.uploadTakKeychain(masterKey, await old.tak.exportKeychain(), async (b64) => {
    server.takBackup = b64;
  });
  const code = await km.backupWithRecoveryCode(masterKey, async (w) => {
    server.wrappedMaster = w;
  });
  return { code, server, old };
}

/** Everything the person does on the NEW phone, given a code. */
async function recoverOnto(
  fresh: ReturnType<typeof phone>,
  server: Server,
  code: string,
): Promise<Uint8Array | null> {
  const mk = await km.recoverWithRecoveryCode(code, async () => ({
    wrappedMaster: server.wrappedMaster,
    passkeys: [],
  }));
  if (!mk) return null;
  const keychain = await km.restoreTakKeychain(mk, async () => server.takBackup);
  if (keychain) await fresh.tak.importKeychain(keychain);
  return mk;
}

const read = async (p: ReturnType<typeof phone>, topic: string) =>
  Object.fromEntries((await p.tak.backfill(topic, 'public')).map((h) => [h.messageId, h.plaintext]));

describe('the recovery code recovers real messages', () => {
  it('CONTRACT: sealed → phone lost → code entered → the same words come back', async () => {
    const ds = new MemoryDS();
    const tt = new MemoryTak();
    const T = 'recover-topic';
    const { code, server } = await useThenBackUp(ds, tt, T, ['맑은 날 만나요', 'second one']);

    // The phone is gone. This one has never held a key.
    const fresh = phone(ds, tt, 'alice');

    /*
     * ATTRIBUTION FIRST. If the fresh phone could already read the archive, the
     * assertion after recovery would prove nothing about recovery. It reads
     * nothing, so what follows is the code's doing.
     */
    expect(await read(fresh, T)).toEqual({});

    const mk = await recoverOnto(fresh, server, code);
    expect(mk).not.toBeNull();

    // The words themselves, not a count and not a "no error".
    expect(await read(fresh, T)).toEqual({
      'm-0000': '맑은 날 만나요',
      'm-0001': 'second one',
    });
  });

  it('ACCUMULATING: twelve messages across two epochs all come back, not just the first', async () => {
    /*
     * A keychain that restored ONE root — or a backfill that stopped after the
     * first row — passes a two-message test and strands the rest of somebody's
     * history. The epoch change in the middle is the part that makes this more
     * than a longer list: messages before and after it are sealed under
     * different keys, so both have to survive the same restore.
     */
    const ds = new MemoryDS();
    const tt = new MemoryTak();
    const T = 'many-topic';
    const before = Array.from({ length: 6 }, (_, i) => `before-${i}`);
    const after = Array.from({ length: 6 }, (_, i) => `after-${i}`);

    const old = phone(ds, tt, 'alice');
    for (const [i, body] of before.entries()) {
      await old.mls.seal(T, body);
      await old.tak.archiveOnSend(T, `m-${String(i).padStart(4, '0')}`, body, 'public');
    }

    // A member joins: the epoch advances, and the TAK for later messages differs.
    const bob = phone(ds, tt, 'bob');
    await bob.mls.open(T, await old.mls.seal(T, 'ping'));
    for (const c of await ds.getCommitsSince(T, 0)) await old.mls.applyCommit(T, c.commit);
    await old.tak.distributeRoot(T, 'public');

    for (const [i, body] of after.entries()) {
      await old.mls.seal(T, body);
      await old.tak.archiveOnSend(T, `m-${String(i + 6).padStart(4, '0')}`, body, 'public');
    }

    const server: Server = { wrappedMaster: null, takBackup: null };
    const masterKey = await km.loadOrCreateMasterKey(old.kv);
    await km.uploadTakKeychain(masterKey, await old.tak.exportKeychain(), async (b) => {
      server.takBackup = b;
    });
    const code = await km.backupWithRecoveryCode(masterKey, async (w) => {
      server.wrappedMaster = w;
    });

    const fresh = phone(ds, tt, 'alice');
    await recoverOnto(fresh, server, code);

    const got = await read(fresh, T);
    // Every single one, by name. A `toHaveLength(12)` would pass on twelve
    // copies of the same body.
    for (const [i, body] of [...before, ...after].entries()) {
      expect(got[`m-${String(i).padStart(4, '0')}`]).toBe(body);
    }
  });

  it('HOSTILE: a different code of the same shape recovers nothing', async () => {
    const ds = new MemoryDS();
    const tt = new MemoryTak();
    const T = 'wrong-code-topic';
    const { server } = await useThenBackUp(ds, tt, T, ['secret words']);

    const attacker = phone(ds, tt, 'alice');
    // Same generator, same entropy, same format — only not the one issued.
    const mk = await recoverOnto(attacker, server, kb.generateRecoveryCode());

    expect(mk).toBeNull();
    expect(await read(attacker, T)).toEqual({});
  });

  it('BOUNDARY: the master_key alone does not open the archive — the keychain backup is load-bearing', async () => {
    /*
     * This is why the server holds a SECOND blob. Recovering the master_key
     * gets you the ability to decrypt the keychain; it is not itself the chat
     * key. If this ever passed without the keychain, the backup could be
     * dropped as redundant — and every recovery would silently return an empty
     * history while reporting success.
     */
    const ds = new MemoryDS();
    const tt = new MemoryTak();
    const T = 'no-keychain-topic';
    const { code, server } = await useThenBackUp(ds, tt, T, ['words worth keeping']);

    const fresh = phone(ds, tt, 'alice');
    const mk = await km.recoverWithRecoveryCode(code, async () => ({
      wrappedMaster: server.wrappedMaster,
      passkeys: [],
    }));
    expect(mk).not.toBeNull();
    // Deliberately skipping restoreTakKeychain/importKeychain.
    expect(await read(fresh, T)).toEqual({});

    // And with it, the same device reads everything — same phone, one step apart.
    const keychain = await km.restoreTakKeychain(mk!, async () => server.takBackup);
    await fresh.tak.importKeychain(keychain!);
    expect(await read(fresh, T)).toEqual({ 'm-0000': 'words worth keeping' });
  });



  it('IDEMPOTENT: recovering twice on the same device is not destructive', async () => {
    // People re-enter a code when a screen looks stuck. The second attempt must
    // not overwrite a working keychain with anything worse.
    const ds = new MemoryDS();
    const tt = new MemoryTak();
    const T = 'twice-topic';
    const { code, server } = await useThenBackUp(ds, tt, T, ['once', 'twice']);

    const fresh = phone(ds, tt, 'alice');
    await recoverOnto(fresh, server, code);
    const first = await read(fresh, T);
    await recoverOnto(fresh, server, code);

    expect(await read(fresh, T)).toEqual(first);
    expect(first).toEqual({ 'm-0000': 'once', 'm-0001': 'twice' });
  });
});
