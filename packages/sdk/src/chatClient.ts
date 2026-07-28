/**
 * High-level E2EE chat client for a Node SDK agent. Ties together:
 *   - OpenStoaClient  (typed REST, Bearer auth)
 *   - MlsSessionStore / TakSessionStore  (portable MLS + TAK crypto)
 *   - FileVaultStore  (self-custodied keys, per-topic, 0600)
 *
 * SI-1: all sealing/opening happens here, client-side. openstoa only ever
 * receives opaque MLS ciphertext + access-control metadata; plaintext and keys
 * never leave the process, and are never logged.
 *
 * Key layout (design mirrors webTransport.ts):
 *   - the device master_key lives (plaintext bytes) in the GLOBAL vault area;
 *   - every per-topic MLS state / TAK key / decrypted-message cache is sealed
 *     under HKDF(master_key,"local-store") via EncryptingKVStore before it hits
 *     disk, in a per-topic directory.
 */
import {
  MlsSessionStore,
  TakSessionStore,
  EncryptingKVStore,
  keyManager,
  type SecureKVStore,
  type Visibility,
  type SealedMessage,
} from './mls';
import { OpenStoaClient, type OpenStoaClientOptions } from './rest/openStoaClient';
import { mlsTransport, takTransport } from './rest/transports';
import { createFileVaultStore } from './keystore';

export interface ChatMessage {
  id: string;
  userId: string;
  nickname: string;
  isAI: boolean;
  createdAt: string;
  type: string;
  /** Decrypted body for user messages, or null if undecryptable (pre-join / gap). */
  text: string | null;
  /** System text for join/leave rows. */
  system: string | null;
}

export interface ChatClientOptions extends OpenStoaClientOptions {
  /**
   * Vault root (the `.openstoa` directory). Keys live under `<root>/vault`.
   * Defaults to `~/.openstoa`.
   */
  vaultRoot?: string;
  /**
   * Stable MLS device identity (the leaf credential). Persisted in the global
   * vault area on first use and reused thereafter, so restarts keep the same
   * leaf (and thus readable history). Auto-generated if omitted.
   */
  deviceId?: string;
  /** Reuse an existing OpenStoaClient instead of constructing one. */
  client?: OpenStoaClient;
}

interface TopicSession {
  mls: MlsSessionStore;
  tak: TakSessionStore;
}

const GLOBAL_DEVICE_KEY = 'device.id';

export class ChatClient {
  readonly rest: OpenStoaClient;
  private readonly vaultRoot?: string;
  private readonly globalStore: SecureKVStore;
  private deviceIdOverride?: string;
  private _deviceId: string | null = null;
  private _masterKey: Promise<Uint8Array> | null = null;
  private readonly sessions = new Map<string, TopicSession>();
  private readonly visibilityCache = new Map<string, Visibility>();

  constructor(opts: ChatClientOptions) {
    this.rest = opts.client ?? new OpenStoaClient(opts);
    this.vaultRoot = opts.vaultRoot;
    this.deviceIdOverride = opts.deviceId;
    // Global (unencrypted) area holds the master_key + stable device id (0600).
    this.globalStore = createFileVaultStore({ root: this.vaultRootDir(), namespace: undefined });
  }

  private vaultRootDir(): string | undefined {
    // createFileVaultStore expects the `.openstoa` dir; append `vault` there.
    return this.vaultRoot ? this.vaultRoot.replace(/\/$/, '') + '/vault' : undefined;
  }

  /** The device master_key (loaded/created once, memoized). */
  private masterKey(): Promise<Uint8Array> {
    if (!this._masterKey) this._masterKey = keyManager.loadOrCreateMasterKey(this.globalStore);
    return this._masterKey;
  }

  /** Resolve a STABLE device identity (persisted in the global vault area). */
  private async deviceId(): Promise<string> {
    if (this._deviceId) return this._deviceId;
    if (this.deviceIdOverride) {
      this._deviceId = this.deviceIdOverride;
      await this.globalStore.set(GLOBAL_DEVICE_KEY, this._deviceId).catch(() => {});
      return this._deviceId;
    }
    const saved = await this.globalStore.get(GLOBAL_DEVICE_KEY);
    if (saved) {
      this._deviceId = saved;
      return saved;
    }
    const id = `sdk-${crypto.randomUUID()}`;
    await this.globalStore.set(GLOBAL_DEVICE_KEY, id);
    this._deviceId = id;
    return id;
  }

  /** Build (once) the per-topic MLS + TAK session backed by an encrypted vault. */
  private async session(topicId: string): Promise<TopicSession> {
    let s = this.sessions.get(topicId);
    if (s) return s;
    const identity = await this.deviceId();
    // Per-topic directory; values sealed under the device master_key at rest.
    const raw = createFileVaultStore({ root: this.vaultRootDir(), namespace: topicId });
    const enc = EncryptingKVStore.lazy(raw, () => this.masterKey());
    const mls = new MlsSessionStore(mlsTransport(this.rest), identity, enc, enc);
    const tak = new TakSessionStore(mls, takTransport(this.rest), enc);
    s = { mls, tak };
    this.sessions.set(topicId, s);
    return s;
  }

  private async visibility(topicId: string): Promise<Visibility> {
    const cached = this.visibilityCache.get(topicId);
    if (cached) return cached;
    let v: Visibility = 'public';
    try {
      const topic = await this.rest.topics.get(topicId);
      if (topic.visibility === 'private' || topic.visibility === 'secret' || topic.visibility === 'public') {
        v = topic.visibility;
      }
    } catch {
      /* default to public if the topic lookup fails */
    }
    this.visibilityCache.set(topicId, v);
    return v;
  }

  // -------------------------------------------------------------------------
  // public API
  // -------------------------------------------------------------------------

  /** dev-login (dev/staging) → sets the Bearer on the REST client. */
  async login(nickname?: string): Promise<{ userId: string; nickname: string; token: string }> {
    return this.rest.auth.devLogin(nickname);
  }

  /** Adopt an already-obtained token (e.g. from the AI proof flow). */
  useToken(token: string): void {
    this.rest.setToken(token);
  }

  /** This client's stable MLS device identity. */
  getDeviceId(): Promise<string> {
    return this.deviceId();
  }

  /**
   * Join a topic: REST membership + MLS self-join (External Commit or genesis).
   * The MLS leaf/keys are persisted in the per-topic vault. Idempotent — a repeat
   * call just catches the local leaf up to the latest epoch.
   */
  async joinTopic(topicId: string): Promise<void> {
    try {
      await this.rest.topics.join(topicId);
    } catch (err) {
      // Already a member (or creator) → membership is fine; keep going to MLS.
      // Re-throw anything that isn't an idempotent-join conflict.
      const status = (err as { status?: number }).status;
      if (status !== 200 && status !== 201 && status !== 409 && status !== 400) throw err;
    }
    const { mls } = await this.session(topicId);
    // sync() forces bootstrap (genesis if first, else External-Commit join) and
    // catches up to the latest epoch. Persists the leaf in the vault.
    await mls.sync(topicId);
  }

  /**
   * Seal `text` under MLS, POST the ciphertext, cache the plaintext locally (so
   * this sender can re-read its own message later), and archive it under the
   * topic's TAK so later members can back-fill it. Returns the server message id.
   */
  async sendChat(topicId: string, text: string, opts: { archive?: boolean; visibility?: Visibility } = {}): Promise<string> {
    const { mls, tak } = await this.session(topicId);
    const sealed: SealedMessage = await mls.seal(topicId, text);
    const row = await this.rest.chat.send(topicId, { ciphertext: sealed.ciphertext, epoch: sealed.epoch });
    // The MLS sender cannot decrypt its OWN application message — cache the
    // plaintext under the server id so readChat surfaces it after a restart.
    await mls.cachePlaintext(topicId, row.id, text);
    if (opts.archive !== false) {
      const visibility = opts.visibility ?? (await this.visibility(topicId));
      try {
        await tak.archiveOnSend(topicId, row.id, text, visibility);
      } catch {
        /* archiving is best-effort durability; a failure never fails the send */
      }
    }
    return row.id;
  }

  /**
   * Fetch chat history and MLS-decrypt each sealed body (cached per message id so
   * history survives forward-secrecy key deletion + restarts). Undecryptable rows
   * (pre-join epochs) surface with `text: null` — use `backfill` for those.
   */
  async readChat(topicId: string, opts: { limit?: number; since?: string; before?: string } = {}): Promise<ChatMessage[]> {
    const { mls } = await this.session(topicId);
    const { messages } = await this.rest.chat.history(topicId, opts);
    const out: ChatMessage[] = [];
    for (const r of messages) {
      let text: string | null = null;
      if (r.sealed) {
        text = await mls.openCached(topicId, r.id, {
          ciphertext: r.sealed.ciphertext,
          epoch: r.sealed.epoch,
          takVersion: r.sealed.takVersion,
        });
      }
      out.push({
        id: r.id,
        userId: r.userId,
        nickname: r.nickname,
        isAI: r.isAI,
        createdAt: typeof r.createdAt === 'string' ? r.createdAt : String(r.createdAt),
        type: r.type,
        text,
        system: r.message,
      });
    }
    return out;
  }

  /**
   * Back-fill history via the TAK archive: ingest any bundles addressed to this
   * device, then decrypt every archive row we hold a key for. Returns the
   * decrypted bodies keyed by original message id (rows out of scope are omitted).
   */
  async backfill(topicId: string, opts: { visibility?: Visibility } = {}): Promise<Array<{ messageId: string; plaintext: string }>> {
    const { tak } = await this.session(topicId);
    const visibility = opts.visibility ?? (await this.visibility(topicId));
    return tak.backfill(topicId, visibility);
  }

  /**
   * Public-topic holder action: wrap the archive root to every current member
   * leaf so any member (including later joiners) can read all archived history.
   * Returns the number of bundles sent.
   */
  async distributePublicArchive(topicId: string): Promise<number> {
    const { tak } = await this.session(topicId);
    return tak.distributePublicRoot(topicId);
  }

  /** Low-level access to the per-topic MLS/TAK stores (advanced flows: AI grants, removal). */
  async topicSession(topicId: string): Promise<TopicSession> {
    return this.session(topicId);
  }
}
