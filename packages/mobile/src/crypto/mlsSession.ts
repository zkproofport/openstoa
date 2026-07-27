/**
 * MLS session manager — mobile copy (identical logic to the web copy at
 * openstoa/src/lib/mls/mlsSession.ts). Transport is injected so the mobile
 * mini-app supplies a transport over the host's authenticated OpenStoaClient.
 * An optional SecureKVStore (Keychain/Keystore via the host) persists the live
 * ClientState so an app restart restores the SAME leaf instead of re-joining as
 * a new one (a re-join lost all pre-restart history). Without a store it keeps
 * state in memory only. Keep in sync with the web copy.
 */
import * as gc from './groupClient';
import type { SealedMessage } from './groupClient';

export interface CommitLogEntry {
  epoch: number;
  commit: string;
  welcome: string | null;
}

export interface MlsTransport {
  getGroupInfo(topicId: string): Promise<string | null>;
  postGroupInfo(topicId: string, groupInfoB64: string, groupIdB64: string): Promise<boolean>;
  postCommit(topicId: string, commitB64: string, groupInfoB64: string): Promise<{ ok: boolean; epoch?: number }>;
  getCommitsSince(topicId: string, sinceEpoch: number): Promise<CommitLogEntry[]>;
}

/**
 * Durable key→value store for persisting the live MLS ClientState across app
 * restarts. On mobile this is backed by the host's secure store
 * (Keychain/Keystore). Optional — without it state is in-memory only.
 */
export interface SecureKVStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

interface Session {
  // Set only on a fresh bootstrap; undefined when restored from persistence.
  // Nothing past bootstrap reads it — `state` carries the leaf keys.
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
    // Local plaintext cache for already-decrypted messages (AsyncStorage via the
    // host). Separate from `store` (MLS keys in Keychain) — see openCached.
    private msgCache?: SecureKVStore,
  ) {}

  private msgKey(topicId: string, msgId: string): string {
    return `mls.msg.${topicId}.${msgId}`;
  }

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
    // key. The mobile identity is otherwise random per launch, so the state key
    // would differ every restart → restore never matches → always re-joins as a
    // new leaf, dropping history. Persist the first identity and reuse it.
    if (this.store) {
      try {
        const savedId = await this.store.get('mls.identity');
        if (savedId) this.identity = savedId;
        else await this.store.set('mls.identity', this.identity);
      } catch {
        /* fall through with the in-memory identity */
      }
    }

    // Restore the persisted leaf if present → same identity/epoch across
    // restarts (no re-join), so prior history stays readable.
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
        const g = await gc.createTopicGroup(topicId, device);
        const created = await this.transport.postGroupInfo(topicId, g.groupInfoB64, groupIdB64);
        if (created) {
          const sess: Session = { device, state: g.state };
          await this.persist(topicId, sess);
          return sess;
        }
        continue;
      }
      const j = await gc.joinTopicGroup(device, giB64);
      const res = await this.transport.postCommit(topicId, j.commitB64, j.groupInfoB64);
      if (res.ok) {
        const sess: Session = { device, state: j.state };
        await this.persist(topicId, sess);
        return sess;
      }
    }
    throw new Error(`MLS bootstrap failed for topic ${topicId} after ${BOOTSTRAP_RETRIES} attempts`);
  }

  private async catchUp(topicId: string, s: Session): Promise<void> {
    const commits = await this.transport.getCommitsSince(topicId, gc.currentEpoch(s.state));
    for (const c of commits) {
      if (c.epoch <= gc.currentEpoch(s.state)) continue;
      s.state = await gc.processCommit(s.state, c.commit);
    }
  }

  seal(topicId: string, plaintext: string): Promise<SealedMessage> {
    return this.withLock(topicId, async () => {
      const s = await this.getSession(topicId);
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
        return null;
      }
    });
  }

  /**
   * Open a sealed message with a local plaintext cache keyed by message id.
   * MLS deletes each per-message key on decryption (forward secrecy), so a
   * message can be MLS-decrypted only ONCE; on a later load (or after an app
   * restart) the key is gone. Caching the decrypted plaintext lets message
   * HISTORY survive restarts: cached id → return it; else MLS-open once + cache.
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
   * own message, so without this the user's own messages show as undecryptable
   * after a restart. Call with the server message id right after a send.
   */
  async cachePlaintext(topicId: string, msgId: string, plaintext: string): Promise<void> {
    if (!this.msgCache) return;
    try {
      await this.msgCache.set(this.msgKey(topicId, msgId), plaintext);
    } catch {
      /* best-effort */
    }
  }

  /** Catch up to the latest epoch (TAK holder calls this before reading leaves). */
  sync(topicId: string): Promise<void> {
    return this.withLock(topicId, async () => {
      const s = await this.getSession(topicId);
      await this.catchUp(topicId, s);
      await this.persist(topicId, s);
    });
  }

  /** Run `fn` with the live group state under the topic lock (TAK layer reads). */
  readState<T>(topicId: string, fn: (state: gc.GroupState) => Promise<T>): Promise<T> {
    return this.withLock(topicId, async () => {
      const s = await this.getSession(topicId);
      return fn(s.state);
    });
  }

  applyCommit(topicId: string, commitB64: string): Promise<void> {
    return this.withLock(topicId, async () => {
      const s = await this.getSession(topicId);
      try {
        s.state = await gc.processCommit(s.state, commitB64);
      } catch {
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
}
