/**
 * Hermes binding — maps the Nous Research Hermes Agent gateway/platform-adapter
 * interface onto OpenStoaChannel.
 *
 * VERIFIED (github.com/NousResearch/hermes-agent, fetched 2026-07:
 * website/docs/developer-guide/adding-platform-adapters.md +
 * website/docs/user-guide/features/plugins.md):
 *   - a platform is registered from a plugin's `register(ctx)` via
 *     `ctx.register_platform(name, label, adapter_factory, check_fn, ...,
 *      required_env=[...], max_message_length=..., emoji=...)`;
 *   - a platform adapter subclasses `BasePlatformAdapter`
 *     (gateway/platforms/base.py) implementing `connect()`, `disconnect()`, and
 *     `send(chat_id, content, reply_to=None, metadata=None) -> SendResult`;
 *   - inbound is delivered by building a `MessageEvent(text, message_type,
 *     source, message_id)` (source from `self.build_source(chat_id, chat_name,
 *     chat_type, user_id, user_name)`) and calling `await self.handle_message(event)`;
 *   - config/auth: `PlatformConfig.extra` dict or env vars
 *     (`PLATFORM_TOKEN`, `PLATFORM_ALLOWED_USERS`, `PLATFORM_ALLOW_ALL_USERS`).
 *
 * CROSS-LANGUAGE GAP (stubbed / UNVERIFIED bridge): Hermes is Python and this
 * channel core is TypeScript, so the two CANNOT run in-process. The verified
 * INTERFACE above is real; the GLUE that lets a Python `BasePlatformAdapter`
 * drive this TS core (run the core as a sidecar and bridge over stdio/HTTP) is
 * OUR design, not from Hermes docs — see README "Hermes" for the reference
 * Python adapter, and the `// UNVERIFIED:` note on `HermesBridge` below.
 *
 * What this file provides concretely is the TS-side of that bridge: the exact
 * `SendResult` and `MessageEvent` SHAPES a bridge process serializes to/from the
 * Python adapter, mapped 1:1 onto OpenStoaChannel. It is fully unit-testable.
 */
import type { InboundMessage, OpenStoaChannel } from './channel';

/** VERIFIED: Hermes `send()` returns a SendResult. Serialized JSON shape. */
export interface HermesSendResult {
  success: boolean;
  message_id?: string;
  error?: string;
}

/** VERIFIED: the `MessageEvent` + nested `source` shape the adapter builds for inbound. */
export interface HermesMessageEvent {
  text: string;
  message_type: 'text';
  message_id: string;
  source: {
    chat_id: string;
    chat_name: string;
    chat_type: 'dm' | 'group';
    user_id: string;
    user_name: string;
  };
}

/**
 * The TS side of the Python↔TS bridge. A sidecar exposes `send` (called when the
 * Python adapter's `send()` fires) and streams `MessageEvent`s (consumed by the
 * Python adapter to call `self.handle_message`).
 *
 * UNVERIFIED: the transport (stdio/HTTP/socket) between this and the Python
 * `BasePlatformAdapter` is our own design — see README. The shapes it moves ARE
 * the verified Hermes shapes above.
 */
export interface HermesBridge {
  /** Maps a Hermes `send(chat_id, content)` onto the sealed OpenStoa send. */
  send(chatId: string, content: string): Promise<HermesSendResult>;
  /** Subscribe to inbound events already shaped as Hermes MessageEvents. Returns unsubscribe. */
  onMessageEvent(handler: (event: HermesMessageEvent) => void): () => void;
  start(): void;
  stop(): void;
}

/** Map an OpenStoa InboundMessage → a Hermes MessageEvent. */
export function toHermesMessageEvent(msg: InboundMessage): HermesMessageEvent {
  return {
    text: msg.text,
    message_type: 'text',
    message_id: msg.messageId,
    source: {
      chat_id: msg.topicId,
      chat_name: msg.channelId,
      chat_type: msg.kind === 'dm' ? 'dm' : 'group',
      user_id: msg.fromUserId,
      user_name: msg.fromNickname,
    },
  };
}

/** Build the TS side of the Hermes bridge over an authenticated OpenStoaChannel. */
export function createHermesBridge(channel: OpenStoaChannel): HermesBridge {
  return {
    async send(chatId, content) {
      try {
        const { messageId } = await channel.send(chatId, content);
        return { success: true, message_id: messageId };
      } catch (err) {
        // Surface the failure in the SendResult (the Python `send()` contract),
        // but never throw across the bridge — a failed send must not kill the loop.
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    onMessageEvent(handler) {
      return channel.onMessage((msg) => handler(toHermesMessageEvent(msg)));
    },
    start: () => channel.start(),
    stop: () => channel.stop(),
  };
}
