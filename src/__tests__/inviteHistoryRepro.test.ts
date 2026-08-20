/**
 * The reported failure, reproduced against the real MLS crypto: a private
 * topic's messages stay locked for someone who joined through the invite link.
 *
 * Observed on staging, with the web client's own diagnosis on screen —
 * `chat.lockedHistory.notCovered`, which is the branch for "the account key IS
 * here and the archive simply does not open with it". So the question this file
 * answers is narrow and mechanical: after the exact sequence a person performs,
 * does the joiner hold the epoch the messages were sealed under?
 *
 * The sequence is the point, so it is written out literally rather than reduced
 * to the one call under suspicion:
 *
 *   1. the owner sends, which seals the archive under the CURRENT epoch TAK
 *   2. other devices join, and every join advances the epoch
 *   3. the owner opens the invite dialog, which exports what it HOLDS and then
 *      keeps only the newest `INVITE_HISTORY_EPOCHS_DEFAULT` of them
 *   4. the joiner imports the fragment and backfills
 *
 * Step 3's subsetting lives in `InviteDialog`, not in the keychain, so it is
 * reproduced here — testing `exportInviteHistory` alone would skip the part of
 * the product that decides what actually travels.
 */
import { describe, it, expect } from 'vitest';
import * as gc from '@/lib/mls/groupClient';
import { MlsSessionStore, type MlsTransport, type CommitLogEntry, type SecureKVStore } from '@/lib/mls/mlsSession';
import { TakSessionStore, type TakTransport, type TakBundleRow, type ArchiveEntry } from '@/lib/mls/takSession';
import { parseCommitFraming } from '@/lib/mls/framing';
import { encodeInviteHistory, decodeInviteHistory } from '@/lib/inviteHistoryLink';
import { INVITE_HISTORY_EPOCHS_DEFAULT, INVITE_HISTORY_EPOCHS_MAX } from '@/lib/chatTierPolicy';

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
  bundles: TakBundleRow[] = [];
  async postArchive(t: string, messageId: string, takVersion: number, ciphertext: string) {
    const list = this.archive.get(t) ?? [];
    list.push({ messageId, takVersion, ciphertext, createdAt: new Date().toISOString() });
    this.archive.set(t, list);
  }
  async getArchive(t: string) {
    return [...(this.archive.get(t) ?? [])];
  }
  /*
   * Bundles are REALLY carried between devices here.
   *
   * A stand-in that accepted `postBundle` and answered `getBundles` with `[]`
   * made a grant look like it had failed when it had only been thrown away by
   * the harness — the test then blames the product for the double it was given.
   * Delivery is per recipient device, so that is what the map is keyed on.
   */
  posted = new Map<string, TakBundleRow[]>();
  private nextId = 0;
  private inbox(topicId: string, deviceId: string) {
    return `${topicId}::${deviceId}`;
  }
  async postBundle(
    topicId: string,
    _recipientUserId: string,
    recipientDeviceId: string,
    bundleB64: string,
    scope: string,
  ) {
    const key = this.inbox(topicId, recipientDeviceId);
    const list = this.posted.get(key) ?? [];
    list.push({
      id: `b${this.nextId++}`,
      bundle: bundleB64,
      scope,
      createdAt: new Date().toISOString(),
    });
    this.posted.set(key, list);
  }
  async getBundles(topicId: string, deviceId: string): Promise<TakBundleRow[]> {
    return [...(this.posted.get(this.inbox(topicId, deviceId)) ?? [])];
  }
  async ackBundles(topicId: string, deviceId: string, ids: string[]) {
    const key = this.inbox(topicId, deviceId);
    const keep = (this.posted.get(key) ?? []).filter((b) => !ids.includes(b.id));
    this.posted.set(key, keep);
  }
  async getServerRoot(): Promise<Uint8Array | null> {
    return null;
  }
  async putServerRoot(): Promise<boolean> {
    return true;
  }
  async getRootFingerprint(t: string) {
    return { fingerprint: null, archiveCount: (this.archive.get(t) ?? []).length };
  }
  async setRootFingerprint(_t: string, fingerprint: string) {
    return { fingerprint, claimed: true };
  }
}

function memKv(): SecureKVStore {
  const m = new Map<string, string>();
  return { get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, v) };
}

async function device(ds: MemoryDS, tt: MemoryTak, topic: string, identity: string) {
  const kv = memKv();
  const mls = new MlsSessionStore(ds, identity, kv);
  const tak = new TakSessionStore(mls, tt, kv);
  await mls.seal(topic, 'join');
  return { mls, tak, kv };
}

/** `InviteDialog`'s own subsetting: keep only the newest `count` epochs held. */
function newestEpochs(taks: Record<number, string>, count: number): Record<number, string> {
  const keep = Object.keys(taks)
    .map(Number)
    .sort((a, b) => b - a)
    .slice(0, count);
  const out: Record<number, string> = {};
  for (const e of keep) out[e] = taks[e];
  return out;
}

const TOPIC = 't-repro';

describe('a private topic invited into: does the joiner get the messages?', () => {
  it('REPRO: owner sends, two devices join, then an invite is made and used', async () => {
    const ds = new MemoryDS();
    const tt = new MemoryTak();

    // 1. The owner, on the web, sends three messages.
    const owner = await device(ds, tt, TOPIC, 'owner-web');
    const sentAt = await owner.mls.readState(TOPIC, async (s) => gc.currentEpoch(s));
    for (const [i, body] of ['1', '2', '3'].entries()) {
      const res = await owner.tak.archiveOnSend(TOPIC, `m${i}`, body, 'private');
      expect(res.archived, 'the send did not archive at all').toBe(true);
    }
    expect(tt.archive.get(TOPIC)!.every((r) => r.takVersion === sentAt)).toBe(true);

    // 2. The owner's own phone joins, then the guest's device does. Every join
    //    is a commit, and every commit advances the epoch.
    await device(ds, tt, TOPIC, 'owner-phone');
    await owner.mls.sync(TOPIC);
    const guest = await device(ds, tt, TOPIC, 'guest-web');
    await owner.mls.sync(TOPIC);

    const now = await owner.mls.readState(TOPIC, async (s) => gc.currentEpoch(s));
    expect(now, 'the joins did not advance the epoch').toBeGreaterThan(sentAt);

    // 3. The owner opens the invite dialog: export everything held, then keep
    //    the newest few — which is what the link actually carries.
    const held = await owner.tak.exportInviteHistory(TOPIC, INVITE_HISTORY_EPOCHS_MAX);
    const shared = newestEpochs(held, INVITE_HISTORY_EPOCHS_DEFAULT);
    const fragment = encodeInviteHistory({ taks: shared });
    expect(fragment).not.toBeNull();

    // THE question: does what travels include the epoch the messages live in?
    expect(
      Object.keys(shared).map(Number),
      `messages are sealed under epoch ${sentAt}; the link carries ${Object.keys(shared).join(',')}`,
    ).toContain(sentAt);

    // 4. The guest imports and backfills.
    const taks = decodeInviteHistory(fragment!)!.taks;
    await guest.tak.importInviteHistory(TOPIC, taks);
    const opened = await guest.tak.backfill(TOPIC, 'private');

    expect(
      opened.map((r) => r.plaintext).sort(),
      'the guest holds the keys but the archive still did not open',
    ).toEqual(['1', '2', '3']);
  });

  it('REPRO: the owner’s SECOND device is locked out until a member grants', async () => {
    /*
     * The other half of the report: the same person's phone, opening a room
     * their browser had already been talking in. No invite link is involved, and
     * by design there is no custodian — so this device holds nothing until an
     * existing member's client hands the epoch over.
     *
     * Both halves are asserted, because the fix is about WHEN the grant runs,
     * not whether granting works: locked before, open after.
     */
    const ds = new MemoryDS();
    const tt = new MemoryTak();

    const web = await device(ds, tt, TOPIC, 'owner-web');
    for (const [i, body] of ['1', '2', '3'].entries()) {
      await web.tak.archiveOnSend(TOPIC, `m${i}`, body, 'private');
    }

    const phone = await device(ds, tt, TOPIC, 'owner-phone');
    await web.mls.sync(TOPIC);

    expect(
      await phone.tak.backfill(TOPIC, 'private'),
      'a second device opened the history with no grant — the design says it cannot',
    ).toEqual([]);

    // What the owner's browser does when it opens the room. This is the ONLY
    // thing that unlocks the phone, and today it runs once per room opening.
    const granted = await web.tak.grantPrivateHistory(TOPIC);
    expect(granted, 'the grant handed over nothing').toBeGreaterThan(0);

    const opened = await phone.tak.backfill(TOPIC, 'private');
    expect(
      opened.map((r) => r.plaintext).sort(),
      'the grant ran but the phone still cannot read',
    ).toEqual(['1', '2', '3']);
  });
});
