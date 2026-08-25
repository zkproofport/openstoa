/**
 * Browser MLS session manager: keeps a live ts-mls group state per topic and
 * drives the join/commit/catch-up handshake against the Delivery Service.
 *
 * Transport is injected so the same logic is unit-tested in node against an
 * in-memory DS and runs in the browser against the real REST endpoints. An
 * optional SecureKVStore persists the live ClientState (IndexedDB on web,
 * Keychain/Keystore on mobile) so an app restart restores the SAME leaf instead
 * of re-joining as a new one (a re-join lost all pre-restart history). Without
 * a store it degrades to the previous in-memory behavior.
 *
 * Bootstrap is self-service (External Commit): restore persisted state → else
 * GET group-info → if present, join; if absent, genesis (POST group-info,
 * idempotent). Genesis races and concurrent-join epoch conflicts are resolved
 * by re-fetching and retrying (client side of SI-2 liveness). All per-topic
 * operations are serialized so state mutations never interleave.
 */
import * as gc from './groupClient';
import type { SealedMessage } from './groupClient';
import { leafIdentity, userIdOfLeaf } from './leafIdentity';

export interface CommitLogEntry {
  epoch: number;
  commit: string;
  welcome: string | null;
}

export interface MlsTransport {
  /** base64 GroupInfo, or null on 404 (no group yet). */
  getGroupInfo(topicId: string): Promise<string | null>;
  /** Register genesis GroupInfo; returns true if this call created the row. */
  postGroupInfo(topicId: string, groupInfoB64: string, groupIdB64: string): Promise<boolean>;
  /** Submit a Commit; ok=false means epoch-CAS conflict (rebase + retry). */
  postCommit(topicId: string, commitB64: string, groupInfoB64: string): Promise<{ ok: boolean; epoch?: number }>;
  /** Catch-up: commits with epoch > sinceEpoch, ascending. */
  getCommitsSince(topicId: string, sinceEpoch: number): Promise<CommitLogEntry[]>;
}

/**
 * Durable key→value store for persisting the live MLS ClientState across app
 * restarts. Backends: IndexedDB (web), Keychain/Keystore via the host (mobile).
 * Optional — without it the manager keeps state in memory only (re-join on
 * restart, the prior behavior).
 */
export interface SecureKVStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

interface Session {
  // Set only on a fresh bootstrap (genesis/join); undefined when restored from
  // persistence. Nothing past bootstrap reads it — `state` carries the leaf keys.
  device?: gc.Device;
  state: gc.GroupState;
}

const BOOTSTRAP_RETRIES = 8;

function b64(u: Uint8Array): string {
  let s = '';
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return btoa(s);
}

export class MlsSessionStore {
  private sessions = new Map<string, Promise<Session>>();
  private locks = new Map<string, Promise<unknown>>();

  constructor(
    private transport: MlsTransport,
    private identity: string,
    private store?: SecureKVStore,
    // Local plaintext cache for already-decrypted messages (IndexedDB on web,
    // AsyncStorage via host on mobile). Separate from `store` (MLS keys) — see
    // openCached. Bulk + less sensitive, so NOT the Keychain/secure store.
    private msgCache?: SecureKVStore,
    /**
     * The signed-in account, resolved lazily because the store is constructed
     * before the session lookup has answered.
     *
     * It names the leaf: a credential is `<userId>:<deviceId>` so that removing
     * a person can find every device they own. Absent (guest, or the lookup
     * failed) the leaf falls back to the bare device id, which still works for
     * chat and is simply not attributable — see `leafIdentity.ts`.
     */
    private userIdProvider?: () => Promise<string | null>,
  ) {}

  /**
   * Plaintext this process has already opened, by `msgKey`.
   *
   * In memory only, and deliberately: it is a memo over the durable cache, not
   * a second copy of it. Nothing here survives a restart, and nothing needs to
   * — the store below does that.
   */
  private readonly plaintextMemo = new Map<string, string>();

  private msgKey(topicId: string, msgId: string): string {
    return `mls.msg.${topicId}.${msgId}`;
  }

  /** Serialize all operations for a topic so group-state mutations don't race. */
  private withLock<T>(topicId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(topicId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.locks.set(topicId, next.then(() => {}, () => {}));
    return next;
  }

  private getSession(topicId: string): Promise<Session> {
    let s = this.sessions.get(topicId);
    if (!s) {
      s = this.bootstrap(topicId);
      // On failure, drop the memo so a later call can retry from scratch.
      s.catch(() => this.sessions.delete(topicId));
      this.sessions.set(topicId, s);
    }
    return s;
  }

  private stateKey(topicId: string): string {
    return `mls.state.${this.identity}.${topicId}`;
  }

  /** Best-effort persist of the live state; a storage failure must not break chat. */
  private async persist(topicId: string, s: Session): Promise<void> {
    if (!this.store) return;
    try {
      await this.store.set(this.stateKey(topicId), gc.serializeState(s.state));
    } catch {
      /* persistence failure degrades to a re-join on the next restart */
    }
  }

  /**
   * The credential this device publishes the FIRST time it joins anything:
   * `<userId>:<deviceId>`, so a later removal can find every leaf an account
   * owns.
   *
   * Minted once and persisted. Changing it afterwards would orphan the stored
   * group state (the state key is derived from it) and re-join every topic as a
   * fresh leaf, so a device that already has an identity keeps it — including
   * the bare-device-id form that predates this. Those legacy leaves are simply
   * not attributable, which `removeUser` reports rather than papers over.
   *
   * A guest or a failed session lookup also yields the bare device id. Chat
   * works either way; only attribution is lost, and inventing a user id here
   * would be worse than losing it.
   */
  /**
   * The signed-in account, or null when nothing has told us.
   *
   * Exposed so on-device caches can be namespaced by account. They cannot ask
   * the provider themselves — it is supplied by the wiring layer, and a second
   * copy of that wiring is a second place for the two to disagree about who is
   * signed in.
   */
  async accountId(): Promise<string | null> {
    if (!this.userIdProvider) return null;
    try {
      return (await this.userIdProvider()) || null;
    } catch {
      return null;
    }
  }

  private async mintIdentity(): Promise<string> {
    if (!this.userIdProvider) return this.identity;
    try {
      const userId = await this.userIdProvider();
      return userId ? leafIdentity(userId, this.identity) : this.identity;
    } catch {
      return this.identity;
    }
  }

  private async bootstrap(topicId: string): Promise<Session> {
    // Resolve a STABLE device identity (persisted) before deriving the state
    // key. Otherwise a client that generates a fresh identity per launch (the
    // mobile case) produces a different state key every restart → restore never
    // matches → it always re-joins as a new leaf, dropping history. Persist the
    // first identity and reuse it thereafter.
    if (this.store) {
      try {
        const savedId = await this.store.get('mls.identity');
        if (savedId) this.identity = savedId;
        else await this.store.set('mls.identity', await this.mintIdentity());
      } catch {
        /* fall through with the in-memory identity */
      }
      // Re-read rather than trusting what we just wrote: on the write path the
      // mint result is the identity, but a concurrent bootstrap may have won,
      // and two leaves for one device is exactly what persisting it prevents.
      try {
        const id = await this.store.get('mls.identity');
        if (id) this.identity = id;
      } catch {
        /* keep whatever we have */
      }
    }

    // Restore the persisted leaf if present → keep the same MLS identity/epoch
    // across restarts (no re-join), so previously-decryptable history stays
    // readable. Falls through to a fresh bootstrap on miss or restore failure.
    if (this.store) {
      try {
        const saved = await this.store.get(this.stateKey(topicId));
        if (saved) return { state: gc.deserializeState(saved) };
      } catch {
        /* corrupt/unreadable persisted state → fresh bootstrap below */
      }
    }

    const device = await gc.createDevice(this.identity);
    const groupIdB64 = b64(gc.topicGroupId(topicId));

    for (let attempt = 0; attempt < BOOTSTRAP_RETRIES; attempt++) {
      const giB64 = await this.transport.getGroupInfo(topicId);

      if (giB64 == null) {
        // No group yet → try to be genesis.
        const g = await gc.createTopicGroup(topicId, device);
        const created = await this.transport.postGroupInfo(topicId, g.groupInfoB64, groupIdB64);
        if (created) {
          const sess: Session = { device, state: g.state };
          await this.persist(topicId, sess);
          return sess;
        }
        // Lost the genesis race — someone registered first; loop to join theirs.
        continue;
      }

      // Group exists → join via External Commit.
      const j = await gc.joinTopicGroup(device, giB64);
      const res = await this.transport.postCommit(topicId, j.commitB64, j.groupInfoB64);
      if (res.ok) {
        const sess: Session = { device, state: j.state };
        await this.persist(topicId, sess);
        return sess;
      }
      // epoch-CAS conflict: another commit landed between our GET and POST.
      // Re-fetch the advanced GroupInfo and rebuild our join (SI-2 liveness).
    }
    throw new Error(`MLS bootstrap failed for topic ${topicId} after ${BOOTSTRAP_RETRIES} attempts`);
  }

  /** Pull and apply any commits newer than our current epoch. */
  private async catchUp(topicId: string, s: Session): Promise<void> {
    const commits = await this.transport.getCommitsSince(topicId, gc.currentEpoch(s.state));
    for (const c of commits) {
      if (c.epoch <= gc.currentEpoch(s.state)) continue;
      s.state = await gc.processCommit(s.state, c.commit);
    }
  }

  /** Seal a plaintext into a sealed message for the current epoch. */
  seal(topicId: string, plaintext: string): Promise<SealedMessage> {
    return this.withLock(topicId, async () => {
      const s = await this.getSession(topicId);
      // Advance to the latest epoch first — until live commit SSE lands this is
      // the only sync point. A message sealed under a STALE epoch is
      // cryptographically undecryptable for every member who joined after that
      // epoch: silent, permanent data loss that surfaces as "[unable to
      // decrypt]" forever. So a catch-up failure FAILS THE SEND (the caller
      // keeps the draft and retries) instead of corrupting the conversation.
      await this.catchUp(topicId, s);
      const r = await gc.sealMessage(s.state, plaintext);
      s.state = r.state;
      await this.persist(topicId, s);
      return r.sealed;
    });
  }

  /**
   * Open a sealed message, catching up on missed commits first if the message
   * is from a later epoch. Returns null when the body can't be decrypted (e.g.
   * a pre-join epoch — forward secrecy; Phase 3 TAK back-fills history) AND when
   * the session itself can't be established. Never rejects — see below.
   */
  open(topicId: string, sealed: SealedMessage): Promise<string | null> {
    return this.withLock(topicId, async () => {
      // getSession is INSIDE the try on purpose: a bootstrap/rejoin failure (DS
      // unreachable, unreadable key store) must return null like any other
      // undecryptable row, not reject. Callers map open/openCached over a whole
      // history page, so a rejection here blanks every sibling message. Safe to
      // swallow because nothing is persisted on this path and the next load
      // retries — unlike seal(), where failing soft would silently seal under a
      // stale epoch and permanently corrupt the conversation.
      try {
        const s = await this.getSession(topicId);
        if (sealed.epoch > gc.currentEpoch(s.state)) {
          await this.catchUp(topicId, s);
        }
        const r = await gc.openMessage(s.state, sealed);
        s.state = r.state;
        await this.persist(topicId, s);
        return r.kind === 'message' ? r.plaintext : null;
      } catch {
        return null; // undecryptable (pre-join / gap) — caller shows a placeholder
      }
    });
  }

  /**
   * Open a sealed message with a local plaintext cache keyed by message id.
   * MLS deletes each per-message key on decryption (forward secrecy), so a
   * message can be MLS-decrypted only ONCE — on any later load (a fresh list
   * fetch, or after an app restart) the key is gone and open() returns null.
   * Caching the decrypted plaintext lets message HISTORY survive restarts:
   * cached id → return it; otherwise MLS-open once and cache the result.
   * (Raising MLS key retention to re-decrypt would weaken forward secrecy.)
   */
  async openCached(topicId: string, msgId: string, sealed: SealedMessage): Promise<string | null> {
    const key = this.msgKey(topicId, msgId);

    /*
     * ALREADY OPEN? Then it is free.
     *
     * The store below is the durable half and it does its job: MLS is never
     * asked to decrypt the same message twice. But "cached" there still means a
     * read through `EncryptingKVStore`, which OPENS EVERY VALUE IT RETURNS —
     * so a hit costs one storage read and one AES open, per message. Leaving a
     * room and coming back paid that fifty times over before the first bubble
     * appeared, and that is what "why does it decrypt every time I open the
     * room" was describing. It was not MLS. It was this.
     *
     * The memo lives as long as the store singleton, which outlives the screen
     * — so the SECOND entry into a room does no work at all for rows the first
     * entry already opened. It is bounded because the durable cache behind it
     * is bounded: an entry only exists here if a message was rendered.
     */
    const memo = this.plaintextMemo.get(key);
    if (memo !== undefined) return memo;

    if (this.msgCache) {
      try {
        const cached = await this.msgCache.get(key);
        if (cached != null) {
          this.plaintextMemo.set(key, cached);
          return cached;
        }
      } catch {
        /* cache miss/unreadable → decrypt below */
      }
    }
    const plaintext = await this.open(topicId, sealed);
    if (plaintext != null) {
      this.plaintextMemo.set(key, plaintext);
      if (this.msgCache) {
        try {
          await this.msgCache.set(key, plaintext);
        } catch {
          /* best-effort cache write */
        }
      }
    }
    return plaintext;
  }

  /**
   * Cache a plaintext the local user just SENT. An MLS sender cannot decrypt its
   * own application message, so without this the user's own messages show as
   * undecryptable after a restart (the in-memory optimistic echo is gone). Call
   * this with the server-assigned message id right after a successful send.
   */
  async cachePlaintext(topicId: string, msgId: string, plaintext: string): Promise<void> {
    // The memo first and unconditionally: a message this device just SENT is
    // the one `openCached` can never derive, so if it misses here it pays a
    // storage read to find out there is nothing to find.
    this.plaintextMemo.set(this.msgKey(topicId, msgId), plaintext);
    if (!this.msgCache) return;
    try {
      await this.msgCache.set(this.msgKey(topicId, msgId), plaintext);
    } catch {
      /* best-effort */
    }
  }

  /**
   * Pull and apply any missed commits so the live state is at the latest epoch.
   * The TAK holder calls this before reading member leaves to distribute the
   * archive root — otherwise a holder whose history decrypted from cache (no MLS
   * open → no catch-up) would miss leaves added since it last synced.
   */
  sync(topicId: string): Promise<void> {
    return this.withLock(topicId, async () => {
      const s = await this.getSession(topicId);
      await this.catchUp(topicId, s);
      await this.persist(topicId, s);
    });
  }

  /**
   * Run `fn` with the live group state under the topic lock — the read accessor
   * the TAK archive layer uses to derive per-epoch keys and read verified leaf
   * keys from the ratchet tree (Phase 3). Serialized with seal/open/commit so it
   * never observes a torn mid-mutation state.
   */
  readState<T>(topicId: string, fn: (state: gc.GroupState) => Promise<T>): Promise<T> {
    return this.withLock(topicId, async () => {
      const s = await this.getSession(topicId);
      return fn(s.state);
    });
  }

  /** Apply an incoming Commit (live SSE fan-out). */
  applyCommit(topicId: string, commitB64: string): Promise<void> {
    return this.withLock(topicId, async () => {
      const s = await this.getSession(topicId);
      try {
        s.state = await gc.processCommit(s.state, commitB64);
      } catch {
        // Out-of-order/duplicate commit — reconcile via catch-up.
        await this.catchUp(topicId, s);
      }
      await this.persist(topicId, s);
    });
  }

  /**
   * Remove a member (by MLS credential identity) with a Remove Commit, advancing
   * the epoch so the removed device is excluded from every FUTURE epoch (D11
   * post-compromise security). Catches up to the latest epoch first, then posts
   * under epoch-CAS, rebasing on a 409 (another Commit landed between our read
   * and post). Returns the new current epoch. Throws if the identity is not a
   * current member. Callers pair this with the server grant DELETE for immediate
   * access-gating — already-delivered plaintext is not cryptographically
   * revocable.
   */
  removeMember(topicId: string, identity: string): Promise<number> {
    return this.withLock(topicId, async () => {
      const s = await this.getSession(topicId);
      for (let attempt = 0; attempt < BOOTSTRAP_RETRIES; attempt++) {
        await this.catchUp(topicId, s);
        const leafIndex = gc.findLeafIndexByIdentity(s.state, identity);
        if (leafIndex == null) throw new Error(`identity ${identity} is not a member of topic ${topicId}`);
        const r = await gc.removeMember(s.state, leafIndex);
        const res = await this.transport.postCommit(topicId, r.commitB64, r.groupInfoB64);
        if (res.ok) {
          s.state = r.state;
          await this.persist(topicId, s);
          return gc.currentEpoch(s.state);
        }
        // epoch-CAS conflict: another Commit landed; loop to catch up + rebuild.
      }
      throw new Error(`removeMember failed for topic ${topicId} after ${BOOTSTRAP_RETRIES} attempts`);
    });
  }

  /**
   * Drop this device's own group state for a topic it has left.
   *
   * `reconcileMembership` deliberately never touches the caller's own leaf, so
   * a leaver evicts nothing on the way out — another member's client does that.
   * What the leaver CAN do is stop holding the keys: nobody else can reach into
   * this device to delete them, and keeping a live ratchet for a room you left
   * is exactly the material a later compromise of this device would open.
   *
   * The store interface has no delete, so the value is blanked rather than
   * removed; an empty value fails to deserialize and falls through to a fresh
   * bootstrap, which is the same outcome. The in-memory session is dropped too,
   * or the very next send would keep using the state we just abandoned.
   */
  async forgetTopic(topicId: string): Promise<void> {
    this.sessions.delete(topicId);
    if (!this.store) return;
    try {
      await this.store.set(this.stateKey(topicId), '');
    } catch {
      /* best-effort: a storage failure must not block leaving */
    }
  }

  /**
   * Evict every leaf whose account is no longer a member of the topic.
   *
   * This is the primitive the three doors out actually run on. A kick, a leave
   * and an account deletion all end the same way — a membership row is gone —
   * and the crypto has to catch up. Making each door drive its own Remove
   * Commit puts the group's integrity on one client finishing one request: shut
   * the laptop mid-kick and the "removed" member keeps reading forever.
   *
   * Reconciling instead means ANY member's client repairs it on the next visit.
   * The server stays crypto-free (SI-1) and simply answers who the members are;
   * the tree is compared against that answer locally, so nothing here trusts a
   * server-supplied leaf index.
   *
   * Two kinds of leaf are deliberately left alone:
   *  - **our own**, because a client that removes itself can no longer commit,
   *    and self-removal is `leaveTopic`'s job where the state is torn down too;
   *  - **unattributable ones** (credentials predating `<userId>:<deviceId>`),
   *    because evicting a leaf we cannot name risks evicting a current member.
   *    They are counted and returned so a caller can surface the gap instead of
   *    reporting a clean sweep that was not clean.
   */
  reconcileMembership(
    topicId: string,
    memberUserIds: string[],
  ): Promise<{ epoch: number; removed: number; unattributable: number }> {
    const members = new Set(memberUserIds);
    return this.withLock(topicId, async () => {
      const s = await this.getSession(topicId);
      for (let attempt = 0; attempt < BOOTSTRAP_RETRIES; attempt++) {
        await this.catchUp(topicId, s);
        const leaves = gc.leafIdentities(s.state);
        let unattributable = 0;
        const strays: number[] = [];
        for (const leaf of leaves) {
          if (leaf.identity === this.identity) continue;
          const owner = userIdOfLeaf(leaf.identity);
          if (owner === null) {
            unattributable++;
            continue;
          }
          if (!members.has(owner)) strays.push(leaf.leafIndex);
        }
        // Nothing stale is the common case, and it must not burn an epoch.
        if (strays.length === 0) {
          return { epoch: gc.currentEpoch(s.state), removed: 0, unattributable };
        }
        const r = await gc.removeMembers(s.state, strays);
        const res = await this.transport.postCommit(topicId, r.commitB64, r.groupInfoB64);
        if (res.ok) {
          s.state = r.state;
          await this.persist(topicId, s);
          return { epoch: gc.currentEpoch(s.state), removed: strays.length, unattributable };
        }
        // epoch-CAS conflict: someone else committed — possibly this same
        // repair from another member's client. Loop and re-read the tree; the
        // indices we just resolved may name different devices in the new one.
      }
      throw new Error(`reconcileMembership failed for topic ${topicId} after ${BOOTSTRAP_RETRIES} attempts`);
    });
  }

  /**
   * Remove an ACCOUNT — every leaf it owns — in one Remove Commit.
   *
   * This is what a kick or a leave means. An account has a leaf per device, and
   * evicting one of three leaves evicts nobody: the other two keep deriving
   * every future epoch key and keep reading. So the unit is the account, and
   * the commit carries one Remove proposal per leaf.
   *
   * Returns the new epoch and how many leaves went with it — the caller wants
   * the count, because "removed 0 leaves" means the account's devices predate
   * the `<userId>:<deviceId>` credential and are NOT attributable. That is
   * reported, never silently treated as success.
   */
  removeUser(topicId: string, userId: string): Promise<{ epoch: number; removed: number }> {
    return this.withLock(topicId, async () => {
      const s = await this.getSession(topicId);
      for (let attempt = 0; attempt < BOOTSTRAP_RETRIES; attempt++) {
        await this.catchUp(topicId, s);
        const leaves = gc.findLeafIndicesByUser(s.state, userId);
        // Nothing to do is a real answer, and it must not burn an epoch. The
        // membership row is still deleted by the caller — the server-side gate
        // does not depend on this succeeding.
        if (leaves.length === 0) return { epoch: gc.currentEpoch(s.state), removed: 0 };
        const r = await gc.removeMembers(s.state, leaves);
        const res = await this.transport.postCommit(topicId, r.commitB64, r.groupInfoB64);
        if (res.ok) {
          s.state = r.state;
          await this.persist(topicId, s);
          return { epoch: gc.currentEpoch(s.state), removed: leaves.length };
        }
        // epoch-CAS conflict: another Commit landed. Loop — and re-read the
        // leaves rather than reusing them, because the indices we just resolved
        // may name different devices in the new tree.
      }
      throw new Error(`removeUser failed for topic ${topicId} after ${BOOTSTRAP_RETRIES} attempts`);
    });
  }
}
