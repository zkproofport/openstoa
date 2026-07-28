/**
 * Optional OS-keychain SecureKVStore (best-effort). Backed by `keytar` when it
 * installs cleanly (macOS Keychain / Windows Credential Vault / libsecret).
 *
 * `keytar` is an OPTIONAL peer dependency with a native addon — in many CI /
 * headless environments it does not install. So this adapter loads it lazily and
 * throws a clear, actionable error if it is unavailable, and `createKeyStore`
 * defaults to the file vault. Do NOT make the SDK depend on this at import time.
 *
 * keytar stores one secret per (service, account); we map (namespace, key) →
 * (service = `<servicePrefix>:<namespace>`, account = key).
 */
import type { SecureKVStore } from '../mls';

// keytar's minimal surface (typed locally so the SDK compiles without @types/keytar).
interface Keytar {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
}

let _keytar: Keytar | null | undefined;
async function loadKeytar(): Promise<Keytar | null> {
  if (_keytar !== undefined) return _keytar;
  try {
    // Dynamic import so a missing native addon never breaks SDK import. The
    // specifier is widened to `string` so TS does not require keytar's types to
    // be resolvable at build time (it's an optional, native peer).
    const specifier = 'keytar' as string;
    const mod = (await import(specifier)) as unknown as { default?: Keytar } & Keytar;
    _keytar = (mod.default ?? mod) as Keytar;
  } catch {
    _keytar = null;
  }
  return _keytar;
}

/** True when the OS keychain backend is usable in this environment. */
export async function keychainAvailable(): Promise<boolean> {
  return (await loadKeytar()) != null;
}

export interface KeychainStoreOptions {
  /** keytar service prefix. Defaults to `openstoa`. */
  servicePrefix?: string;
  /** Namespace (topicId or global). Defaults to `_global`. */
  namespace?: string;
}

export class KeychainStore implements SecureKVStore {
  private readonly service: string;

  constructor(opts: KeychainStoreOptions = {}) {
    const prefix = opts.servicePrefix ?? 'openstoa';
    const ns = opts.namespace && opts.namespace.length > 0 ? opts.namespace : '_global';
    this.service = `${prefix}:${ns}`;
  }

  private async kt(): Promise<Keytar> {
    const kt = await loadKeytar();
    if (!kt) {
      throw new Error(
        "KeychainStore requires the optional 'keytar' native module, which is not installed in this " +
          "environment. Install it (`npm i keytar`) or use the default file-vault backend " +
          "(createKeyStore({ backend: 'vault' })).",
      );
    }
    return kt;
  }

  async get(key: string): Promise<string | null> {
    return (await this.kt()).getPassword(this.service, key);
  }

  async set(key: string, value: string): Promise<void> {
    await (await this.kt()).setPassword(this.service, key, value);
  }
}
