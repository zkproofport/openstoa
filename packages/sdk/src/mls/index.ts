/**
 * Portable MLS chat-crypto core for the @masselabs/openstoa SDK.
 *
 * These modules are copied verbatim (byte-compatible wire format: ciphersuite
 * 0x0001, same base64 framing) from the web client at openstoa/src/lib/mls so an
 * SDK agent interoperates with the web and mobile clients in the same MLS group.
 * They run on Node's global webcrypto (crypto.subtle / crypto.getRandomValues)
 * and the global btoa/atob, so no browser or React Native shims are needed.
 *
 * These copies are no longer unbound. `src/__tests__/mlsCryptoTwins.test.ts`
 * holds them to the web originals, so changing a shared rule means changing
 * every copy the table names — editing only this one turns the suite red. Do
 * NOT refactor the source copies from here; make the change in
 * `src/lib/mls/*` and re-sync.
 *
 * What IS bound today:
 *  - byte-identical across all three trees: `takSession`, `takClient`,
 *    `chatMedia`, `leafIdentity`;
 *  - byte-identical web ↔ SDK, with the mini-app held to the same METHOD
 *    SURFACE but exempt from byte-identity for a stated reason: `groupClient`
 *    (lazy ts-mls require for Metro/boot order, plus a @noble/ciphers AES-GCM
 *    shim for Hermes) and `mlsSession` (comment-only drift).
 *
 * Still unbound, and therefore still able to drift silently: `keyManager`,
 * `keyBackup`, `aiMember`. `keyBackup` and `aiMember` happen to be identical
 * across all three right now — by luck, not by a test. `keyManager` is NOT: the
 * SDK copy lacks the retired-key fallback that lets a device keep reading what
 * it sealed before a recovery. That is dormant here only because the SDK has no
 * recovery path; give it one and the gap is live.
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
