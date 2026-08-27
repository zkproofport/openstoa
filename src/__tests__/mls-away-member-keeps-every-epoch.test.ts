/**
 * A member who was merely AWAY does not lose the conversation.
 *
 * THE DEFECT, found on 2026-08-27 by following the question "private 이랑
 * secret 은? 앱 안 쓰다가 다시 들어오면 문제 없냐" rather than answering it from
 * the public tier, which is where the first answer came from and was wrong.
 *
 * `private` and `secret` seal their archive with a key PER EPOCH. MLS ratchets
 * forward: once a commit is applied, the epoch it left can never be derived
 * again. `MlsSessionStore.catchUp` walked the missed commits in a loop —
 *
 *     for (const c of commits) s.state = await gc.processCommit(s.state, c.commit)
 *
 * — and derived nothing on the way. So a device that was away across five
 * membership changes came back at epoch N+5 holding a key for N+5 and nothing
 * else, and every message sent during N+1..N+4 was unreadable to it. Silently:
 * `epochTakForRead` answers `null` for a past epoch ("a past epoch: cache or
 * grant only") and the row renders as an undecryptable bubble. The only way
 * back was another member granting the keys, and the automatic grant is bounded
 * to 30 days — so a longer absence took the messages for good.
 *
 * The member was never removed. Removal is the thing per-epoch keys exist to
 * enforce, and it still works: a removed device stops receiving commits, so it
 * never reaches those epochs at all. Being quiet is not being removed, and this
 * file is the difference.
 *
 * REAL MLS AND REAL TAK. Nothing here is mocked but the transport, which stores
 * opaque bytes exactly as the server does. A test with a fake key derivation
 * could not tell a cached epoch key from a re-derived one, which is the whole
 * question.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage
 *   contract   → the away member reads a message from EVERY epoch it slept
 *                through, by content
 *   累積       → five missed commits, five recovered epochs. THE axis: a fix
 *                that cached only the newest epoch passes a one-commit test and
 *                leaves the other four exactly as broken
 *   boundary   → the epoch the device was STANDING IN when it fell behind is
 *                kept too — its key dies with the first commit applied
 *   integrity  → the keys open real archive rows; holding a key is not the
 *                claim, reading the words is
 *   failure    → a derivation that throws does not break catch-up, because a
 *                room that will not open is worse than a message that will not
 *   idempotent → catching up twice does not disturb keys already held
 */
import { describe, it, expect } from 'vitest';
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
  async postArchive(t: string, messageId: string, takVersion: number, ciphertext: string) {
    const list = this.archive.get(t) ?? [];
    if (list.some((r) => r.messageId === messageId)) return;
    list.push({ messageId, takVersion, ciphertext, createdAt: new Date().toISOString() });
    this.archive.set(t, list);
  }
  async getArchive(t: string) {
    return [...(this.archive.get(t) ?? [])].sort((a, b) => a.messageId.localeCompare(b.messageId));
  }
  async postBundle(t: string, u: string, d: string, bundle: string, scope: string) {
    const list = this.bundles.get(t) ?? [];
    list.push({
      id: String(this.seq++).padStart(6, '0'),
      bundle,
      scope,
      createdAt: new Date().toISOString(),
      recipientUserId: u,
      recipientDeviceId: d,
      delivered: false,
    });
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

function member(ds: MemoryDS, tt: MemoryTak, identity: string) {
  const kv = memKv();
  const mls = new MlsSessionStore(ds, identity, kv);
  const tak = new TakSessionStore(mls, tt, kv);
  return { mls, tak, kv, identity };
}

const TIER = 'private' as const;

describe('an away member keeps every epoch it slept through', () => {
  it('ACCUMULATING: five missed membership changes, and all five stretches read back', async () => {
    const ds = new MemoryDS();
    const tt = new MemoryTak();
    const T = 'away-topic';

    const host = member(ds, tt, 'host');
    const away = member(ds, tt, 'away');

    // Both are members from the start.
    const first = await host.mls.seal(T, 'genesis');
    await away.mls.open(T, first);
    for (const c of await ds.getCommitsSince(T, 0)) await host.mls.applyCommit(T, c.commit);

    /*
     * The away device takes the key for the epoch it is standing in, the way a
     * device that has read anything in the room would already have.
     */
    await away.tak.cacheCurrentEpochTak(T);

    /*
     * Now it goes quiet. Five people join; the host keeps talking. Each join
     * advances the epoch, so each `said-N` is sealed under a DIFFERENT key.
     */
    const expected: Record<string, string> = {};
    for (let i = 0; i < 5; i++) {
      const body = `said-${i}`;
      await host.mls.seal(T, body);
      await host.tak.archiveOnSend(T, `m-${i}`, body, TIER);
      expected[`m-${i}`] = body;

      const joiner = member(ds, tt, `joiner-${i}`);
      await joiner.mls.open(T, await host.mls.seal(T, 'ping'));
      for (const c of await ds.getCommitsSince(T, 0)) await host.mls.applyCommit(T, c.commit);
    }

    // Five joins really did move the epoch five times.
    expect(ds.groups.get(T)!.epoch).toBeGreaterThanOrEqual(5);

    // The away member comes back and catches up in one go.
    await away.mls.sync(T);

    const read = Object.fromEntries(
      (await away.tak.backfill(T, TIER)).map((h) => [h.messageId, h.plaintext]),
    );

    /*
     * Every stretch, by content. A length check would pass on five copies of the
     * last one, and the last one is exactly the message the broken code COULD
     * read — so a weaker assertion here reports the bug as fixed.
     */
    for (const [id, body] of Object.entries(expected)) {
      expect(read[id], `epoch stretch ${id}`).toBe(body);
    }
  });

  it('BOUNDARY: the epoch the device was standing in when it fell behind is kept', async () => {
    /*
     * That key dies the instant the first missed commit is applied, so it has to
     * be taken BEFORE the loop rather than after each step. A listener that only
     * fired post-commit would lose exactly this one stretch — the messages sent
     * closest to when the person was last here, which is the stretch they would
     * notice first.
     */
    const ds = new MemoryDS();
    const tt = new MemoryTak();
    const T = 'standing-topic';

    const host = member(ds, tt, 'host');
    const away = member(ds, tt, 'away');
    await away.mls.open(T, await host.mls.seal(T, 'genesis'));
    for (const c of await ds.getCommitsSince(T, 0)) await host.mls.applyCommit(T, c.commit);

    // A message in the epoch the away device is currently in. It has NOT cached
    // anything for this epoch yet — it never read here.
    await host.mls.seal(T, 'while-you-were-here');
    await host.tak.archiveOnSend(T, 'm-0', 'while-you-were-here', TIER);

    // Then the epoch moves on without it.
    const joiner = member(ds, tt, 'joiner');
    await joiner.mls.open(T, await host.mls.seal(T, 'ping'));
    for (const c of await ds.getCommitsSince(T, 0)) await host.mls.applyCommit(T, c.commit);

    await away.mls.sync(T);

    const read = Object.fromEntries(
      (await away.tak.backfill(T, TIER)).map((h) => [h.messageId, h.plaintext]),
    );
    expect(read['m-0']).toBe('while-you-were-here');
  });

  it('IDEMPOTENT: catching up twice does not disturb keys already held', async () => {
    const ds = new MemoryDS();
    const tt = new MemoryTak();
    const T = 'twice-topic';

    const host = member(ds, tt, 'host');
    const away = member(ds, tt, 'away');
    await away.mls.open(T, await host.mls.seal(T, 'genesis'));
    for (const c of await ds.getCommitsSince(T, 0)) await host.mls.applyCommit(T, c.commit);
    await away.tak.cacheCurrentEpochTak(T);

    await host.mls.seal(T, 'body');
    await host.tak.archiveOnSend(T, 'm-0', 'body', TIER);
    const joiner = member(ds, tt, 'joiner');
    await joiner.mls.open(T, await host.mls.seal(T, 'ping'));
    for (const c of await ds.getCommitsSince(T, 0)) await host.mls.applyCommit(T, c.commit);

    await away.mls.sync(T);
    const once = await away.tak.heldEpochs(T);
    await away.mls.sync(T);
    const twice = await away.tak.heldEpochs(T);

    expect(twice).toEqual(once);
    const read = Object.fromEntries(
      (await away.tak.backfill(T, TIER)).map((h) => [h.messageId, h.plaintext]),
    );
    expect(read['m-0']).toBe('body');
  });

  it('FAILURE: a listener that throws does not break the catch-up', async () => {
    /*
     * A room that will not open is worse than a message that will not. The
     * listener runs inside the topic lock during a commit walk, so an escape
     * would take the whole room down for a key-derivation problem.
     */
    const ds = new MemoryDS();
    const tt = new MemoryTak();
    const T = 'throwing-topic';

    const host = member(ds, tt, 'host');
    const away = member(ds, tt, 'away');
    await away.mls.open(T, await host.mls.seal(T, 'genesis'));
    for (const c of await ds.getCommitsSince(T, 0)) await host.mls.applyCommit(T, c.commit);

    away.mls.setEpochListener(async () => {
      throw new Error('keychain is full');
    });

    const joiner = member(ds, tt, 'joiner');
    await joiner.mls.open(T, await host.mls.seal(T, 'ping'));
    for (const c of await ds.getCommitsSince(T, 0)) await host.mls.applyCommit(T, c.commit);

    await expect(away.mls.sync(T)).resolves.toBeUndefined();
  });
});
