/**
 * Portable MLS chat-crypto core for the @masselabs/openstoa SDK.
 *
 * These modules are copied verbatim (byte-compatible wire format: ciphersuite
 * 0x0001, same base64 framing) from the web client at openstoa/src/lib/mls so an
 * SDK agent interoperates with the web and mobile clients in the same MLS group.
 * They run on Node's global webcrypto (crypto.subtle / crypto.getRandomValues)
 * and the global btoa/atob, so no browser or React Native shims are needed.
 *
 * Deduping the three copies (web / mobile / sdk) is a deliberate later follow-up
 * — do NOT refactor the source copies from here.
 */
export * as groupClient from './groupClient';
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
