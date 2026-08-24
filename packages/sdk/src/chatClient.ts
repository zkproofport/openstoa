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
  type SealedMessage,
} from './mls';
import { chatTierOf, usesTopicRootKey, type ChatTier } from './chatTierPolicy';
import { OpenStoaClient, type OpenStoaClientOptions } from './rest/openStoaClient';
import type { DmChannel } from './rest/types';
import { mlsTransport, takTransport } from './rest/transports';
import { createFileVaultStore } from './keystore';
import {
  loadEncryptedChatMedia,
  parseChatMediaBody,
  sendEncryptedChatMedia,
  type ChatMediaEnvelope,
} from './chatMedia';

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
  /**
   * A decrypted image attachment, when the message carried one.
   *
   * An agent used to receive the raw envelope (`openstoa:media:v1:{…}`) in
   * `text` where a person saw a photo — the bytes were reachable, but nothing
   * on this path fetched or opened them. Now `text` is null for an attachment
   * row and the picture arrives here, decrypted, in EVERY tier: `public` keys
   * come from the server-held root, `private`/`secret`/DM from the epoch TAK
   * the envelope names.
   *
   * `status` distinguishes the three failures a reader must tell apart:
   *   `locked`        — this device holds no key for it YET (a grant may arrive)
   *   `unavailable`   — the object is gone or not ours to fetch (404/403)
   *   `decrypt-failed`— the bytes are not what the envelope says they are
   */
  media?: {
    status: 'ok' | 'locked' | 'unavailable' | 'decrypt-failed';
    mime: string;
    bytes: Uint8Array | null;
  };
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
  private readonly tierCache = new Map<string, ChatTier>();

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

  /**
   * The signed-in account, or null when it cannot be resolved.
   *
   * This is what makes an agent's leaf ATTRIBUTABLE. A credential is
   * `<userId>:<deviceId>` so that removing a person can find every device they
   * own; without it the leaf is a bare `sdk-<uuid>`, `userIdOfLeaf` returns null
   * by design, and `reconcileMembership` — the only kick path any product
   * surface calls — counts it as unattributable and deliberately leaves it in
   * the tree. An agent nobody can name is an agent nobody can remove, and it
   * keeps deriving every future epoch key.
   *
   * Null on any failure rather than a guess: the leaf falls back to the bare
   * device id, which still works for chat and is simply not attributable.
   * Inventing a user id here would be worse than losing one. The route never
   * 401s — a guest gets `{ authenticated: false }` — so a missing `userId` is
   * the normal unauthenticated answer, not an error.
   */
  private async sessionUserId(): Promise<string | null> {
    try {
      const s = (await this.rest.auth.session()) as { userId?: string };
      return s?.userId ?? null;
    } catch {
      return null;
    }
  }

  /** Build (once) the per-topic MLS + TAK session backed by an encrypted vault. */
  private async session(topicId: string): Promise<TopicSession> {
    let s = this.sessions.get(topicId);
    if (s) return s;
    const identity = await this.deviceId();
    // Per-topic directory; values sealed under the device master_key at rest.
    const raw = createFileVaultStore({ root: this.vaultRootDir(), namespace: topicId });
    /*
     * `globalStore` is passed as the ROOT store so a read that fails under the
     * live key can fall back to the key this device used before its last
     * recovery, and re-seal as it goes.
     *
     * Web and mobile both wire this; the SDK did not, which made the fallback
     * inert — the same shape as the leaf-identity gap, where the ported code was
     * present and the caller never engaged it. It is behaviourally identical
     * today (no recovery path means no retired key means the lookup returns
     * null), and it is correct the moment one exists, which is exactly when
     * getting it wrong would silently destroy the group state and archive keys
     * of the one device that still held them.
     */
    const enc = EncryptingKVStore.lazy(raw, () => this.masterKey(), this.globalStore);
    const mls = new MlsSessionStore(mlsTransport(this.rest), identity, enc, enc, () =>
      this.sessionUserId(),
    );
    const tak = new TakSessionStore(mls, takTransport(this.rest), enc);
    s = { mls, tak };
    this.sessions.set(topicId, s);
    return s;
  }

  /**
   * Which key model this room uses — the question the TAK layer actually asks.
   *
   * It used to resolve a VISIBILITY, and a DM's topic row says `'secret'`, so
   * every DM was handled as a per-epoch room while `chatTierPolicy` declares it
   * topic-root. `kind` is the half that was being dropped.
   *
   * Falls back to `public` on a failed lookup, which is the tier that promises
   * the least — the same direction `chatTierOf` errs in.
   */
  private async tier(topicId: string): Promise<ChatTier> {
    const cached = this.tierCache.get(topicId);
    if (cached) return cached;
    let t: ChatTier = 'public';
    try {
      const topic = await this.rest.topics.get(topicId);
      t = chatTierOf(topic.visibility, (topic as { kind?: string }).kind === 'dm');
    } catch {
      /* default to public if the topic lookup fails */
    }
    this.tierCache.set(topicId, t);
    return t;
  }

  /**
   * Exchange keys with the room's other leaves, per the tier's rule.
   *
   * BOTH directions, and the order matters. Taking first is what lets a device
   * that holds nothing become one that can serve: it adopts the root addressed
   * to it, and the give below then has something to give. A give-only pass
   * leaves two devices each waiting for the other.
   *
   * The web app and the mini-app both run this off a `key-needed` broadcast; an
   * agent has no such loop, so it runs on the calls an agent actually makes —
   * sending and reading. Nothing existed here at all, which meant an agent could
   * hold a room's only key and never pass it on.
   *
   * Best-effort and silent: the give is a no-op unless the group changed, and a
   * failure to exchange must never fail the send or read that triggered it.
   */
  private async shareKeys(topicId: string, tier: ChatTier): Promise<void> {
    let tak: TakSessionStore;
    try {
      ({ tak } = await this.session(topicId));
    } catch {
      return; // no session for this room — nothing to exchange either way
    }

    /*
     * TWO independent duties, so TWO catches. Sharing one would be a bug and
     * was: an API key with `historyGrant: 'none'` is REFUSED `GET /tak/bundles`
     * by design, and with both halves under one `try` that expected 403 threw
     * past the hand-out — so an AI member archived its own message under the
     * room's root and never told anyone, and the human it was talking to read
     * `null`. Being unable to RECEIVE a key says nothing about whether you hold
     * one worth giving.
     */
    try {
      // TAKE: bundles addressed to this device. `backfill` does this too, but a
      // caller that only ever sends and reads would otherwise never pick up the
      // key it is owed.
      await tak.ingestBundles(topicId);
    } catch {
      /* refused or unreachable — the next call, and `backfill`, retry */
    }

    try {
      // GIVE: a no-op unless the group changed since this device last looked.
      if (usesTopicRootKey(tier)) {
        await tak.distributeRootWhenGroupChanged(topicId, tier);
      } else if (tier === 'private') {
        await tak.grantPrivateHistory(topicId);
      }
      // `secret` is owner-only and the SDK has no role here; the owner's own
      // client grants it. Sharing from any member is what that tier forbids.
    } catch {
      /* nothing to hand over, or the room moved on — the next call retries */
    }
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
   * Start (or get) a 1:1 DM with `peerUserId`, then bootstrap the MLS session so
   * the caller can immediately `sendChat`/`readChat` on the returned topicId. A DM
   * is a hidden 2-member topic: the initiator's `sync()` does MLS genesis; when the
   * peer later calls `startDm` (idempotent → same topicId) their `sync()` joins via
   * External Commit — exactly the topic-chat join path. Returns the DM topicId.
   */
  async startDm(peerUserId: string): Promise<string> {
    const { topicId } = await this.rest.dm.start(peerUserId);
    const { mls } = await this.session(topicId);
    await mls.sync(topicId);
    return topicId;
  }

  /** List the caller's DM channels (routing metadata only — never message content). */
  async listDms(): Promise<DmChannel[]> {
    return this.rest.dm.list();
  }

  /**
   * Seal `text` under MLS, POST the ciphertext, cache the plaintext locally (so
   * this sender can re-read its own message later), and archive it under the
   * topic's TAK so later members can back-fill it. Returns the server message id.
   */
  async sendChat(topicId: string, text: string, opts: { archive?: boolean; tier?: ChatTier } = {}): Promise<string> {
    const { mls, tak } = await this.session(topicId);
    const sealed: SealedMessage = await mls.seal(topicId, text);
    // Same TAK material serves two jobs, so resolve the tier once. Callers that
    // opt out of archiving (`archive: false`) also opt out of the push preview —
    // both are TAK-sealed copies of the body.
    const archive = opts.archive !== false;
    const tier = archive ? opts.tier ?? (await this.tier(topicId)) : null;
    // Push-preview copy (design §13.6 strategy A): sealed under the topic's TAK
    // and attached to THIS request, because push fan-out happens inside it — the
    // archiveOnSend upload below only lands after the response. Best-effort:
    // sealForPush returns null on any failure and the send proceeds without it.
    const preview = tier ? await tak.sealForPush(topicId, text, tier) : null;
    const row = await this.rest.chat.send(topicId, {
      ciphertext: sealed.ciphertext,
      epoch: sealed.epoch,
      ...(preview ? { pushArchive: { ct: preview.ct, takVersion: preview.takVersion } } : {}),
    });
    // The MLS sender cannot decrypt its OWN application message — cache the
    // plaintext under the server id so readChat surfaces it after a restart.
    await mls.cachePlaintext(topicId, row.id, text);
    if (tier) {
      try {
        await tak.archiveOnSend(topicId, row.id, text, tier);
        // A room whose membership changed since this device last looked has
        // leaves holding nothing. Sending is the natural moment to notice.
        await this.shareKeys(topicId, tier);
      } catch {
        /* archiving is best-effort durability; a failure never fails the send */
      }
    }
    return row.id;
  }

  /**
   * Send an image, end-to-end encrypted, exactly as the human clients do.
   *
   * An agent that can read pictures but not post them is half a member of the
   * room, and CLAUDE.md's standing rule is that every surface assumes an agent
   * is the primary caller. This is the other half of `readChat`'s attachment
   * support.
   *
   * The bytes are sealed on THIS machine under the topic's TAK — the same key
   * and derivation the archive uses — and only ciphertext leaves. The object key
   * comes back from the server and is carried inside the sealed message body, so
   * the server never learns which object a message named.
   *
   * Everything except the transport lives in the thrice-bound `chatMedia.ts`:
   * the size cap, the MIME allowlist, the HEIC refusal, the envelope shape and
   * the failure taxonomy are one implementation shared by all three clients, so
   * an agent cannot send something a person's client would have refused.
   */
  async sendMedia(
    topicId: string,
    input: { bytes: Uint8Array; mime: string },
    opts: { tier?: ChatTier } = {},
  ): Promise<{ messageId: string; envelope: ChatMediaEnvelope }> {
    const { tak } = await this.session(topicId);
    const tier = opts.tier ?? (await this.tier(topicId));
    let messageId = '';
    const envelope = await sendEncryptedChatMedia(input, {
      seal: (mediaId, plain) => tak.sealMedia(topicId, mediaId, plain, tier),
      upload: (ciphertext, mediaId) => this.rest.chat.uploadMedia(topicId, mediaId, ciphertext),
      send: async (body) => {
        // Through `sendChat`, so the envelope is archived like any other message
        // — that archive row is what a LATER member reads the picture from.
        messageId = await this.sendChat(topicId, body, { tier });
      },
      /*
       * The bytes are stored and good; only the message failed. Surfacing the
       * envelope lets a caller retry THAT object instead of re-reading a file it
       * may no longer have — and an agent, unlike a person, often cannot "pick
       * the image again".
       */
      discard: (objectKey) => this.rest.chat.discardMedia(topicId, objectKey),
      retainForRetry: true,
    });
    return { messageId, envelope };
  }

  /**
   * Fetch chat history and MLS-decrypt each sealed body (cached per message id so
   * history survives forward-secrecy key deletion + restarts). Undecryptable rows
   * (pre-join epochs) surface with `text: null` — use `backfill` for those.
   */
  async readChat(topicId: string, opts: { limit?: number; since?: string; before?: string } = {}): Promise<ChatMessage[]> {
    const { mls, tak } = await this.session(topicId);
    // The tier decides where an attachment's key comes from, so it is resolved
    // once per read rather than per row.
    const tier = await this.tier(topicId);
    // Reading is the other moment an agent is present, so it is the other place
    // a leaf that joined since last time can be handed what it is missing.
    await this.shareKeys(topicId, tier);
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
      /*
       * An attachment's decrypted body is an ENVELOPE, not prose. Handing that
       * string to an agent as message text is what made a picture invisible to
       * it. Parse it, fetch the ciphertext through the gated route, open it with
       * the same TAK the archive uses — and leave `text` null so nothing
       * downstream mistakes machine syntax for something a human wrote.
       */
      let media: ChatMessage['media'];
      const envelope = text === null ? null : parseChatMediaBody(text);
      if (envelope) {
        text = null;
        const loaded = await loadEncryptedChatMedia(envelope, {
          fetchCiphertext: async (key) => {
            const bytes = await this.rest.chat.media(topicId, key);
            // `loadEncryptedChatMedia` reads empty as a fetch failure, which is
            // the honest mapping for "the server has nothing under that key".
            return bytes ?? new Uint8Array(0);
          },
          open: (mediaId, takVersion, ciphertext) =>
            tak.openMedia(topicId, mediaId, takVersion, ciphertext, tier),
        });
        media =
          loaded.status === 'ok'
            ? { status: 'ok', mime: loaded.mime, bytes: loaded.bytes }
            : {
                status: loaded.status === 'fetch-failed' ? 'unavailable' : loaded.status,
                mime: envelope.mime,
                bytes: null,
              };
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
        ...(media ? { media } : {}),
      });
    }
    await this.ackDelivered(topicId, out);

    /*
     * Recover rows whose LIVE copy is already gone.
     *
     * The server drops a message's ciphertext once every device that was in the
     * group when it was sent has acknowledged it — and a device with NO delivery
     * cursor counts as satisfied (`isPurgeable` only iterates devices that have
     * one). For a room's FIRST message nobody has a cursor yet, so the sweep the
     * archive upload schedules can null the ciphertext before the recipient has
     * fetched once. The row survives with `sealed: null`, and `readChat` used to
     * report it as `text: null` — indistinguishable from "sealed before I joined"
     * and equally wrong, because the archive holds it and this device can open it.
     *
     * A visible race rather than a theoretical one: it turns on how long the
     * SENDER stays busy after uploading the archive row. Adding two requests to
     * `sendChat` was enough to lose every first message in this suite.
     *
     * Conditional, so the ordinary path costs nothing: only a row with no body,
     * no attachment and no system text can have been purged.
     */
    const purged = out.filter((m) => m.text === null && !m.media && !m.system);
    if (purged.length > 0) {
      const recovered = new Map((await this.backfill(topicId, { tier })).map((r) => [r.messageId, r]));
      for (const m of purged) {
        const r = recovered.get(m.id);
        if (!r) continue;
        if (r.media) m.media = r.media;
        else if (r.plaintext) m.text = r.plaintext;
      }
    }

    /*
     * Close archive GAPS. `archiveOnSend` gets ONE attempt, at send time, and
     * writes nothing while this device holds no key it may seal under — offline,
     * a server hiccup, or losing the race to mint the room's root. There was no
     * second chance here, so the message stayed out of the archive forever: every
     * device that joined later was missing it, this device could not re-open its
     * own copy once the send ratchet advanced, and nothing anywhere reported a
     * problem. A gap is silent in a way corruption is not.
     *
     * The web client does this on room entry (`ChatPanel`'s `archiveGaps`); this
     * is the agent's equivalent, and it belongs AFTER `shareKeys` above, because
     * a device that just adopted the room's root is exactly the one with rows to
     * put back. Idempotent, uncoordinated and best-effort — `chat_archive` is
     * unique on (topic_id, message_id) and the route ignores conflicts.
     */
    await tak
      .backfillMissingArchive(
        topicId,
        tier,
        out.flatMap((m) => (m.text ? [{ messageId: m.id, plaintext: m.text }] : [])),
      )
      .catch(() => 0);
    return out;
  }

  /**
   * Tell the server this device has taken delivery of everything just read.
   *
   * The live `ciphertext` column is a delivery QUEUE — the server drops a
   * message's copy once every device that was in the group at send time has
   * fetched it — so an agent that never acks is the reason its own ciphertext
   * sits on the server for the full 30-day grace cap. Doing it here rather than
   * asking every caller to remember means the SDK is a good citizen by default.
   *
   * BEST-EFFORT, always. This runs after the messages are in hand, and a failure
   * to acknowledge is not a failure to read: swallowing it costs some server
   * storage, while throwing would lose a history the caller already has. The
   * mark is the NEWEST row seen, which is the honest claim — every earlier row
   * came back in the same response.
   */
  private async ackDelivered(topicId: string, messages: readonly ChatMessage[]): Promise<void> {
    if (messages.length === 0) return;
    try {
      // Compared as INSTANTS, not as strings: the wire format is ISO-8601 UTC
      // today, and lexical order only happens to agree with time order while
      // that stays true of every row.
      /*
       * A row this client could NOT read must not be claimed.
       *
       * `readChat` degrades an undecryptable body to `text: null` rather than
       * throwing, so a locked row travels in the same array as readable ones.
       * Acking it tells the server "delivered" for ciphertext this device could
       * not open — and the purge then drops the only live copy, from under the
       * device that is still waiting for its key. The web and mini-app clients
       * apply the same rule through `chatDeliveryAck.claimable`; the SDK cannot
       * import that module, so the rule is restated here rather than assumed.
       *
       * An attachment counts as read when its envelope resolved, even though
       * `text` is deliberately null for one — the body came through, it is
       * simply not prose.
       */
      const readable = messages.filter(
        (m) => m.type !== 'message' || m.text !== null || m.media?.status === 'ok',
      );
      if (readable.length === 0) return;

      let newest = readable[0].createdAt;
      let newestMs = Date.parse(newest);
      for (const m of readable) {
        const ms = Date.parse(m.createdAt);
        if (Number.isFinite(ms) && (!Number.isFinite(newestMs) || ms > newestMs)) {
          newest = m.createdAt;
          newestMs = ms;
        }
      }
      if (!Number.isFinite(newestMs)) return; // nothing datable to acknowledge
      const { tak } = await this.session(topicId);
      const deviceId = await tak.myDeviceId(topicId);
      await this.rest.chat.delivered(topicId, deviceId, newest);
    } catch {
      /* see above: never turn a successful read into a failure */
    }
  }

  /**
   * Back-fill history via the TAK archive: ingest any bundles addressed to this
   * device, then decrypt every archive row we hold a key for. Returns the
   * decrypted bodies keyed by original message id (rows out of scope are omitted).
   */
  async backfill(
    topicId: string,
    opts: { tier?: ChatTier } = {},
  ): Promise<Array<{ messageId: string; plaintext: string; media?: ChatMessage['media'] }>> {
    const { tak } = await this.session(topicId);
    const tier = opts.tier ?? (await this.tier(topicId));
    const rows = await tak.backfill(topicId, tier);
    /*
     * HISTORY has the same defect `readChat` had, one function over: an
     * attachment's archived plaintext IS the envelope, so an agent reading a
     * room's past would still get `openstoa:media:v1:{…}` where a person sees a
     * photo — and history is the path an agent uses most, because it usually
     * arrives after the conversation.
     *
     * Same helper, same key, same four outcomes. An envelope row's `plaintext`
     * is emptied for the same reason `text` goes null live: machine syntax must
     * not be handed to a reader as if someone had typed it.
     */
    const out: Array<{ messageId: string; plaintext: string; media?: ChatMessage['media'] }> = [];
    for (const row of rows) {
      const envelope = parseChatMediaBody(row.plaintext);
      if (!envelope) {
        out.push(row);
        continue;
      }
      const loaded = await loadEncryptedChatMedia(envelope, {
        fetchCiphertext: async (key) => (await this.rest.chat.media(topicId, key)) ?? new Uint8Array(0),
        open: (mediaId, takVersion, ciphertext) =>
          tak.openMedia(topicId, mediaId, takVersion, ciphertext, tier),
      });
      out.push({
        messageId: row.messageId,
        plaintext: '',
        media:
          loaded.status === 'ok'
            ? { status: 'ok', mime: loaded.mime, bytes: loaded.bytes }
            : {
                status: loaded.status === 'fetch-failed' ? 'unavailable' : loaded.status,
                mime: envelope.mime,
                bytes: null,
              },
      });
    }
    return out;
  }

  /**
   * Hand this room's archive key to every current member leaf, so any member —
   * a later joiner, or another device of this same account — can read all of the
   * history. Returns the number of bundles sent.
   *
   * `sendChat` / `readChat` already do this when the group has changed. This is
   * the explicit form, for a caller that wants to share without saying anything.
   */
  async shareRoomKeys(topicId: string): Promise<number> {
    const { tak } = await this.session(topicId);
    const tier = await this.tier(topicId);
    if (!usesTopicRootKey(tier)) return tak.grantPrivateHistory(topicId);
    return tak.distributeRoot(topicId, tier);
  }

  /** Low-level access to the per-topic MLS/TAK stores (advanced flows: AI grants, removal). */
  async topicSession(topicId: string): Promise<TopicSession> {
    return this.session(topicId);
  }
}
