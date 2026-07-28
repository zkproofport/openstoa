/**
 * OpenStoaChannel — the runtime-agnostic messaging-channel core.
 *
 * It lets any AI-agent runtime treat OpenStoa E2EE chat + DM as a messaging
 * channel: subscribe to topics/DMs the agent is a member of, receive normalized
 * inbound messages (decrypted locally), and send/reply back. Both the OpenClaw
 * and Hermes bindings are thin mappers onto THIS surface (see openclaw.ts,
 * hermes.ts), so an unverified binding can never touch the core.
 *
 * SI-1: every seal/open happens inside ChatClient, client-side. This core only
 * ever calls the high-level ChatClient methods (joinTopic / readChat / sendChat
 * / startDm / listDms); it never hands plaintext to a REST endpoint and never
 * touches ciphertext directly. The server only ever sees opaque MLS ciphertext.
 */
import type { ChatClient, ChatMessage, DmChannel } from '@masselabs/openstoa';

/** A topic-backed channel or a 1:1 DM (a hidden 2-member topic). */
export type ChannelKind = 'topic' | 'dm';

/** One channel the agent participates in. `topicId` drives every chat endpoint. */
export interface ChannelSubscription {
  kind: ChannelKind;
  topicId: string;
}

/**
 * A normalized inbound message emitted to the runtime. Text is the DECRYPTED
 * body (undecryptable / system / empty rows are never emitted). Hostile content
 * (wildcards, HTML, control chars, UTF-8) is passed through verbatim — this core
 * does not construct prompts, it only normalizes.
 */
export interface InboundMessage {
  /** Stable channel handle, `topic:<id>` or `dm:<id>`. */
  channelId: string;
  topicId: string;
  kind: ChannelKind;
  messageId: string;
  fromUserId: string;
  fromNickname: string;
  isAI: boolean;
  text: string;
  createdAt: string;
}

export type MessageHandler = (msg: InboundMessage) => void;
export type ErrorHandler = (err: unknown, ctx: { topicId: string; kind: ChannelKind }) => void;
export type ChannelLogger = (level: 'info' | 'error', message: string, meta?: unknown) => void;

export interface OpenStoaChannelOptions {
  /** An authenticated ChatClient (built by createOpenStoaChannel or supplied directly in tests). */
  chat: ChatClient;
  /** Background poll cadence for `start()`. Default 3000ms. */
  pollIntervalMs?: number;
  /** Full-fidelity logger (no truncation). Defaults to console. */
  logger?: ChannelLogger;
}

const DEFAULT_POLL_INTERVAL_MS = 3000;

/** Serialize an error in full — never truncated (server-side log discipline). */
function describeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}\n${err.stack ?? ''}`;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export class OpenStoaChannel {
  private readonly chat: ChatClient;
  private readonly pollIntervalMs: number;
  private readonly logger: ChannelLogger;

  private readonly subs = new Map<string, ChannelSubscription>();
  /** Per-topic dedup set: every message id we have already observed. */
  private readonly seen = new Map<string, Set<string>>();
  /** Per-topic createdAt cursor to trim the next server read. */
  private readonly cursor = new Map<string, string>();

  private readonly messageHandlers = new Set<MessageHandler>();
  private readonly errorHandlers = new Set<ErrorHandler>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: OpenStoaChannelOptions) {
    if (!opts.chat) throw new Error('OpenStoaChannel: a ChatClient is required');
    this.chat = opts.chat;
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.logger =
      opts.logger ??
      ((level, message, meta) => {
        // eslint-disable-next-line no-console
        (level === 'error' ? console.error : console.log)(`[openstoa-channel] ${message}`, meta ?? '');
      });
  }

  // ── auth ──────────────────────────────────────────────────────────────────
  private requireAuth(): void {
    if (!this.chat.rest.getToken()) {
      throw new Error(
        'OpenStoa channel: not authenticated — provide a scoped API key (osk_...) via OPENSTOA_API_KEY or createOpenStoaChannel({ apiKey }).',
      );
    }
  }

  // ── subscriptions ───────────────────────────────────────────────────────────

  /**
   * Subscribe to a topic (or DM) so `start()` / `pollAll()` polls it. Joins +
   * syncs the MLS session first (idempotent) so the very first read can decrypt.
   * A capability/auth error (e.g. an API key without `chat/read`) surfaces here.
   */
  async subscribe(sub: ChannelSubscription): Promise<void> {
    this.requireAuth();
    if (!sub.topicId || sub.topicId.trim().length === 0) throw new Error('channel subscribe: topicId is required');
    await this.chat.joinTopic(sub.topicId);
    this.subs.set(sub.topicId, sub);
    if (!this.seen.has(sub.topicId)) this.seen.set(sub.topicId, new Set());
  }

  /** Convenience: subscribe to a topic-backed channel. */
  subscribeTopic(topicId: string): Promise<void> {
    return this.subscribe({ kind: 'topic', topicId });
  }

  /** Convenience: subscribe to an already-resolved DM topicId. */
  subscribeDm(topicId: string): Promise<void> {
    return this.subscribe({ kind: 'dm', topicId });
  }

  /**
   * Start (or get) a DM with `peerUserId` and subscribe to it. Idempotent — the
   * same pair resolves to the same topicId. Returns the DM topicId.
   */
  async startDm(peerUserId: string): Promise<string> {
    this.requireAuth();
    if (!peerUserId || peerUserId.trim().length === 0) throw new Error('channel startDm: peer userId is required');
    const topicId = await this.chat.startDm(peerUserId);
    await this.subscribe({ kind: 'dm', topicId });
    return topicId;
  }

  /** List the agent's DM channels (routing metadata only — SI-1, never content). */
  listDms(): Promise<DmChannel[]> {
    this.requireAuth();
    return this.chat.listDms();
  }

  subscriptions(): ChannelSubscription[] {
    return [...this.subs.values()];
  }

  // ── events ──────────────────────────────────────────────────────────────────
  onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }
  onError(handler: ErrorHandler): () => void {
    this.errorHandlers.add(handler);
    return () => this.errorHandlers.delete(handler);
  }

  private emitMessage(msg: InboundMessage): void {
    for (const h of this.messageHandlers) {
      try {
        h(msg);
      } catch (err) {
        // A misbehaving handler must never kill the poll loop.
        this.logger('error', 'message handler threw', describeError(err));
      }
    }
  }
  private emitError(err: unknown, ctx: { topicId: string; kind: ChannelKind }): void {
    this.logger('error', `poll error on ${ctx.kind}:${ctx.topicId}`, describeError(err));
    for (const h of this.errorHandlers) {
      try {
        h(err, ctx);
      } catch (hErr) {
        this.logger('error', 'error handler threw', describeError(hErr));
      }
    }
  }

  // ── inbound ───────────────────────────────────────────────────────────────

  /**
   * Poll ONE channel once: read + locally-decrypt history since the cursor,
   * normalize, dedup, emit each NEW user message, and return them. A read error
   * (e.g. a 403 for an API key without `chat/read`) is NOT swallowed here — it
   * propagates so the caller sees the capability failure. Per-message concerns
   * (undecryptable / empty / system rows) are filtered out silently.
   */
  async poll(topicId: string): Promise<InboundMessage[]> {
    this.requireAuth();
    const sub = this.subs.get(topicId) ?? { kind: 'topic' as ChannelKind, topicId };
    const since = this.cursor.get(topicId);
    const rows: ChatMessage[] = await this.chat.readChat(topicId, since ? { since } : {});

    let seen = this.seen.get(topicId);
    if (!seen) {
      seen = new Set();
      this.seen.set(topicId, seen);
    }

    const emitted: InboundMessage[] = [];
    let maxCreatedAt = since;
    for (const r of rows) {
      // Advance the cursor across EVERY row (even ones we won't emit).
      if (!maxCreatedAt || r.createdAt > maxCreatedAt) maxCreatedAt = r.createdAt;
      if (seen.has(r.id)) continue; // dedup: a message polled twice is emitted once
      seen.add(r.id);

      if (r.type !== 'message') continue; // skip join/leave/system rows
      if (r.text === null) {
        // Undecryptable (out-of-epoch) — swallowed, must not kill the loop.
        this.logger('info', `skipping undecryptable message ${r.id} on ${sub.kind}:${topicId}`);
        continue;
      }
      if (r.text.trim().length === 0) continue; // empty / whitespace-only → not emitted

      const msg: InboundMessage = {
        channelId: `${sub.kind}:${topicId}`,
        topicId,
        kind: sub.kind,
        messageId: r.id,
        fromUserId: r.userId,
        fromNickname: r.nickname,
        isAI: r.isAI,
        text: r.text, // hostile content passed through verbatim
        createdAt: r.createdAt,
      };
      emitted.push(msg);
      this.emitMessage(msg);
    }
    if (maxCreatedAt) this.cursor.set(topicId, maxCreatedAt);
    return emitted;
  }

  /**
   * Poll EVERY subscription once. A failure on one channel (thrown read, single
   * undecryptable batch, transient RPC error) is caught, surfaced via `onError`
   * + the logger, and never stops the sweep of the remaining channels.
   */
  async pollAll(): Promise<InboundMessage[]> {
    const out: InboundMessage[] = [];
    for (const sub of this.subs.values()) {
      try {
        out.push(...(await this.poll(sub.topicId)));
      } catch (err) {
        this.emitError(err, { topicId: sub.topicId, kind: sub.kind });
      }
    }
    return out;
  }

  /** Begin polling all subscriptions on an interval. Idempotent. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.pollAll();
    }, this.pollIntervalMs);
    // Don't keep the process alive just for the poll timer.
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  /** Stop the background poll loop. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // ── outbound ────────────────────────────────────────────────────────────────

  /**
   * Seal + send `text` to `topicId` (topic or DM). Ensures the MLS session is
   * joined/synced first (idempotent). Empty/whitespace text is rejected before
   * anything is sent (same guard as the CLI/MCP chatSend). Returns the server
   * message id. A capability/auth error surfaces — it is not swallowed.
   */
  async send(topicId: string, text: string): Promise<{ messageId: string }> {
    this.requireAuth();
    if (!text || text.trim().length === 0) throw new Error('channel send: message text is required');
    if (!topicId || topicId.trim().length === 0) throw new Error('channel send: topicId is required');
    await this.chat.joinTopic(topicId);
    const messageId = await this.chat.sendChat(topicId, text);
    return { messageId };
  }

  /** Reply on the same channel an inbound message arrived on. */
  reply(inbound: InboundMessage, text: string): Promise<{ messageId: string }> {
    return this.send(inbound.topicId, text);
  }
}
