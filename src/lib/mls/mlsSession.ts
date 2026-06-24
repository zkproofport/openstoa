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
  ) {}

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
        else await this.store.set('mls.identity', this.identity);
      } catch {
        /* fall through with the in-memory identity */
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
      // Advance to the latest epoch first so we never seal under a stale epoch
      // that newer members can't read (until live commit SSE lands, this is the
      // sync point). Best-effort: a transient catch-up failure still lets the
      // send proceed at the current epoch.
      try {
        await this.catchUp(topicId, s);
      } catch {
        /* seal at current epoch */
      }
      const r = await gc.sealMessage(s.state, plaintext);
      s.state = r.state;
      await this.persist(topicId, s);
      return r.sealed;
    });
  }

  /**
   * Open a sealed message, catching up on missed commits first if the message
   * is from a later epoch. Returns null when the body can't be decrypted (e.g.
   * a pre-join epoch — forward secrecy; Phase 3 TAK back-fills history).
   */
  open(topicId: string, sealed: SealedMessage): Promise<string | null> {
    return this.withLock(topicId, async () => {
      const s = await this.getSession(topicId);
      try {
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
    if (this.msgCache) {
      try {
        const cached = await this.msgCache.get(this.msgKey(topicId, msgId));
        if (cached != null) return cached;
      } catch {
        /* cache miss/unreadable → decrypt below */
      }
    }
    const plaintext = await this.open(topicId, sealed);
    if (plaintext != null && this.msgCache) {
      try {
        await this.msgCache.set(this.msgKey(topicId, msgId), plaintext);
      } catch {
        /* best-effort cache write */
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
}
