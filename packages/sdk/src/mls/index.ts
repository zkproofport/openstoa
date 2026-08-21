/**
 * Portable MLS chat-crypto core for the @masselabs/openstoa SDK.
 *
 * These modules are RE-EXPORTS. The implementation lives once, in
 * `packages/mls/src`, and the web client and the mini-app import the same
 * files — so an SDK agent interoperates with them in the same MLS group by
 * construction rather than by hand-sync. They run on Node's global webcrypto
 * (crypto.subtle / crypto.getRandomValues) and the global btoa/atob, so no
 * browser or React Native shims are needed.
 *
 * They used to be COPIES, bound to the web originals byte for byte by
 * `src/__tests__/mlsCryptoTwins.test.ts` — after this copy had already drifted
 * 667 lines and 14 methods behind in silence, `openMedia` among them, so an AI
 * member holding a topic's TAK received the literal envelope
 * `openstoa:media:v1:{…}` where a person saw a photo.
 *
 * That test still exists and still guards this directory; what it asserts is
 * now "there is no copy": every file here is a re-export, every specifier
 * resolves into `packages/mls/src`, all three trees load the SAME module
 * object, and the repo holds exactly one implementation of each. So there is no
 * longer a sync step to forget — but there is also nothing to add HERE. Code
 * written in this directory is invisible to the web client and the mini-app,
 * which is precisely how the drift happened. Put the change in
 * `packages/mls/src`.
 *
 * The two genuine platform differences (how ts-mls is loaded, where AES-GCM
 * comes from) are injected through `configureMlsRuntime`; the SDK takes the
 * defaults, which are the web behaviour.
 */
export * as groupClient from './groupClient';
export * as leafIdentity from './leafIdentity';
export * as takClient from './takClient';
export * as aiMember from './aiMember';
export * as keyBackup from './keyBackup';
export * as keyManager from './keyManager';

export { MlsSessionStore } from './mlsSession';
export type { MlsTransport, SecureKVStore, CommitLogEntry } from './mlsSession';
export { TakSessionStore } from './takSession';
export type { TakTransport, TakBundleRow, ArchiveEntry, Visibility, PushPreviewSeal } from './takSession';
export { EncryptingKVStore } from './keyManager';
export type { SealedMessage, GroupState, Device } from './groupClient';
export type {
  AiMemberDirectory,
} from './aiMember';
export {
  botPublishKeyPackage,
  botJoin,
  grantAiHistory,
  removeAiMember,
} from './aiMember';
