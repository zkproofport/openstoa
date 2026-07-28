/**
 * OpenClaw binding — maps the OpenClaw channel-plugin interface onto
 * OpenStoaChannel.
 *
 * VERIFIED (docs.openclaw.ai + github.com/openclaw/openclaw, fetched 2026-07):
 *   - a channel plugin is registered via `defineChannelPluginEntry({ id, name,
 *     description, plugin })`;
 *   - the `ChannelPlugin` carries an `outbound` adapter whose
 *     `sendText(params: { to, text, replyToId? }) => Promise<{ messageId }>`
 *     performs the native send;
 *   - inbound platform events are pushed into OpenClaw's pipeline from a handler
 *     (webhook / dispatch) that the runtime provides.
 *
 * UNVERIFIED (could not open the compiled `openclaw/plugin-sdk` .ts source, only
 * the docs prose): the EXACT field names of the inbound envelope OpenClaw's
 * dispatch expects, and the full `ChannelPlugin` shape beyond `outbound`. Those
 * parts are declared locally as a minimal structural interface and marked below;
 * confirm against `openclaw/plugin-sdk` types before shipping to a real runtime.
 *
 * We intentionally DO NOT depend on `openclaw` here — the consumer's OpenClaw
 * runtime supplies `defineChannelPluginEntry`. This binding stays a thin mapper.
 */
import type { InboundMessage, OpenStoaChannel } from './channel';

/** VERIFIED: the outbound send signature OpenClaw calls to deliver a reply. */
export interface OpenClawOutboundAdapter {
  sendText(params: { to: string; text: string; replyToId?: string }): Promise<{ messageId: string }>;
}

/**
 * UNVERIFIED envelope shape. OpenClaw normalizes each platform's inbound into
 * its own session/message model; the exact keys are platform-owned. We push a
 * conservative superset that carries everything OpenStoa knows about a message.
 * `// UNVERIFIED:` confirm these keys against openclaw/plugin-sdk.
 */
export interface OpenClawInboundEvent {
  channel: string;
  // UNVERIFIED: OpenClaw's canonical conversation/sender/text field names.
  conversationId: string;
  senderId: string;
  senderName: string;
  text: string;
  messageId: string;
  timestamp: string;
  isBot: boolean;
}

/** The dispatch OpenClaw hands a plugin to inject an inbound message. */
export type OpenClawDispatch = (event: OpenClawInboundEvent) => void | Promise<void>;

/**
 * VERIFIED shape: the object passed as `plugin` to `defineChannelPluginEntry`.
 * Only `outbound` is exercised here; the rest of the real ChannelPlugin
 * (config/security/pairing/threading) is runtime-configured and out of scope
 * for the channel core, so it is left to the operator's plugin wrapper.
 */
export interface OpenClawChannelPlugin {
  id: string;
  outbound: OpenClawOutboundAdapter;
  /** Wire the OpenStoaChannel's inbound stream into OpenClaw's dispatch. Returns an unsubscribe. */
  attachInbound(dispatch: OpenClawDispatch): () => void;
  /** Start / stop the underlying OpenStoa poll loop. */
  start(): void;
  stop(): void;
}

/** Map an OpenStoa InboundMessage → OpenClaw's inbound envelope. */
export function toOpenClawEvent(id: string, msg: InboundMessage): OpenClawInboundEvent {
  return {
    channel: id,
    conversationId: msg.channelId,
    senderId: msg.fromUserId,
    senderName: msg.fromNickname,
    text: msg.text,
    messageId: msg.messageId,
    timestamp: msg.createdAt,
    isBot: msg.isAI,
  };
}

/**
 * Build the OpenClaw channel plugin object over an authenticated OpenStoaChannel.
 * `outbound.sendText` seals + posts through ChatClient; `attachInbound` forwards
 * every decrypted inbound message to OpenClaw's dispatch. The operator wraps the
 * returned object in `defineChannelPluginEntry({ id, name, description, plugin })`.
 */
export function createOpenClawChannelPlugin(
  channel: OpenStoaChannel,
  opts: { id?: string } = {},
): OpenClawChannelPlugin {
  const id = opts.id ?? 'openstoa';
  return {
    id,
    outbound: {
      // `to` is the OpenStoa topicId (or DM topicId). VERIFIED signature.
      sendText: (params) => channel.send(params.to, params.text),
    },
    attachInbound(dispatch) {
      return channel.onMessage((msg) => {
        void Promise.resolve(dispatch(toOpenClawEvent(id, msg))).catch(() => {
          /* a dispatch failure must never kill the channel */
        });
      });
    },
    start: () => channel.start(),
    stop: () => channel.stop(),
  };
}
