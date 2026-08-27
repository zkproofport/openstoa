/**
 * Phase 4 key management orchestration (design §6.1/§6.4). Ties the portable
 * crypto core (keyBackup.ts) to the storage + HTTP layers without importing
 * either directly — both are injected — so this stays portable across web and
 * the mobile mini-app (byte-identical copy at packages/mobile/src/crypto).
 *
 * Responsibilities:
 *   1. master_key lifecycle: load from / create in the ROOT secure store
 *      (OS-protected Keychain on mobile, IndexedDB on web) — the ONE secret kept
 *      unencrypted at rest; everything else is encrypted under keys derived from
 *      it. installMasterKey() overwrites it during recovery.
 *   2. EncryptingKVStore: wraps a raw store so MLS state / TAK keys / message
 *      cache are AEAD-encrypted at rest under HKDF(master_key,"local-store").
 *   3. TAK-keychain backup: seal the TakSessionStore snapshot under
 *      HKDF(master_key,"tak-backup") and upload; restore on a fresh device.
 *   4. master_key backup: recovery-code + passkey-PRF wraps (both "no escrow").
 */
import * as kb from './keyBackup';
import type { SecureKVStore } from './mlsSession';

const MASTER_KEY_STORE_KEY = 'openstoa.masterKey.v1';
// The key this device used before its last recovery. Kept so reads of data it
// sealed earlier still succeed — see `installMasterKey`.
const RETIRED_KEY_STORE_KEY = 'openstoa.masterKey.retired.v1';

// ---------------------------------------------------------------------------
// master_key lifecycle (root store)
// ---------------------------------------------------------------------------

/** Load the device's master_key, generating + persisting one on first run. */
export async function loadOrCreateMasterKey(rootStore: SecureKVStore): Promise<Uint8Array> {
  const existing = await rootStore.get(MASTER_KEY_STORE_KEY);
  if (existing) {
    const bytes = kb.unb64(existing);
    if (bytes.length === kb.MASTER_KEY_LEN) return bytes;
    // Corrupt/short value — regenerate rather than run with a weak key.
  }
  const mk = kb.generateMasterKey();
  await rootStore.set(MASTER_KEY_STORE_KEY, kb.b64(mk));
  return mk;
}

/**
 * Install a recovered master_key as the device's key (recovery path), KEEPING
 * the outgoing one so this device can still read what it already wrote.
 *
 * Everything local — MLS group state, cached plaintexts, TAK keys — is sealed
 * under HKDF(master_key). Swapping the key therefore made every existing value
 * fail to open, and `EncryptingKVStore.get` reports an unopenable value as
 * ABSENT, so the device silently lost its group state and its archive keys the
 * moment the user pressed Recover. On the one device that still held the
 * history, recovery destroyed it.
 *
 * The retired key stays in the same OS-protected root store as the live one, so
 * this widens nothing an attacker could not already reach; reads fall back to it
 * and rewrite under the current key, which migrates the store item by item with
 * no enumeration (Keychain cannot list).
 */
export async function installMasterKey(rootStore: SecureKVStore, masterKey: Uint8Array): Promise<void> {
  const outgoing = await rootStore.get(MASTER_KEY_STORE_KEY);
  if (outgoing && outgoing !== kb.b64(masterKey)) {
    await rootStore.set(RETIRED_KEY_STORE_KEY, outgoing);
  }
  await rootStore.set(MASTER_KEY_STORE_KEY, kb.b64(masterKey));
}

/** The key this device used BEFORE its last recovery, if it has had one. */
export async function loadRetiredMasterKey(rootStore: SecureKVStore): Promise<Uint8Array | null> {
  const v = await rootStore.get(RETIRED_KEY_STORE_KEY);
  if (!v) return null;
  const bytes = kb.unb64(v);
  return bytes.length === kb.MASTER_KEY_LEN ? bytes : null;
}

/** True once a master_key exists locally (used to gate first-run backup induction). */
export async function hasMasterKey(rootStore: SecureKVStore): Promise<boolean> {
  return (await rootStore.get(MASTER_KEY_STORE_KEY)) != null;
}

// ---------------------------------------------------------------------------
// EncryptingKVStore — at-rest encryption of the non-root stores
// ---------------------------------------------------------------------------

/**
 * A SecureKVStore that AEAD-encrypts values under a master_key-derived key. Keys
 * pass through in the clear (they are not secret — e.g. `tak.epoch.<topic>.<n>`);
 * only values are sealed. A value that fails to decrypt (legacy plaintext written
 * before Phase 4, or a wrong key) reads as absent, so MLS/TAK callers safely
 * re-bootstrap rather than crashing.
 */
export class EncryptingKVStore implements SecureKVStore {
  // Promise so the store can be constructed synchronously (the getters stay sync)
  // while the master_key load + HKDF happen on first access and are memoized.
  private storeKeyPromise: Promise<Uint8Array>;

  private retiredKeyPromise: Promise<Uint8Array | null>;

  private constructor(
    private inner: SecureKVStore,
    storeKeyPromise: Promise<Uint8Array>,
    retiredKeyPromise: Promise<Uint8Array | null> = Promise.resolve(null),
  ) {
    this.storeKeyPromise = storeKeyPromise;
    this.retiredKeyPromise = retiredKeyPromise;
  }

  /** Eager: master_key already in hand. storeKey = HKDF(master_key,"local-store"). */
  static async create(inner: SecureKVStore, masterKey: Uint8Array): Promise<EncryptingKVStore> {
    return new EncryptingKVStore(inner, Promise.resolve(await kb.deriveLocalStoreKey(masterKey)));
  }

  /** Lazy: defer the master_key load to first get/set so the caller stays sync. */
  static lazy(
    inner: SecureKVStore,
    getMasterKey: () => Promise<Uint8Array>,
    /** Root store to look up the pre-recovery key in. Omit and reads never fall back. */
    rootStore?: SecureKVStore,
  ): EncryptingKVStore {
    return new EncryptingKVStore(
      inner,
      getMasterKey().then((mk) => kb.deriveLocalStoreKey(mk)),
      rootStore
        ? loadRetiredMasterKey(rootStore)
            .then((mk) => (mk ? kb.deriveLocalStoreKey(mk) : null))
            // A read that the live key opens on the first try never awaits this
            // promise, so a rejection here would go unobserved — and an unobserved
            // rejection terminates a process with no handler installed. The
            // fallback is an optimisation on top of a working read, so a root
            // store that throws degrades to "no fallback", never to a crash.
            .catch(() => null)
        : Promise.resolve(null),
    );
  }

  async get(key: string): Promise<string | null> {
    const v = await this.inner.get(key);
    if (v == null) return null;
    const opened = await kb.openBlob(await this.storeKeyPromise, v);
    if (opened != null) return opened;

    // Sealed under the key this device used before it recovered. Without this
    // the value reads as ABSENT and the device quietly loses its own history.
    const retired = await this.retiredKeyPromise;
    if (!retired) return null;
    const legacy = await kb.openBlob(retired, v);
    if (legacy == null) return null;
    // Re-seal under the live key so the store migrates as it is read — the only
    // way to do it without enumerating, which Keychain cannot do.
    try {
      await this.set(key, legacy);
    } catch {
      /* migration is opportunistic; the value is still returned either way */
    }
    return legacy;
  }

  async set(key: string, value: string): Promise<void> {
    await this.inner.set(key, await kb.sealBlob(await this.storeKeyPromise, value));
  }
}

// ---------------------------------------------------------------------------
// TAK-keychain backup (server-side, master_key-encrypted) — design §6.4.1
// ---------------------------------------------------------------------------

/** Seal a TAK-keychain snapshot and hand the ciphertext to `post`. */
export async function uploadTakKeychain(
  masterKey: Uint8Array,
  keychain: Record<string, string>,
  post: (ciphertextB64: string) => Promise<void>,
): Promise<void> {
  const key = await kb.deriveTakBackupKey(masterKey);
  await post(await kb.sealBlob(key, JSON.stringify(keychain)));
}

/** Fetch + decrypt the TAK-keychain snapshot; null if none or undecryptable. */
export async function restoreTakKeychain(
  masterKey: Uint8Array,
  fetchCiphertext: () => Promise<string | null>,
): Promise<Record<string, string> | null> {
  const blob = await fetchCiphertext();
  if (!blob) return null;
  const key = await kb.deriveTakBackupKey(masterKey);
  const json = await kb.openBlob(key, blob);
  if (json == null) return null;
  try {
    return JSON.parse(json) as Record<string, string>;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// master_key backup + recovery (recovery-code + passkey PRF) — design §6.4
// ---------------------------------------------------------------------------

export interface KeyBackupState {
  wrappedMaster: string | null; // recovery-code wrap
  passkeys: Array<{ credentialId: string; prfWrapped: string }>;
  /**
   * Epoch ms of the most recent wrap, or null when there is none.
   *
   * OPTIONAL so a client reading an older server still type-checks; a client
   * that gets `undefined` must treat it exactly as `null` — see
   * `deviceTakeover.backupStanding`, where "we do not know when" resolves to
   * the cautious answer rather than to "recent".
   */
  backupUpdatedAt?: number | null;
}

/**
 * Create a recovery-code backup of master_key: generate a fresh code, upload the
 * wrapped copy, and return the code so the UI can show it ONCE for the user to
 * store. The code itself never reaches the server (only the wrapped ciphertext).
 */
export async function backupWithRecoveryCode(
  masterKey: Uint8Array,
  postRecovery: (wrappedMasterB64: string) => Promise<void>,
): Promise<string> {
  const code = kb.generateRecoveryCode();
  await postRecovery(await kb.wrapMasterKeyWithRecoveryCode(code, masterKey));
  return code;
}

/** Recover master_key from a user-entered recovery code + the fetched backup. */
export async function recoverWithRecoveryCode(
  code: string,
  fetchBackup: () => Promise<KeyBackupState>,
): Promise<Uint8Array | null> {
  const { wrappedMaster } = await fetchBackup();
  if (!wrappedMaster) return null;
  return kb.unwrapMasterKeyWithRecoveryCode(code, wrappedMaster);
}

/** Back up master_key wrapped by a passkey's PRF output, keyed by credential id. */
export async function backupWithPasskey(
  masterKey: Uint8Array,
  credentialId: string,
  prfOutput: Uint8Array,
  postPasskey: (credentialId: string, prfWrappedB64: string) => Promise<void>,
): Promise<void> {
  await postPasskey(credentialId, await kb.wrapMasterKeyWithPrf(prfOutput, masterKey));
}

/**
 * Recover master_key from a passkey PRF output. Tries every registered passkey
 * wrap (the PRF is per-credential, so only the matching one unwraps). Returns the
 * first success, or null if none match.
 */
export async function recoverWithPasskey(
  prfOutput: Uint8Array,
  fetchBackup: () => Promise<KeyBackupState>,
): Promise<Uint8Array | null> {
  const { passkeys } = await fetchBackup();
  for (const pk of passkeys) {
    const mk = await kb.unwrapMasterKeyWithPrf(prfOutput, pk.prfWrapped);
    if (mk) return mk;
  }
  return null;
}
