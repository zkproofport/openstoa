/**
 * Phase 3 TAK orchestration — turns the portable crypto (takClient) + the live
 * MLS state (MlsSessionStore.readState) + the DS endpoints into the two client
 * flows the UI calls:
 *   - archiveOnSend  (P3-13): re-encrypt a just-sent body under the topic's TAK
 *     and upload the ciphertext, so later members can read it.
 *   - backfill       (P3-17): on opening a topic, pull any TAK bundles addressed
 *     to this device, then decrypt the archive into readable history.
 * Plus the public-topic holder helpers (P3-15 client side): distribute the
 * archive root to every current member leaf, and grant scoped epochs to one
 * recipient (private/secret).
 *
 * Transport is injected (HTTP in the browser, in-memory in tests). TAK material
 * is cached in a SecureKVStore (Keychain/IndexedDB) — never derivable again once
 * the epoch advances (forward secrecy), so we persist each key as we obtain it.
 */
import * as gc from './groupClient';
import * as tak from './takClient';
import type { MlsSessionStore, SecureKVStore } from './mlsSession';

export type Visibility = 'public' | 'private' | 'secret';

export interface TakBundleRow {
  id: string;
  bundle: string; // base64(JSON(WrappedBundle))
  scope: string;
  createdAt: string;
}
export interface ArchiveEntry {
  messageId: string;
  takVersion: number;
  ciphertext: string;
  createdAt: string;
}

/** Output of `sealForPush` — the `pushArchive` wire fields plus the local key mirror. */
export interface PushPreviewSeal {
  /** base64(nonce ‖ AEAD(HKDF(TAK,'push-preview'), body)) — goes in `pushArchive.ct`. */
  ct: string;
  /** TAK version it was sealed under: 0 = public archive root, else the MLS epoch. */
  takVersion: number;
  /**
   * base64 of the 32 raw TAK bytes. ONLY for mirroring into the local OS keychain
   * the notification extension reads (mobile). NEVER send this to the server and
   * NEVER log it.
   */
  takB64: string;
}

/** What the server publishes about a public topic's archive root (crypto-free). */
export interface ArchiveRootIdentity {
  /** base64 HKDF tag of the topic's archive root, or null if none is claimed yet. */
  fingerprint: string | null;
  /** Archive row count. Non-zero is permanent PROOF that a root already exists. */
  archiveCount: number;
}

/** Outcome of publishing a fingerprint: compare-and-set, first writer wins. */
export interface ArchiveRootClaim {
  /** The value now stored for the topic — ours, or the winner's. */
  fingerprint: string;
  /** True when ours is the stored one. */
  claimed: boolean;
}

/**
 * Where this device stands on a PUBLIC topic's archive root:
 *
 *   'verified'   — the root we hold matches the topic's published fingerprint.
 *                  The only state in which archiving is allowed.
 *   'waiting'    — we hold no usable root and are not allowed to mint one. The
 *                  real root has to arrive as a TAK bundle. Live chat is
 *                  unaffected (MLS messages do not use this key) — we simply
 *                  skip the archive append until it does.
 *   'orphan'     — we hold a root that is NOT the topic's. Read-only: it still
 *                  opens the rows this device sealed under it, but nothing new
 *                  may be sealed, distributed, or backed up under it.
 *   'unverified' — the check could not be completed (server unreachable). FAIL
 *                  SAFE: never mint, never archive. An unchecked mint is exactly
 *                  what orphans a topic's history.
 */
export type ArchiveRootState = 'verified' | 'waiting' | 'orphan' | 'unverified';

/** Result of an archive append. `rootState` is null for the per-epoch tiers. */
export interface ArchiveResult {
  archived: boolean;
  rootState: ArchiveRootState | null;
}

/** A resolved public root: the key we may use (if any) and why. */
interface RootResolution {
  key: Uint8Array | null;
  state: ArchiveRootState;
}

/** DS surface the TAK layer needs (server is crypto-free; this only moves bytes). */
export interface TakTransport {
  postArchive(topicId: string, messageId: string, takVersion: number, archiveB64: string): Promise<void>;
  getArchive(topicId: string): Promise<ArchiveEntry[]>;
  postBundle(
    topicId: string,
    recipientUserId: string,
    recipientDeviceId: string,
    bundleB64: string,
    scope: string,
  ): Promise<void>;
  getBundles(topicId: string, deviceId: string): Promise<TakBundleRow[]>;
  ackBundles(topicId: string, deviceId: string, ids: string[]): Promise<void>;
  /** Read the public archive root's published identity + archive row count. */
  getRootFingerprint(topicId: string): Promise<ArchiveRootIdentity>;
  /** Publish our root's fingerprint. COMPARE-AND-SET — never overwrites. */
  setRootFingerprint(topicId: string, fingerprint: string): Promise<ArchiveRootClaim>;
}

const dec = new TextDecoder();
function b64(u: Uint8Array): string {
  let s = '';
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return btoa(s);
}
function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function serializeWrapped(w: tak.WrappedBundle): string {
  return btoa(JSON.stringify(w));
}
function deserializeWrapped(s: string): tak.WrappedBundle {
  return JSON.parse(atob(s)) as tak.WrappedBundle;
}

interface LeafRef {
  identity: string;
  hpkePublicKey: Uint8Array;
}

export class TakSessionStore {
  constructor(
    private mls: MlsSessionStore,
    private transport: TakTransport,
    private store: SecureKVStore,
    // Phase 4 (§6.4.1): fired after any TAK material is written so the wiring
    // layer can re-upload the master_key-encrypted keychain backup. Optional —
    // tests and pre-Phase-4 callers omit it.
    private onKeychainChange?: () => void,
  ) {}

  private rootKey(t: string) {
    return `tak.root.${t}`;
  }
  // A root this device archived under before learning it was not the topic's.
  // Kept READ-ONLY and LOCAL ONLY: it is the sole key to rows this device
  // sealed, so deleting it would lose those too — but it is deliberately never
  // recorded in the manifest, so it can never reach the server keychain backup
  // or be handed to another member.
  private orphanRootKey(t: string) {
    return `tak.root.orphan.${t}`;
  }
  private epochKey(t: string, e: number) {
    return `tak.epoch.${t}.${e}`;
  }
  // A single manifest of every TAK store key we've written. SecureKVStore has no
  // list operation (Keychain can't enumerate), so we track keys explicitly to be
  // able to snapshot the whole keychain for the Phase 4 server backup.
  private manifestKey() {
    return 'tak.manifest';
  }

  private async recordKey(storeKey: string): Promise<void> {
    const raw = await this.store.get(this.manifestKey());
    const set: Record<string, true> = raw ? (JSON.parse(raw) as Record<string, true>) : {};
    if (!set[storeKey]) {
      set[storeKey] = true;
      await this.store.set(this.manifestKey(), JSON.stringify(set));
    }
    this.onKeychainChange?.();
  }

  private async getRoot(topicId: string): Promise<Uint8Array | null> {
    const v = await this.store.get(this.rootKey(topicId));
    return v ? unb64(v) : null;
  }
  // Writes are NO-OPS when the value is unchanged. Re-storing an identical key
  // would still fire onKeychainChange, and every mount/join re-delivers the same
  // root bundle — so without this a normal session schedules a full encrypted
  // keychain re-upload for material that did not change.
  private async setRoot(topicId: string, root: Uint8Array): Promise<void> {
    const v = b64(root);
    const prev = await this.store.get(this.rootKey(topicId));
    if (prev === v) return;
    // Replacing a root we held means that one was an orphan. Stash it so rows
    // this device already sealed under it stay readable to it (see backfill).
    if (prev != null) await this.store.set(this.orphanRootKey(topicId), prev);
    await this.store.set(this.rootKey(topicId), v);
    this.rootResolutions.delete(topicId); // the stored root changed — re-resolve
    await this.recordKey(this.rootKey(topicId));
  }
  private async getOrphanRoot(topicId: string): Promise<Uint8Array | null> {
    const v = await this.store.get(this.orphanRootKey(topicId));
    return v ? unb64(v) : null;
  }
  private async getEpochTak(topicId: string, epoch: number): Promise<Uint8Array | null> {
    const v = await this.store.get(this.epochKey(topicId, epoch));
    return v ? unb64(v) : null;
  }
  private async setEpochTak(topicId: string, epoch: number, t: Uint8Array): Promise<void> {
    const v = b64(t);
    if ((await this.store.get(this.epochKey(topicId, epoch))) === v) return;
    await this.store.set(this.epochKey(topicId, epoch), v);
    await this.recordKey(this.epochKey(topicId, epoch));
  }

  /** `tak.root.<topicId>` → topicId; null for any other key (incl. orphan stashes). */
  private topicIdOfRootKey(storeKey: string): string | null {
    if (!storeKey.startsWith('tak.root.') || storeKey.startsWith('tak.root.orphan.')) return null;
    return storeKey.slice('tak.root.'.length);
  }

  /**
   * Is this root provably NOT the topic's real archive root? THROWS when the
   * check cannot be completed — callers must treat "unknown" as "do not act",
   * never as "not an orphan".
   */
  private async rootIsOrphan(topicId: string, root: Uint8Array): Promise<boolean> {
    // Deliberately NOT served from the resolution cache. Backing up an orphan
    // root corrupts the user's single recovery snapshot, which is unrecoverable
    // and invisible until a recovery "succeeds" and opens nothing — so this asks
    // the server every time rather than trusting a cached verdict. The keychain
    // backup is debounced and only fires on a real key change, so the cost is
    // a handful of requests, not a per-message one.
    const identity = await this.transport.getRootFingerprint(topicId);
    // Nothing published: we have no basis to condemn this root (the retroactive
    // case — see resolveRoot). Absence of evidence is not evidence.
    if (!identity.fingerprint) return false;
    return (await tak.deriveRootFingerprint(root)) !== identity.fingerprint;
  }

  /**
   * Snapshot the whole TAK keychain (every root + epoch key held, across all
   * topics) as a plain `{ storeKey: base64Value }` map. The wiring layer seals
   * this under HKDF(master_key, tak-backup) and uploads it so a recovered
   * master_key re-reads all archived history (design §6.4.1). Excludes the
   * manifest bookkeeping key itself.
   */
  async exportKeychain(): Promise<Record<string, string>> {
    const raw = await this.store.get(this.manifestKey());
    if (!raw) return {};
    const set = JSON.parse(raw) as Record<string, true>;
    const out: Record<string, string> = {};
    for (const k of Object.keys(set)) {
      const v = await this.store.get(k);
      if (v == null) continue;
      // An ORPHAN root must never reach the server backup: a recovery that hands
      // back the wrong root opens nothing, and looks exactly like a working one.
      //
      // A key we cannot CHECK is skipped, not fatal. This used to abort the whole
      // export, on the reasoning that a partial keychain would overwrite a good
      // backup — but uploads merge now, so a skipped key costs nothing and an
      // abort costs everything. It cost exactly that in practice: one topic the
      // user had left answered 403 to the fingerprint check, and that single
      // permanently-unanswerable key stopped every other key on the device from
      // ever being backed up.
      const topicId = this.topicIdOfRootKey(k);
      if (topicId !== null) {
        let orphan: boolean;
        try {
          orphan = await this.rootIsOrphan(topicId, unb64(v));
        } catch {
          continue; // unverifiable → not ours to vouch for, but not a reason to stop
        }
        if (orphan) continue;
      }
      out[k] = v;
    }
    return out;
  }

  /**
   * Why did the backup upload nothing? `exportKeychain` can only return what the
   * manifest lists, the store cannot be enumerated, and every failure upstream
   * collapses into one swallowed catch — so a device holding perfectly good keys
   * and a device holding none look identical from the outside.
   *
   * Returns KEY NAMES and presence only, never key material, so callers may log
   * it. `unlisted` is the interesting one: a root this device holds that the
   * manifest never recorded is invisible to the export and always will be.
   */
  async diagnoseKeychain(probeTopicIds: string[] = []): Promise<{
    manifest: string[];
    present: string[];
    dangling: string[];
    unlisted: string[];
  }> {
    const raw = await this.store.get(this.manifestKey());
    const manifest = raw ? Object.keys(JSON.parse(raw) as Record<string, true>) : [];
    const present: string[] = [];
    const dangling: string[] = [];
    for (const k of manifest) ((await this.store.get(k)) == null ? dangling : present).push(k);
    // Key names are deterministic, so a topic id is enough to ask "is there a
    // root under here?" without enumeration. This is the ONLY way to see a key
    // written before the manifest existed.
    const unlisted: string[] = [];
    for (const t of probeTopicIds) {
      for (const k of [this.rootKey(t), this.orphanRootKey(t)]) {
        if (!manifest.includes(k) && (await this.store.get(k)) != null) unlisted.push(k);
      }
    }
    return { manifest, present, dangling, unlisted };
  }

  /**
   * Restore a keychain snapshot into the local store (recovery path). Writes each
   * key and rebuilds the manifest so a later export round-trips. Does NOT fire
   * onKeychainChange (restoring is not a new local change to re-upload).
   */
  async importKeychain(map: Record<string, string>): Promise<void> {
    const set: Record<string, true> = {};
    for (const [k, v] of Object.entries(map)) {
      await this.store.set(k, v);
      set[k] = true;
    }
    await this.store.set(this.manifestKey(), JSON.stringify(set));
  }

  // In-flight resolvePublicRoot per topic. Without this, a holder that resolves
  // concurrently (distribute-on-open + archive-on-send) would race: both read no
  // root, both generate a DIFFERENT random root, then archives get sealed under
  // one while the other is distributed — so receivers can't decrypt. Memoizing
  // the promise makes concurrent callers share one generation + one claim.
  private rootPromises = new Map<string, Promise<RootResolution>>();
  // Settled resolutions. 'verified' is cached for the session (the answer cannot
  // change: the fingerprint is write-once and our root then matches it);
  // 'waiting' / 'orphan' are real server answers, re-checked after a short TTL so
  // a device that was waiting picks the real root up as soon as its bundle lands.
  // 'unverified' is NOT cached at all — it means the check failed, and a failed
  // check must not keep a reachable server's answer out for another 15 seconds.
  private rootResolutions = new Map<string, { at: number; res: RootResolution }>();
  private static readonly UNSETTLED_ROOT_TTL_MS = 15_000;
  // Memo of "does this root open the topic's oldest archive row" — neither the
  // root nor the oldest row changes, so one answer per (topic, root) is final.
  private oldestRowProbe = new Map<string, boolean>();
  // Leaves we've already granted to (avoid re-granting the same device).
  private grantedLeaves = new Map<string, Set<string>>();

  /**
   * Where this device stands on a public topic's archive root. Everything that
   * touches the public archive goes through here.
   *
   * The decision table, given the topic's published fingerprint F and its
   * archive row count N (both read from the server, which computes neither):
   *
   *   F set,  our root matches F        → verified   (archive normally)
   *   F set,  our root differs          → orphan     (read-only; wait for the real root)
   *   F set,  no root held              → waiting    (wait for the real root)
   *   F null, N == 0, no root held      → mint, publish F, then persist → verified
   *   F null, N == 0, root held         → publish its F                → verified
   *   F null, N  > 0, no root held      → waiting    (rows PROVE a root exists)
   *   F null, N  > 0, root opens row #1 → publish its F                → verified
   *   F null, N  > 0, root does not     → orphan
   *   check failed (offline)            → unverified (never mint, never archive)
   *
   * The `F null, N > 0` rows are the retroactive half: every topic in production
   * today has archive rows and no fingerprint, and the old code read "no local
   * root" as "no root exists" and minted one — silently orphaning all of it. The
   * row count is what closes that hole, and decrypting the OLDEST row is what
   * decides which of two unproven roots is the real one: row #1 predates any
   * root minted later by a device that was merely waiting.
   */
  private resolvePublicRoot(topicId: string): Promise<RootResolution> {
    const cached = this.rootResolutions.get(topicId);
    if (cached && (cached.res.state === 'verified' || Date.now() - cached.at < TakSessionStore.UNSETTLED_ROOT_TTL_MS)) {
      return Promise.resolve(cached.res);
    }
    let p = this.rootPromises.get(topicId);
    if (!p) {
      p = this.computePublicRoot(topicId)
        .then((res) => {
          if (res.state !== 'unverified') this.rootResolutions.set(topicId, { at: Date.now(), res });
          return res;
        })
        .finally(() => {
          this.rootPromises.delete(topicId);
        });
      this.rootPromises.set(topicId, p);
    }
    return p;
  }

  private async computePublicRoot(topicId: string): Promise<RootResolution> {
    const local = await this.getRoot(topicId);
    let identity: ArchiveRootIdentity;
    try {
      identity = await this.transport.getRootFingerprint(topicId);
    } catch {
      // FAIL SAFE. A root minted without checking is the whole defect: it looks
      // valid to this device forever and orphans everything sealed under it.
      return { key: local, state: 'unverified' };
    }

    if (identity.fingerprint) {
      if (!local) return { key: null, state: 'waiting' };
      const mine = await tak.deriveRootFingerprint(local);
      return { key: local, state: mine === identity.fingerprint ? 'verified' : 'orphan' };
    }

    // Nothing published yet.
    if (!local) {
      // Archive rows are permanent proof a root existed (unlike tak_bundles,
      // which are deleted once delivered). Minting here is never safe.
      if (identity.archiveCount > 0) return { key: null, state: 'waiting' };
      return this.claimRoot(topicId, tak.generatePublicRootKey(), false);
    }

    if (identity.archiveCount > 0) {
      const opens = await this.rootOpensOldestArchiveRow(topicId, local);
      if (opens === null) return { key: local, state: 'unverified' }; // could not read the archive
      if (!opens) return { key: local, state: 'orphan' };
    }
    return this.claimRoot(topicId, local, true);
  }

  /**
   * Publish `root`'s fingerprint and interpret the compare-and-set outcome.
   * `persisted` says whether the root is already in the local store: a root we
   * just minted has sealed nothing, so if it loses the race we DROP it rather
   * than keep a guaranteed orphan; a stored root is kept read-only because rows
   * this device already sealed under it would otherwise become unreadable too.
   */
  private async claimRoot(topicId: string, root: Uint8Array, persisted: boolean): Promise<RootResolution> {
    const fp = await tak.deriveRootFingerprint(root);
    let claim: ArchiveRootClaim;
    try {
      claim = await this.transport.setRootFingerprint(topicId, fp);
    } catch {
      return { key: persisted ? root : null, state: 'unverified' };
    }
    if (claim.claimed) {
      if (!persisted) await this.setRoot(topicId, root);
      return { key: root, state: 'verified' };
    }
    return persisted ? { key: root, state: 'orphan' } : { key: null, state: 'waiting' };
  }

  /**
   * Does `root` decrypt the topic's OLDEST archive row? null when the archive
   * could not be read (treat as unknown, never as a verdict). True when the
   * topic has no rows at all — nothing contradicts the root.
   */
  private async rootOpensOldestArchiveRow(topicId: string, root: Uint8Array): Promise<boolean | null> {
    const memoKey = `${topicId}|${b64(root)}`;
    const memo = this.oldestRowProbe.get(memoKey);
    if (memo !== undefined) return memo;
    let rows: ArchiveEntry[];
    try {
      rows = await this.transport.getArchive(topicId);
    } catch {
      return null;
    }
    if (rows.length === 0) return true; // not memoized: rows may appear later
    // getArchive is ascending by (created_at, message_id).
    const oldest = rows[0];
    const opens = (await tak.openArchive(root, oldest.messageId, oldest.ciphertext)) != null;
    this.oldestRowProbe.set(memoKey, opens);
    return opens;
  }

  /**
   * This device's standing on a topic's archive root — for surfacing "history is
   * still syncing" in the UI. Null for private/secret/AI topics, whose archive
   * keys are per-epoch and have no topic-wide root (§5.2).
   */
  async archiveRootState(topicId: string, visibility: Visibility): Promise<ArchiveRootState | null> {
    if (visibility !== 'public') return null;
    return (await this.resolvePublicRoot(topicId)).state;
  }

  /**
   * The fingerprint of the VERIFIED public root this device holds, or null when
   * it holds none. This is what a device presents to claim the archive-holder
   * lease: the holder's whole job is handing the root to new leaves, so a device
   * that cannot produce this fingerprint has nothing to serve and must not take
   * the role. Claiming it anyway is self-locking — the holder is the one others
   * receive FROM, so nobody will ever send it the root it is missing.
   */
  async publicRootFingerprint(topicId: string): Promise<string | null> {
    const resolved = await this.resolvePublicRoot(topicId);
    if (resolved.state !== 'verified' || !resolved.key) return null;
    return tak.deriveRootFingerprint(resolved.key);
  }

  /** Derive + cache the current epoch's TAK (call as each epoch is processed). */
  async cacheCurrentEpochTak(topicId: string): Promise<void> {
    const epoch = await this.mls.readState(topicId, async (s) => gc.currentEpoch(s));
    if (await this.getEpochTak(topicId, epoch)) return;
    const t = await this.mls.readState(topicId, (s) => tak.deriveEpochTak(s, topicId, epoch));
    await this.setEpochTak(topicId, epoch, t);
  }

  /** This device's TAK address for a topic = its own MLS leaf key id. */
  async myDeviceId(topicId: string): Promise<string> {
    return this.mls.readState(topicId, async (s) => {
      const li = s.privatePath.leafIndex as number;
      const node = (s.ratchetTree as Array<{ leaf?: { hpkePublicKey: Uint8Array } } | undefined>)[li * 2];
      return tak.leafDeviceId(node!.leaf!.hpkePublicKey);
    });
  }

  /**
   * The archive key this topic seals under right now: public → the shared root
   * (tak_version 0); scoped → the current epoch TAK (tak_version = epoch), which
   * is cached as a side effect so it can be granted later (the exporter secret is
   * gone once the epoch advances).
   */
  private async currentArchiveKey(
    topicId: string,
    visibility: Visibility,
  ): Promise<{ key: Uint8Array | null; takVersion: number; rootState: ArchiveRootState | null }> {
    if (visibility === 'public') {
      const r = await this.resolvePublicRoot(topicId);
      // Only a VERIFIED root may seal anything. An orphan/unverified root would
      // produce rows that no member — including this device after it adopts the
      // real root — can ever read.
      return { key: r.state === 'verified' ? r.key : null, takVersion: 0, rootState: r.state };
    }
    const epoch = await this.mls.readState(topicId, async (s) => gc.currentEpoch(s));
    let t = await this.getEpochTak(topicId, epoch);
    if (!t) {
      t = await this.mls.readState(topicId, (s) => tak.deriveEpochTak(s, topicId, epoch));
      await this.setEpochTak(topicId, epoch, t);
    }
    return { key: t, takVersion: epoch, rootState: null };
  }

  /**
   * Re-encrypt a body we just sent and upload it to the archive (P3-13). public
   * → encrypt under the shared root (tak_version 0); scoped → under the current
   * epoch TAK (tak_version = epoch), which we also cache for later granting.
   *
   * A public topic whose root is not verified SKIPS the append and reports why,
   * instead of writing a row nobody can decrypt. This never blocks the message:
   * MLS application messages carry the live conversation and are independent of
   * the archive root, so the send has already succeeded by the time this runs.
   */
  async archiveOnSend(
    topicId: string,
    messageId: string,
    plaintext: string,
    visibility: Visibility,
  ): Promise<ArchiveResult> {
    const { key, takVersion, rootState } = await this.currentArchiveKey(topicId, visibility);
    if (!key) return { archived: false, rootState };
    await this.transport.postArchive(topicId, messageId, takVersion, await tak.sealArchive(key, messageId, plaintext));
    return { archived: true, rootState };
  }

  /**
   * Seal a PUSH-PREVIEW copy of a body about to be sent (design §13.6 strategy
   * A). The recipient's iOS Notification Service Extension cannot decrypt the
   * live MLS ciphertext — that would consume a forward-secret ratchet key and
   * desync the app — so it decrypts this TAK-sealed copy instead, using a key it
   * reads from the shared Keychain. The sender therefore ships the copy INSIDE
   * the `POST /chat` body (`pushArchive`): the separate archive upload happens
   * after the POST returns, so it does not exist yet when the push fans out.
   *
   * Uses the SAME key as `archiveOnSend` but the fixed `push-preview` context
   * (the server-assigned message id isn't known pre-POST — see takClient).
   * Returns null on any failure: the preview is an optimisation and must never
   * block sending. `takB64` is raw key material for the LOCAL OS-keychain mirror
   * only — never send it to the server, never log it.
   */
  async sealForPush(topicId: string, plaintext: string, visibility: Visibility): Promise<PushPreviewSeal | null> {
    try {
      const { key, takVersion } = await this.currentArchiveKey(topicId, visibility);
      // No verified root → no preview. Sealing under an orphan root would ship a
      // notification body every recipient fails to open.
      if (!key) return null;
      return { ct: await tak.sealPushPreview(key, plaintext), takVersion, takB64: b64(key) };
    } catch {
      return null;
    }
  }

  /**
   * The TAK a RECEIVING device needs to open incoming push previews for a topic,
   * without sealing anything. Used to mirror the key into the OS keychain the
   * notification extension reads — a device that only ever reads a topic still
   * has to hold the key. Same key/version as `sealForPush`. Returns null instead
   * of throwing when the key can't be resolved (nothing to mirror). `takB64` is
   * raw key material: local keychain only, never to the server, never logged.
   */
  async takForPush(topicId: string, visibility: Visibility): Promise<Omit<PushPreviewSeal, 'ct'> | null> {
    try {
      const { key, takVersion } = await this.currentArchiveKey(topicId, visibility);
      if (!key) return null; // nothing worth mirroring until the real root arrives
      return { takVersion, takB64: b64(key) };
    } catch {
      return null;
    }
  }

  private async allMemberLeaves(topicId: string): Promise<LeafRef[]> {
    return this.mls.readState(topicId, async (s) => {
      const tree = s.ratchetTree as Array<
        { nodeType?: string; leaf?: { hpkePublicKey: Uint8Array; credential?: { credentialType?: string; identity?: Uint8Array } } } | undefined
      >;
      const out: LeafRef[] = [];
      for (const node of tree) {
        if (!node || node.nodeType !== 'leaf' || !node.leaf) continue;
        const cred = node.leaf.credential;
        if (!cred || cred.credentialType !== 'basic' || !cred.identity) continue;
        out.push({ identity: dec.decode(cred.identity), hpkePublicKey: node.leaf.hpkePublicKey });
      }
      return out;
    });
  }

  /**
   * Holder action (public, SI-6): wrap the archive root to EVERY current member
   * leaf and upload the bundles, so any member — including ones who joined later
   * — can derive every archived epoch. Returns how many bundles were sent.
   *
   * REFUSES (returns 0) unless our root is verified. This is the blast radius
   * that made the defect catastrophic rather than local: the holder lease is
   * only 900s and is renewed only while someone has the chat open, so a device
   * holding an orphan root could easily win the lease and push that root to
   * every member — overwriting the real one everywhere at once.
   */
  async distributePublicRoot(topicId: string): Promise<number> {
    // Catch up first so we see every current member's leaf — a holder whose
    // history decrypted from cache never MLS-opened, so its tree could be stale.
    await this.mls.sync(topicId);
    const resolved = await this.resolvePublicRoot(topicId);
    if (resolved.state !== 'verified' || !resolved.key) return 0;
    const payload: tak.PublicBundle = { tier: 'public', rootKey: b64(resolved.key) };
    const leaves = await this.allMemberLeaves(topicId);
    let n = 0;
    for (const lf of leaves) {
      const wrapped = await tak.wrapBundleToLeaf(lf.hpkePublicKey, payload);
      await this.transport.postBundle(topicId, lf.identity, tak.leafDeviceId(lf.hpkePublicKey), serializeWrapped(wrapped), 'full');
      n++;
    }
    return n;
  }

  /**
   * Grant a scoped set of cached epoch TAKs to one recipient's device(s)
   * (private/secret). Only epochs we actually hold are sent; the recipient
   * cannot read any epoch outside this grant (revocation by omission).
   */
  async grantScoped(topicId: string, recipientUserId: string, epochs: number[]): Promise<number> {
    const taks: Record<string, string> = {};
    for (const e of epochs) {
      const t = await this.getEpochTak(topicId, e);
      if (t) taks[String(e)] = b64(t);
    }
    const payload: tak.ScopedBundle = { tier: 'scoped', taks };
    await this.mls.sync(topicId);
    const leaves = await this.mls.readState(topicId, async (s) => tak.findRecipientLeaves(s, recipientUserId));
    const scope = epochs.length ? `since_epoch:${Math.min(...epochs)}` : 'none';
    let n = 0;
    for (const lf of leaves) {
      const wrapped = await tak.wrapBundleToLeaf(lf.hpkePublicKey, payload);
      await this.transport.postBundle(topicId, recipientUserId, tak.leafDeviceId(lf.hpkePublicKey), serializeWrapped(wrapped), scope);
      n++;
    }
    return n;
  }

  /**
   * Auto-grant for a PRIVATE topic (SI-6b): hand the epoch TAKs this member
   * holds to every current member leaf it hasn't granted yet — addressed by
   * leaf (the MLS credential is a device id, not a user id, so we can't target
   * by user). This is an explicit point-in-time grant, NOT a standing custodian:
   * no archive_holders row, no forward-rewrap, so a removed member's future
   * epochs are never shared and a full churn leaves the archive unrecoverable
   * (the intended escrow-free behavior). SECRET topics do NOT auto-grant — the
   * owner grants explicitly (grantScoped) — so callers gate this to private.
   * Returns the number of leaves newly granted.
   */
  async grantPrivateHistory(topicId: string, opts?: { windowDays?: number }): Promise<number> {
    await this.cacheCurrentEpochTak(topicId);
    // Bound the grant to a recent window (design §5.2 private default 30d). The
    // epoch→time map comes from the archive rows themselves (created_at ≈ send
    // time, tak_version = epoch) — no extra plumbing — and we only grant epochs
    // that actually have archived content in-window. windowDays<=0 = full history.
    const windowDays = opts?.windowDays ?? 30;
    const cutoffMs = windowDays > 0 ? Date.now() - windowDays * 86_400_000 : -Infinity;
    const rows = await this.transport.getArchive(topicId);
    const inWindow = new Set<number>();
    for (const r of rows) {
      if (Date.parse(r.createdAt) >= cutoffMs) inWindow.add(r.takVersion);
    }
    const taks: Record<string, string> = {};
    let minEpoch = Infinity;
    for (const e of inWindow) {
      const t = await this.getEpochTak(topicId, e);
      if (t) {
        taks[String(e)] = b64(t);
        if (e < minEpoch) minEpoch = e;
      }
    }
    if (Object.keys(taks).length === 0) return 0;
    const payload: tak.ScopedBundle = { tier: 'scoped', taks };
    const scope = `since_epoch:${minEpoch}`;

    await this.mls.sync(topicId);
    const myDev = await this.myDeviceId(topicId);
    let granted = this.grantedLeaves.get(topicId);
    if (!granted) {
      granted = new Set();
      this.grantedLeaves.set(topicId, granted);
    }
    const leaves = await this.allMemberLeaves(topicId);
    let n = 0;
    for (const lf of leaves) {
      const dev = tak.leafDeviceId(lf.hpkePublicKey);
      if (dev === myDev || granted.has(dev)) continue; // skip self + already-granted
      const wrapped = await tak.wrapBundleToLeaf(lf.hpkePublicKey, payload);
      await this.transport.postBundle(topicId, lf.identity, dev, serializeWrapped(wrapped), scope);
      granted.add(dev);
      n++;
    }
    return n;
  }

  /**
   * Should an incoming public root REPLACE what we hold? The old code answered
   * "always" — it called setRoot unconditionally — which is how one device's
   * orphan root reached every member and every keychain backup.
   *
   *   already hold this exact root      → false (no-op; no keychain churn)
   *   fingerprint published             → only if the incoming root matches it
   *   fingerprint null, no root held    → true (nothing to lose)
   *   fingerprint null, root held       → only if the incoming root opens the
   *                                       topic's oldest archive row and ours
   *                                       does not — the one piece of evidence
   *                                       available on a topic that predates the
   *                                       fingerprint. This is what repairs an
   *                                       already-orphaned device.
   *   check failed                      → false (never overwrite on a guess)
   */
  private async shouldAdoptRoot(topicId: string, incoming: Uint8Array): Promise<boolean> {
    const local = await this.getRoot(topicId);
    if (local && b64(local) === b64(incoming)) return false;

    let identity: ArchiveRootIdentity;
    try {
      identity = await this.transport.getRootFingerprint(topicId);
    } catch {
      return false;
    }

    if (identity.fingerprint) {
      return (await tak.deriveRootFingerprint(incoming)) === identity.fingerprint;
    }
    if (!local) return true;
    if ((await this.rootOpensOldestArchiveRow(topicId, incoming)) !== true) return false;
    return (await this.rootOpensOldestArchiveRow(topicId, local)) === false;
  }

  /** Pull bundles addressed to this device, unwrap, cache their TAKs, ack. */
  async ingestBundles(topicId: string): Promise<void> {
    const myDev = await this.myDeviceId(topicId);
    const rows = await this.transport.getBundles(topicId, myDev);
    const acked: string[] = [];
    for (const row of rows) {
      let payload: tak.TakBundlePayload | null = null;
      try {
        payload = await this.mls.readState(topicId, (s) => tak.unwrapBundle<tak.TakBundlePayload>(s, deserializeWrapped(row.bundle)));
      } catch {
        payload = null;
      }
      if (!payload) continue;
      if (payload.tier === 'public') {
        const incoming = unb64(payload.rootKey);
        if (await this.shouldAdoptRoot(topicId, incoming)) await this.setRoot(topicId, incoming);
        // A rejected bundle is still acked: the published fingerprint is
        // write-once, so a root that fails the check now can never pass later —
        // leaving it undelivered would only make us re-fetch it forever.
      } else {
        for (const [e, k] of Object.entries(payload.taks)) await this.setEpochTak(topicId, Number(e), unb64(k));
      }
      acked.push(row.id);
    }
    if (acked.length) await this.transport.ackBundles(topicId, myDev, acked);
  }

  /**
   * Back-fill history (P3-17): ingest any pending bundles, then decrypt every
   * archive row we now hold a key for. Rows we lack a key for (out of scope) are
   * skipped. Returns the decrypted bodies keyed by original message id.
   */
  async backfill(topicId: string, visibility: Visibility): Promise<Array<{ messageId: string; plaintext: string }>> {
    await this.ingestBundles(topicId);
    const rows = await this.transport.getArchive(topicId);
    // Public reads try the topic's root first, then any orphan root this device
    // previously archived under — those rows are unreadable to everyone else,
    // but there is no reason to hide them from the device that wrote them.
    const publicKeys =
      visibility === 'public'
        ? ([await this.getRoot(topicId), await this.getOrphanRoot(topicId)].filter(Boolean) as Uint8Array[])
        : [];
    const out: Array<{ messageId: string; plaintext: string }> = [];
    for (const r of rows) {
      const keys = visibility === 'public' ? publicKeys : [await this.getEpochTak(topicId, r.takVersion)];
      for (const key of keys) {
        if (!key) continue;
        const pt = await tak.openArchive(key, r.messageId, r.ciphertext);
        if (pt != null) {
          out.push({ messageId: r.messageId, plaintext: pt });
          break;
        }
      }
    }
    return out;
  }
}
