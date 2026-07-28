/**
 * @masselabs/openstoa — the shared OpenStoa SDK.
 *
 * Public surface:
 *   - OpenStoaClient : typed Bearer-auth REST wrapper over the OpenStoa HTTP API.
 *   - ChatClient     : high-level E2EE chat (MLS seal/open + TAK archive) that
 *                      keeps openstoa blind (SI-1) — it only ever sends ciphertext.
 *   - keystore       : SecureKVStore adapters (FileVaultStore default, optional
 *                      OS KeychainStore) + createKeyStore factory.
 *   - mls            : the portable MLS/TAK crypto core (byte-compatible with the
 *                      web and mobile clients — same ciphersuite 0x0001).
 */

export { OpenStoaClient, OpenStoaApiError } from './rest/openStoaClient';
export type { OpenStoaClientOptions } from './rest/openStoaClient';
export * from './rest/types';
export { mlsTransport, takTransport, aiMemberDirectory } from './rest/transports';

export { ChatClient } from './chatClient';
export type { ChatClientOptions, ChatMessage } from './chatClient';

export {
  createKeyStore,
  createFileVaultStore,
  FileVaultStore,
  KeychainStore,
  keychainAvailable,
} from './keystore';
export type {
  CreateKeyStoreOptions,
  KeyStoreBackend,
  FileVaultStoreOptions,
  KeychainStoreOptions,
} from './keystore';

// The portable MLS/TAK crypto core (advanced use + interop).
export * as mls from './mls';
export {
  MlsSessionStore,
  TakSessionStore,
  EncryptingKVStore,
  botPublishKeyPackage,
  botJoin,
  grantAiConsent,
  grantAiHistory,
  removeAiMember,
} from './mls';
export type {
  SecureKVStore,
  MlsTransport,
  TakTransport,
  CommitLogEntry,
  TakBundleRow,
  ArchiveEntry,
  Visibility,
  SealedMessage,
  GroupState,
  Device,
  AiMemberDirectory,
  AiGrantSpec,
} from './mls';
