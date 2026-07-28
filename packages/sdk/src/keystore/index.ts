/**
 * Keystore factory. The SDK persists each participant's self-custodied MLS state
 * and TAK keys through a SecureKVStore, namespaced per topic plus a global area
 * for identity / master_key.
 *
 * Backends:
 *   - 'vault'    (DEFAULT) — FileVaultStore under `~/.openstoa/vault`, 0600 files.
 *   - 'keychain' (best-effort) — OS keychain via optional `keytar`. Falls back to
 *     the vault when keytar is unavailable, UNLESS `strict: true` is set.
 */
import type { SecureKVStore } from '../mls';
import { FileVaultStore } from './fileVaultStore';
import { KeychainStore, keychainAvailable } from './keychainStore';

export { FileVaultStore } from './fileVaultStore';
export type { FileVaultStoreOptions } from './fileVaultStore';
export { KeychainStore, keychainAvailable } from './keychainStore';
export type { KeychainStoreOptions } from './keychainStore';

export type KeyStoreBackend = 'vault' | 'keychain';

export interface CreateKeyStoreOptions {
  backend?: KeyStoreBackend;
  /** Vault root (vault backend). Defaults to `~/.openstoa`. */
  root?: string;
  /** Namespace: a topicId, or omitted for the global (identity/master_key) area. */
  namespace?: string;
  /** keychain backend: throw instead of falling back to the vault when keytar is missing. */
  strict?: boolean;
}

/**
 * A namespaced SecureKVStore. Pass a `namespace` (topicId) for per-topic keys, or
 * omit it for the global identity/master_key area. `root` (vault backend) points
 * at the `.openstoa` directory; the vault lives at `<root>/vault/<namespace>`.
 */
export async function createKeyStore(opts: CreateKeyStoreOptions = {}): Promise<SecureKVStore> {
  const backend = opts.backend ?? 'vault';
  if (backend === 'keychain') {
    if (await keychainAvailable()) {
      return new KeychainStore({ namespace: opts.namespace });
    }
    if (opts.strict) {
      throw new Error("createKeyStore({ backend: 'keychain' }): keytar is not available in this environment");
    }
    // Best-effort: silently fall back to the file vault so P-A never blocks on
    // native keychain availability.
  }
  const root = opts.root ? vaultRoot(opts.root) : undefined;
  return new FileVaultStore({ root, namespace: opts.namespace });
}

/** Synchronous vault-only factory (no keychain probe). */
export function createFileVaultStore(opts: { root?: string; namespace?: string } = {}): SecureKVStore {
  return new FileVaultStore({ root: opts.root ? vaultRoot(opts.root) : undefined, namespace: opts.namespace });
}

// The public `root` option names the `.openstoa` directory; the vault files live
// in a `vault/` subdir under it (identity/master_key vs per-topic namespaces).
function vaultRoot(openstoaRoot: string): string {
  return openstoaRoot.replace(/\/$/, '') + '/vault';
}
