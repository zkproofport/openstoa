/**
 * @masselabs/openstoa-channel — embed OpenStoa E2EE chat + DM as a messaging
 * channel in a self-hosted AI-agent runtime (OpenClaw, Hermes).
 *
 * Layers:
 *   - OpenStoaChannel     : the runtime-agnostic, fully-concrete channel core
 *                           (poll/subscribe → normalized inbound; seal+send out).
 *   - createOpenStoaChannel: production factory reusing the scoped-API-key
 *                           resolution + file-vault keystore of the CLI/MCP core.
 *   - openclaw / hermes    : thin bindings mapping each verified runtime
 *                           interface onto OpenStoaChannel.
 *
 * SI-1: all seal/open is inside ChatClient; the server only ever sees ciphertext.
 */
export { OpenStoaChannel } from './channel';
export type {
  ChannelKind,
  ChannelSubscription,
  InboundMessage,
  MessageHandler,
  ErrorHandler,
  ChannelLogger,
  OpenStoaChannelOptions,
} from './channel';

export { createOpenStoaChannel } from './factory';
export type { ChannelConfig } from './factory';

// Runtime bindings (import the one your runtime uses).
export { createOpenClawChannelPlugin, toOpenClawEvent } from './openclaw';
export type {
  OpenClawChannelPlugin,
  OpenClawOutboundAdapter,
  OpenClawInboundEvent,
  OpenClawDispatch,
} from './openclaw';

export { createHermesBridge, toHermesMessageEvent } from './hermes';
export type { HermesBridge, HermesSendResult, HermesMessageEvent } from './hermes';

// Re-export the SDK domain types a channel consumer commonly needs.
export type { ChatMessage, DmChannel, CommandConfig } from '@masselabs/openstoa-commands';
