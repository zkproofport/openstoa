/**
 * The mini-app's entry into the shared MLS client.
 *
 * The implementation is `@openstoa/mls` — the same file the web client and the
 * SDK use. This module exists only to state the two ways the MOBILE runtime
 * genuinely differs, which is why three hand-synced copies existed until now:
 *
 *  1. ts-mls must be reached through a lazy `require`, not a top-level import.
 *     It has to load AFTER the host's boot WebCrypto polyfill (index.js ->
 *     ensureSubtleCrypto) has attached `crypto.subtle`, and Metro's
 *     `inlineRequires` resolves a top-level module namespace to `undefined`.
 *
 *  2. AES-GCM must come from `@noble/ciphers`, not the host's `crypto.subtle`.
 *     On Hermes that is react-native-quick-crypto, whose AES-GCM *encrypt*
 *     produces ciphertext standard WebCrypto cannot decrypt — so mobile->web
 *     broke while web->mobile kept working. ts-mls's `nobleCryptoProvider`
 *     alone is NOT enough: HPKE (Commit UpdatePath secrets, Welcome, every TAK
 *     bundle) is built on `@hpke/core`, which calls `crypto.subtle` directly and
 *     is unreachable through ts-mls's public API. The interop shim covers that
 *     hole; the noble provider covers the application-message AEAD, hashes and
 *     KDF.
 *
 * Configured at MODULE LOAD, before any group operation can run — the
 * ciphersuite is memoized on first use, so a later call could not retroactively
 * change how existing state was built.
 */
import { configureMlsRuntime } from '../../../mls/src/groupClient';
import { installNobleAesGcmInterop } from '../../../mls/src/aesGcmInterop';

configureMlsRuntime({
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  loadTsMls: () => require('ts-mls'),
  prepareCrypto: installNobleAesGcmInterop,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  cryptoProvider: (tsmls: any) => tsmls.nobleCryptoProvider,
});

export * from '../../../mls/src/groupClient';
// `aesGcmInteropInstalled` is the test hook that proves the shim above actually
// ran on THIS module instance — without it a silently-skipped install looks
// identical to a working one until mobile ciphertext meets a web decrypt.
export { installNobleAesGcmInterop, aesGcmInteropInstalled } from '../../../mls/src/aesGcmInterop';
