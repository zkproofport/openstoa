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
import { serverMayHoldKey, usesTopicRootKey, type ChatTier } from './chatTierPolicy';
import {
  readChatHistory,
  writeChatHistory,
  cursorFrom,
  mergeChatHistory,
  type CachedChatHistory,
  type CachedChatMessage,
  type ChatHistoryCursor,
  type ChatHistoryStore,
} from './chatHistoryCache';

/**
 * A topic ROW's visibility. Kept because that is what the topic API returns and
 * what several callers hold — but it is deliberately NOT what the methods below
 * take.
 *
 * The distinction is the one this file got wrong. A DM's row carries
 * `visibility: 'secret'`, so keying the archive off visibility gave every DM
 * per-epoch keys while `chatTierPolicy` declared DMs used one topic-wide root —
 * and since 'dm' is not a visibility, no type could catch it. The methods take a
 * `ChatTier`, which callers build with `chatTierOf(visibility, isDm)`, and every
 * `Visibility` is also a valid `ChatTier`, so nothing has to be converted twice.
 */
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
  /**
   * Archive rows, ascending by (createdAt, messageId).
   *
   * `since` asks for only what comes AFTER that row. A caller that already holds
   * the earlier rows — see `chatHistoryCache` — must pass it: without it every
   * room entry pages the whole archive out of the server and decrypts all of it,
   * which is correct, invisible, and ruinous once a room has real history.
   */
  getArchive(topicId: string, since?: ChatHistoryCursor): Promise<ArchiveEntry[]>;
  postBundle(
    topicId: string,
    recipientUserId: string,
    recipientDeviceId: string,
    bundleB64: string,
    scope: string,
  ): Promise<void>;
  getBundles(topicId: string, deviceId: string): Promise<TakBundleRow[]>;
  ackBundles(topicId: string, deviceId: string, ids: string[]): Promise<void>;
  /**
   * The archive root the server holds for a PUBLIC topic, or null when none has
   * been deposited yet.
   *
   * Only public topics keep a key there — see `chatTierPolicy` — and the route
   * refuses every other tier, so a caller cannot accidentally hand over a key
   * that was supposed to stay on devices.
   */
  getServerRoot(topicId: string): Promise<Uint8Array | null>;
  /**
   * Deposit the root for a PUBLIC topic. Write-once on the server: depositing
   * the same key again succeeds, a different one is refused, and `false` comes
   * back when somebody else got there first — the caller then reads theirs
   * rather than keeping a key nothing was sealed under.
   */
  putServerRoot(topicId: string, root: Uint8Array): Promise<boolean>;
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
    /**
     * Where decrypted history is kept between visits. Optional: without it the
     * room still works, it just pays the full archive read every time — which
     * is exactly what shipped, so omitting it is a measurable regression rather
     * than a broken room.
     */
    private historyStore?: ChatHistoryStore,
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

  // In-flight resolveRoot per topic. Without this, a holder that resolves
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
  // Epoch at which this device last handed the root out, per topic. A new leaf
  // always advances the epoch, so this is what makes re-distribution fire once
  // per real membership change instead of once per incoming event.
  private lastDistributedEpoch = new Map<string, number>();
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
   *   F null, N  > 0, no root held      → mint, publish F, then persist → verified
   *   F null, N  > 0, root opens row #1 → publish its F                → verified
   *   F null, N  > 0, root does not     → orphan
   *   check failed (offline)            → unverified (never mint, never archive)
   *
   * The `F null, N > 0` rows are the retroactive half. Where a root IS held,
   * decrypting the OLDEST row decides which of two unproven roots is the real
   * one: row #1 predates any root minted later by a device that was merely
   * waiting. Where NO root is held there is nothing to test and nothing to
   * contradict — on this path a fingerprint is always published before a row can
   * be sealed under a root (see `computePeerRoot`), so rows with no fingerprint
   * are rows from the per-epoch era rather than proof that a root exists.
   * Reading them as proof is what deadlocked every DM with any history.
   */
  private resolveRoot(topicId: string, tier: ChatTier): Promise<RootResolution> {
    const cached = this.rootResolutions.get(topicId);
    if (cached && (cached.res.state === 'verified' || Date.now() - cached.at < TakSessionStore.UNSETTLED_ROOT_TTL_MS)) {
      return Promise.resolve(cached.res);
    }
    let p = this.rootPromises.get(topicId);
    if (!p) {
      /*
       * Two ways to agree on one root, and which one applies is exactly the
       * question `serverMayHoldKey` answers. A public topic asks the server,
       * which holds the key and settles the race in a round trip. A DM cannot —
       * the server is not allowed to hold that key — so the devices settle it
       * between themselves against a published FINGERPRINT, which is a one-way
       * tag the server stores without ever being able to derive the key from it.
       */
      p = (serverMayHoldKey(tier) ? this.computeServerRoot(topicId) : this.computePeerRoot(topicId))
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

  private async computeServerRoot(topicId: string): Promise<RootResolution> {
    /*
     * A public topic's archive root lives on the server, so this is three
     * questions instead of the compare-and-set dance it replaced.
     *
     * The old version published a FINGERPRINT and had every device agree on
     * which root was real: mint, claim, lose the race, adopt somebody else's,
     * decide whether a root we already sealed under is an orphan. That
     * machinery existed because no two devices could ask a common authority
     * which key was the topic's. Now they can — the server holds it, deposits
     * are write-once, and the race resolves in one round trip instead of a
     * state machine.
     *
     * `waiting` and `orphan` cannot happen here any more: nobody waits for
     * another member to hand a key over, and a key that lost the deposit race
     * is dropped rather than kept. They remain in the type for the scoped tiers.
     */
    const local = await this.getRoot(topicId);
    if (local) return { key: local, state: 'verified' };

    let served: Uint8Array | null;
    try {
      served = await this.transport.getServerRoot(topicId);
    } catch {
      // FAIL SAFE. Minting without checking is the whole defect this replaced:
      // it looks valid to this device forever and orphans everything sealed
      // under it.
      return { key: null, state: 'unverified' };
    }
    if (served) {
      await this.setRoot(topicId, served);
      return { key: served, state: 'verified' };
    }

    // Nothing there yet — this device mints the topic's root and deposits it.
    const minted = tak.generatePublicRootKey();
    let won: boolean;
    try {
      won = await this.transport.putServerRoot(topicId, minted);
    } catch {
      return { key: null, state: 'unverified' };
    }
    if (won) {
      await this.setRoot(topicId, minted);
      return { key: minted, state: 'verified' };
    }

    // Somebody deposited first. Take theirs; the minted key sealed nothing, so
    // dropping it costs nothing and keeping it would guarantee an orphan.
    try {
      const theirs = await this.transport.getServerRoot(topicId);
      if (theirs) {
        await this.setRoot(topicId, theirs);
        return { key: theirs, state: 'verified' };
      }
    } catch {
      /* fall through — unverified is the honest answer */
    }
    return { key: null, state: 'unverified' };
  }

  /**
   * The archive root of a topic-root tier the server may NOT hold — today, a DM.
   *
   * The public tier settles this by asking the server, which is allowed to keep
   * the key. A DM's key must never reach it, so the devices settle it between
   * themselves against a published FINGERPRINT: a one-way tag of the root that
   * identifies it without disclosing it, written compare-and-set so the first
   * device to mint one wins and every other device adopts that answer.
   *
   *   fingerprint published, we hold the matching root   → verified
   *   fingerprint published, we hold a different root    → orphan (read-only:
   *       it still opens rows this device sealed, and must seal no more)
   *   fingerprint published, we hold nothing             → waiting. The root is
   *       on the peer's devices and arrives as a TAK bundle. There is no other
   *       route to it, and inventing one here is the whole defect.
   *   nothing published                                  → mint and claim. Rows
   *       may exist and still not contradict this: nothing is ever sealed under
   *       a root before that root's fingerprint is published, so unfingerprinted
   *       rows are per-epoch leftovers, not evidence of a root.
   *   check failed (offline)                             → unverified. NEVER
   *       mint: a root minted without checking looks valid to this device
   *       forever and orphans everything sealed under it.
   *
   * `key` is still handed back on `unverified` and `orphan`, because reading is
   * not sealing: a device offline with its own history should still open it.
   * `currentArchiveKey` is what refuses to seal under anything but `verified`.
   */
  private async computePeerRoot(topicId: string): Promise<RootResolution> {
    const local = await this.getRoot(topicId);

    let identity: ArchiveRootIdentity;
    try {
      identity = await this.transport.getRootFingerprint(topicId);
    } catch {
      return { key: local, state: 'unverified' };
    }

    if (identity.fingerprint) {
      if (!local) return { key: null, state: 'waiting' };
      return (await tak.deriveRootFingerprint(local)) === identity.fingerprint
        ? { key: local, state: 'verified' }
        : { key: local, state: 'orphan' };
    }

    /*
     * Rows exist but no fingerprint does. A device that HOLDS a root which
     * cannot open the OLDEST of those rows is provably not holding the root they
     * were sealed under, so claiming its own would rename the archive's identity
     * to a key that opens none of it.
     *
     * What is NOT here any more, and why: this used to ALSO refuse a device
     * holding nothing (`if (!local) return waiting`), on the reasoning that rows
     * prove a root exists and only its holder may speak for it. For a public
     * topic being migrated that was right. On THIS path it is an unbreakable
     * cycle, and it deadlocked every DM that had ever carried a message:
     *
     *   - claiming a root is the only way to get one, and it demanded one;
     *   - the only other source is a peer's TAK bundle, and `distributeRoot`
     *     sends nothing unless the sender's own root is verified — so every
     *     device of both participants sat in `waiting`, forever;
     *   - and it compounded, because `currentArchiveKey` hands back no key
     *     unless verified, so messages sent afterwards went unarchived too.
     *
     * It cannot re-open the public-topic hole it was written to close, for two
     * independent reasons:
     *
     *  1. A public topic does not come here. `resolveRoot` dispatches on
     *     `serverMayHoldKey(tier)`: public asks the SERVER, which holds the key
     *     and settles the race in one round trip (`computeServerRoot`). This
     *     function is the no-arbiter path, and `dm` is the only tier that both
     *     reaches it and has a topic-wide root at all.
     *  2. On this path a fingerprint is published BEFORE any row can be sealed
     *     under a topic root — `currentArchiveKey` seals only on `verified`, and
     *     `verified` here is only ever reached through `claimRoot`, which
     *     publishes first. So `fingerprint === null && archiveCount > 0` cannot
     *     denote topic-root rows; it denotes rows from the per-epoch era, which
     *     no root will ever open. `mls-tak-dm-root.test.ts` pins that ordering.
     *
     * Note what the condition is NOT: a count of `tak_version = 0` rows. A DM's
     * first MLS epoch IS 0, so a legacy per-epoch row and a topic-root row are
     * indistinguishable by version — and a count would then keep dead ciphertext
     * looking like history. The question is about the TIER's key model, and the
     * dispatch above is where that is already answered.
     */
    if (
      identity.archiveCount > 0 &&
      local &&
      (await this.rootOpensOldestArchiveRow(topicId, local)) !== true
    ) {
      return { key: local, state: 'orphan' };
    }

    return this.claimRoot(topicId, local ?? tak.generatePublicRootKey(), local != null);
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
   * still syncing" in the UI. Null for the per-epoch tiers, which have no
   * topic-wide root to have a standing on (§5.2).
   */
  async archiveRootState(topicId: string, tier: ChatTier): Promise<ArchiveRootState | null> {
    if (!usesTopicRootKey(tier)) return null;
    return (await this.resolveRoot(topicId, tier)).state;
  }

  /**
   * Drop a cached NOT-YET-SETTLED answer, so the next resolution asks the
   * server again instead of repeating the last one.
   *
   * `resolveRoot` holds a 'waiting' answer for UNSETTLED_ROOT_TTL_MS,
   * which is right for casual callers and wrong for the one case that matters:
   * a device sitting in an open room with locked history, polling precisely
   * because it expects the answer to change. Its retries all landed inside the
   * TTL and were answered from the cache without a request, so a bundle that
   * arrived seconds after the device joined was not picked up until the user
   * left the room and came back — which is exactly what it looked like.
   *
   * A 'verified' answer is never dropped: it cannot change (the fingerprint is
   * write-once and ours matches it), so re-asking could only cost a request.
   */
  forgetUnsettledRoot(topicId: string): void {
    const cached = this.rootResolutions.get(topicId);
    if (cached && cached.res.state !== 'verified') this.rootResolutions.delete(topicId);
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
    // The holder lease is a PUBLIC-tier mechanism — a DM has two participants
    // and no lease to win — so the tier is fixed here rather than passed.
    const resolved = await this.resolveRoot(topicId, 'public');
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

  /**
   * The epoch TAKs to put in an invite link, newest-first up to `maxEpochs`.
   *
   * This is the whole of history sharing for `private` and `secret`: the keys
   * ride in the link's fragment, which never reaches the server, so the topic
   * hands over its past without the operator ever holding a key. There is no
   * server-side grant to revoke afterwards, which is exactly why the count is
   * bounded and why the caller shows the inviter what it comes to in messages.
   *
   * Only epochs this device actually HOLDS are returned. An inviter cannot
   * share what they were never given — a member who joined last week cannot
   * hand over the month before it, and that ceiling is a property of the
   * keychain rather than a rule anyone has to enforce.
   *
   * The current epoch is cached first, or the newest thing on offer would be
   * the one the inviter is standing in and has not written down yet.
   */
  async exportInviteHistory(topicId: string, maxEpochs: number): Promise<Record<number, string>> {
    if (!Number.isInteger(maxEpochs) || maxEpochs <= 0) return {};
    await this.cacheCurrentEpochTak(topicId).catch(() => {});

    const current = await this.mls
      .readState(topicId, async (s) => gc.currentEpoch(s))
      .catch(() => null);
    if (current === null) return {};

    const out: Record<number, string> = {};
    // Walk BACKWARDS from the current epoch and stop at the count, so what is
    // shared is always the most recent history rather than the oldest.
    for (let e = current; e >= 0 && Object.keys(out).length < maxEpochs; e--) {
      const t = await this.getEpochTak(topicId, e);
      // A gap is skipped, not treated as the end: a device can hold epoch 9 and
      // 7 but not 8, and stopping at the hole would silently share less than
      // the inviter chose.
      if (t) out[e] = b64(t);
    }
    return out;
  }

  /**
   * Take epoch TAKs out of an invite link and into this device's keychain.
   *
   * Returns how many were NEW, because that is what the caller can honestly
   * tell the user: re-opening the same link is not an error and shares nothing
   * further, and saying "3 more epochs" when the answer is zero is a lie the
   * second time someone taps a link.
   *
   * An epoch already held is never overwritten. The key in hand was derived
   * from the group's own secret and is therefore right; one arriving in a URL
   * has been through a channel we do not control, and letting it replace a
   * working key is how a bad link makes readable history unreadable.
   */
  async importInviteHistory(topicId: string, taks: Record<number, string>): Promise<number> {
    let added = 0;
    for (const [k, v] of Object.entries(taks)) {
      const epoch = Number(k);
      if (!Number.isInteger(epoch) || epoch < 0) continue;
      if (await this.getEpochTak(topicId, epoch)) continue;
      let bytes: Uint8Array;
      try {
        bytes = unb64(v);
      } catch {
        continue;
      }
      // Length is the only check available here — an epoch key is symmetric, so
      // there is nothing to verify it against until it either opens an archive
      // row or does not. A wrong-sized value is provably not a key, though.
      if (bytes.length !== tak.TAK_LEN) continue;
      await this.setEpochTak(topicId, epoch, bytes);
      added++;
    }
    return added;
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
   * The archive key this topic seals under right now: a topic-root tier → the
   * conversation's single root (tak_version 0); a per-epoch tier → the current
   * epoch TAK (tak_version = epoch), which is cached as a side effect so it can
   * be granted later (the exporter secret is gone once the epoch advances).
   *
   * The branch ASKS `chatTierPolicy` rather than restating it. It used to test
   * `visibility === 'public'`, which is the same thing for three of the four
   * tiers and wrong for the fourth: a DM's row says `'secret'`, so DMs fell into
   * the per-epoch branch while the policy declared them topic-root, and the key
   * that sealed a DM never left the device that minted it.
   */
  private async currentArchiveKey(
    topicId: string,
    tier: ChatTier,
  ): Promise<{ key: Uint8Array | null; takVersion: number; rootState: ArchiveRootState | null }> {
    if (usesTopicRootKey(tier)) {
      const r = await this.resolveRoot(topicId, tier);
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
    tier: ChatTier,
  ): Promise<ArchiveResult> {
    const { key, takVersion, rootState } = await this.currentArchiveKey(topicId, tier);
    if (!key) return { archived: false, rootState };
    await this.transport.postArchive(topicId, messageId, takVersion, await tak.sealArchive(key, messageId, plaintext));
    return { archived: true, rootState };
  }

  /**
   * Encrypt an attached FILE for a topic (R-3), under the same key and the same
   * derivation `archiveOnSend` uses for the message body.
   *
   * Returns null when this device holds no key it may seal under — a public
   * topic whose root is not verified yet. Sending the picture in the clear
   * instead is exactly the defect this closes, so the caller must surface the
   * failure rather than fall back.
   */
  async sealMedia(
    topicId: string,
    mediaId: string,
    plaintext: Uint8Array,
    tier: ChatTier,
  ): Promise<{ ciphertext: Uint8Array; takVersion: number } | null> {
    const { key, takVersion } = await this.currentArchiveKey(topicId, tier);
    if (!key) return null;
    return { ciphertext: await tak.sealMediaBytes(key, mediaId, plaintext), takVersion };
  }

  /**
   * Decrypt an attachment sealed by `sealMedia`.
   *
   * The two failures are deliberately distinguished, because they mean opposite
   * things to the reader: `no-key` is "this device was not in the room yet, the
   * key may still arrive" — the same archive-locked state history has — while
   * `decrypt` is "the bytes are not what the message says they are", which no
   * amount of waiting fixes. Key selection mirrors `backfill`: a public topic
   * tries the resolved root and then this device's orphan root, a scoped tier
   * uses the epoch TAK the envelope names.
   */
  async openMedia(
    topicId: string,
    mediaId: string,
    takVersion: number,
    sealed: Uint8Array,
    tier: ChatTier,
  ): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; reason: 'no-key' | 'decrypt' }> {
    const candidates =
      usesTopicRootKey(tier)
        ? ([(await this.resolveRoot(topicId, tier)).key, await this.getOrphanRoot(topicId)].filter(Boolean) as Uint8Array[])
        : ([await this.epochTakForRead(topicId, takVersion)].filter(Boolean) as Uint8Array[]);
    if (candidates.length === 0) return { ok: false, reason: 'no-key' };
    for (const key of candidates) {
      const pt = await tak.openMediaBytes(key, mediaId, sealed);
      if (pt != null) return { ok: true, bytes: pt };
    }
    return { ok: false, reason: 'decrypt' };
  }

  /**
   * The epoch TAK for READING, deriving the CURRENT one if it is not cached.
   *
   * Caching alone was not enough, and only a two-device round trip showed why:
   * a device caches an epoch TAK when it SENDS (that is what `currentArchiveKey`
   * does) or when it is granted one. A member who joined and has not yet sent
   * anything has neither — so an attachment posted in the epoch they are sitting
   * in came back `no-key`, and the reader was told "this device has no key for
   * it" about a message they were perfectly entitled to read.
   *
   * Deriving is only possible for the CURRENT epoch (MLS discards past key
   * schedules), which is exactly the case that was broken; older epochs still
   * depend on the cache or a grant, as they must.
   */
  private async epochTakForRead(topicId: string, takVersion: number): Promise<Uint8Array | null> {
    const cached = await this.getEpochTak(topicId, takVersion);
    if (cached) return cached;
    try {
      const epoch = await this.mls.readState(topicId, async (s) => gc.currentEpoch(s));
      if (epoch !== takVersion) return null; // a past epoch: cache or grant only
      const derived = await this.mls.readState(topicId, (s) => tak.deriveEpochTak(s, topicId, epoch));
      await this.setEpochTak(topicId, epoch, derived);
      return derived;
    } catch {
      return null; // no group state here yet
    }
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
  async sealForPush(topicId: string, plaintext: string, tier: ChatTier): Promise<PushPreviewSeal | null> {
    try {
      const { key, takVersion } = await this.currentArchiveKey(topicId, tier);
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
  async takForPush(topicId: string, tier: ChatTier): Promise<Omit<PushPreviewSeal, 'ct'> | null> {
    try {
      const { key, takVersion } = await this.currentArchiveKey(topicId, tier);
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
   * Wrap the archive root to EVERY current member leaf and upload the bundles,
   * so any member — including one who joined later, and including another device
   * of the sender — can read all of the archive. Returns how many were sent.
   *
   * The ONLY route by which a DM's key travels, and the second route for a
   * public topic (whose members can also just fetch it from the server). See
   * `chatTierPolicy`'s `'peer-device'` delivery.
   *
   * REFUSES (returns 0) unless our root is verified. This is the blast radius
   * that made the defect catastrophic rather than local: the holder lease is
   * only 900s and is renewed only while someone has the chat open, so a device
   * holding an orphan root could easily win the lease and push that root to
   * every member — overwriting the real one everywhere at once.
   */
  /**
   * Distribute the root ONLY when the group has changed since we last did.
   *
   * Distribution used to run just once, when a device entered the chat and won
   * the holder lease. A device that joined the group a minute later got nothing
   * — the distributor had already sent to the only leaf that existed then, and
   * nothing re-ran. It stayed locked out of history until some other device
   * happened to open the chat again. That was reproducible on a topic created
   * minutes earlier, on fully fixed clients.
   *
   * A new leaf always advances the MLS epoch, so the epoch IS the "membership
   * changed" signal. Keying on it lets callers fire this on every incoming
   * event: unchanged epoch costs one sync and returns, while a real join
   * triggers exactly one round of bundles instead of a duplicate per event.
   */
  async distributeRootWhenGroupChanged(topicId: string, tier: ChatTier): Promise<number> {
    await this.mls.sync(topicId);
    let epoch: number;
    try {
      epoch = await this.mls.readState(topicId, async (s) => gc.currentEpoch(s));
    } catch {
      return 0; // no group state here yet — nothing to distribute from
    }
    if (this.lastDistributedEpoch.get(topicId) === epoch) return 0;
    const n = await this.distributeRoot(topicId, tier);
    // Recorded even when nothing was sent: without a verified root this device
    // cannot serve THIS epoch at all, and retrying every event would only spin.
    this.lastDistributedEpoch.set(topicId, epoch);
    return n;
  }

  async distributeRoot(topicId: string, tier: ChatTier): Promise<number> {
    if (!usesTopicRootKey(tier)) return 0; // per-epoch tiers grant epochs, not a root
    // Catch up first so we see every current member's leaf — a holder whose
    // history decrypted from cache never MLS-opened, so its tree could be stale.
    await this.mls.sync(topicId);
    const resolved = await this.resolveRoot(topicId, tier);
    if (resolved.state !== 'verified' || !resolved.key) return 0;
    /*
     * `tier: 'public'` is the BUNDLE's discriminant — "this carries a whole-topic
     * root" as opposed to `'scoped'`, which carries a set of epoch keys — and not
     * the topic's tier. A DM's root travels in the same envelope. Renaming the
     * wire field would strand bundles already in flight for no gain.
     */
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
  /**
   * The room as this device last rendered it, in ONE read.
   *
   * `mlsSession.openCached` also holds plaintext, but keyed per MESSAGE — and
   * the store it sits behind decrypts every value it returns, so restoring
   * fifty rows costs fifty reads and fifty AES opens before anything paints.
   * This record is the whole room, so it costs one of each.
   *
   * Returns null on a miss, an unreadable store, or a first visit. A room that
   * cannot read its cache is a room that fetches, which is what it did before.
   */
  async readHistoryCache(topicId: string): Promise<CachedChatHistory | null> {
    return readChatHistory(this.historyStore, topicId);
  }

  /**
   * Remember the room as rendered, so the next entry can paint before it asks
   * the network anything.
   *
   * The cursor is left as it was: it belongs to the ARCHIVE walk in `backfill`
   * and says which sealed rows have been opened. Messages that arrived live
   * have not moved it, and advancing it here would tell the next backfill to
   * skip rows it has never read.
   */
  async writeHistoryCache(topicId: string, messages: CachedChatMessage[]): Promise<void> {
    const existing = await readChatHistory(this.historyStore, topicId);
    await writeChatHistory(
      this.historyStore,
      topicId,
      mergeChatHistory([...(existing?.messages ?? []), ...messages]),
      existing?.cursor ?? null,
    );
  }

  async backfill(topicId: string, tier: ChatTier): Promise<Array<{ messageId: string; plaintext: string }>> {
    await this.ingestBundles(topicId);

    /*
     * WHAT THIS DEVICE ALREADY OPENED, before asking the server for anything.
     *
     * A cached room contributes two things: the plaintext, which never has to
     * be decrypted twice, and a cursor, which turns the archive read from "the
     * whole conversation" into "whatever arrived since". Without it this method
     * paged the entire archive out of the server on EVERY room entry and
     * re-decrypted every row — a million-message room cost two thousand round
     * trips and a million opens to show the same screen as last time.
     *
     * Nothing here can fail the room: a cache miss, an unreadable store and a
     * first-ever visit are the same answer, and that answer is the behaviour
     * this method has always had.
     */
    const cached = await readChatHistory(this.historyStore, topicId);
    const rows = await this.transport.getArchive(topicId, cached?.cursor ?? undefined);
    /*
     * RESOLVE the public root, do not merely read the stored one.
     *
     * Reading storage alone meant a device that opened a room and called this
     * first — before anything had asked `archiveRootState` — decrypted nothing
     * and showed an empty conversation, because the root was sitting on the
     * server unfetched. Resolving is idempotent and cached, so the common case
     * where it is already local costs nothing.
     *
     * The orphan root comes second: rows this device sealed under a key that
     * lost a deposit race are unreadable to everyone else, but there is no
     * reason to hide them from the device that wrote them.
     */
    const rootKeys = usesTopicRootKey(tier)
      ? ([(await this.resolveRoot(topicId, tier)).key, await this.getOrphanRoot(topicId)].filter(
          Boolean,
        ) as Uint8Array[])
      : [];
    const opened: CachedChatMessage[] = [];
    /*
     * The cursor may only cross rows this device actually READ, and only in an
     * unbroken run from the front.
     *
     * A row can arrive that cannot be opened yet — an epoch this device was not
     * present for, a root that has not been distributed — and those rows are the
     * whole reason the archive is re-read at all. Advancing past one would skip
     * it on every future visit, so it would never be decrypted, and the message
     * would sit locked forever while the key it was waiting for sat on disk.
     * A run that stops early costs one re-fetch of rows already opened; a run
     * that runs past a gap costs the message.
     */
    let contiguous: { messageId: string; createdAt: string } | null = null;
    let runIntact = true;
    for (const r of rows) {
      let plaintext: string | null = null;
      const keys = usesTopicRootKey(tier) ? rootKeys : [await this.epochTakForRead(topicId, r.takVersion)];
      for (const key of keys) {
        if (!key) continue;
        const pt = await tak.openArchive(key, r.messageId, r.ciphertext);
        if (pt != null) {
          plaintext = pt;
          break;
        }
      }
      if (plaintext == null) {
        runIntact = false;
        continue;
      }
      opened.push({ id: r.messageId, createdAt: r.createdAt, plaintext });
      if (runIntact) contiguous = { messageId: r.messageId, createdAt: r.createdAt };
    }

    /*
     * Merge, then write back — cached first so a freshly opened copy of the same
     * id wins, which is what `writeChatHistory` de-duplicates to.
     *
     * The cursor advances only over rows that were actually READ, not over rows
     * that were fetched. A row this device cannot open yet — an epoch it was not
     * present for, a root that has not arrived — must stay in front of the
     * cursor, or the next visit skips past it and it is never decrypted at all.
     */
    // Through the same rule that stores them: concatenation alone hands the
    // caller duplicates in the wrong order while the stored copy is correct.
    const merged = mergeChatHistory([...(cached?.messages ?? []), ...opened]);
    if (opened.length > 0) {
      const advanced = cursorFrom(contiguous ? [contiguous] : []);
      await writeChatHistory(this.historyStore, topicId, merged, advanced ?? cached?.cursor ?? null);
    }

    return merged.map((m) => ({ messageId: m.id, plaintext: m.plaintext }));
  }

  /**
   * Archive messages this device can read that never made it into the archive.
   *
   * `archiveOnSend` runs once, at send time, and does nothing when the root is
   * not verified yet — offline, a server hiccup, or simply a device that has not
   * received the topic root. There was no second chance: the message stayed out
   * of the archive forever, so every device that joined later was missing it,
   * and nothing anywhere reported a problem. A gap is silent in a way corruption
   * is not.
   *
   * Idempotent and uncoordinated by design. `chat_archive` is unique on
   * (topic_id, message_id) and the route ignores conflicts, so several members
   * running this at once converge on one row instead of fighting. Best-effort:
   * it returns how many rows it added and never throws into chat.
   */
  async backfillMissingArchive(
    topicId: string,
    tier: ChatTier,
    readable: Array<{ messageId: string; plaintext: string }>,
  ): Promise<number> {
    if (readable.length === 0) return 0;
    // Same gate as sending: only a VERIFIED root may seal. A device that would
    // write rows nobody can open must not be the one to fill gaps.
    const { key, takVersion } = await this.currentArchiveKey(topicId, tier);
    if (!key) return 0;

    let archived: Set<string>;
    try {
      archived = new Set((await this.transport.getArchive(topicId)).map((r) => r.messageId));
    } catch {
      // Never guess the archive is empty — that would re-upload everything on
      // every transient failure.
      return 0;
    }

    let added = 0;
    for (const m of readable) {
      if (archived.has(m.messageId)) continue;
      // Skip anything we could not actually read. Sealing a placeholder would
      // permanently occupy the one row that message gets.
      if (!m.plaintext) continue;
      try {
        await this.transport.postArchive(
          topicId,
          m.messageId,
          takVersion,
          await tak.sealArchive(key, m.messageId, m.plaintext),
        );
        added++;
      } catch {
        // One failure must not abandon the rest; the next pass retries it.
      }
    }
    return added;
  }
}
