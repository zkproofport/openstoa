/**
 * Mobile wiring for the MLS session manager: an MlsTransport over the host's
 * authenticated OpenStoaClient (Bearer), plus a per-session device identity.
 *
 * The client throws `Error("METHOD path → STATUS: body")` on non-2xx, so we
 * recover the HTTP status from the message to map 404 (no group yet) / 409
 * (epoch-CAS conflict) the way the session manager expects.
 *
 * Device identity + MLS state are in-memory for the app session (Keychain/
 * Keystore persistence + reload resilience are a follow-up, mirroring the web
 * IndexedDB follow-up).
 */
import type { ChatMessage } from '@openstoa/api-types';
import type { OpenStoaClient } from '../api/openstoaClient';
import { MlsSessionStore, type MlsTransport, type SecureKVStore } from './mlsSession';
import { TakSessionStore, type TakTransport, type TakBundleRow, type ArchiveEntry } from './takSession';
import * as km from './keyManager';

function statusOf(e: unknown): number | null {
  const m = String(e instanceof Error ? e.message : e).match(/→ (\d{3}):/);
  return m ? parseInt(m[1], 10) : null;
}

export function createMlsTransport(client: OpenStoaClient): MlsTransport {
  const base = (t: string) => `/api/topics/${t}/mls`;
  return {
    async getGroupInfo(topicId) {
      try {
        const r = await client.get<{ groupInfo: string }>(`${base(topicId)}/group-info`);
        return r.groupInfo;
      } catch (e) {
        if (statusOf(e) === 404) return null;
        throw e;
      }
    },
    async postGroupInfo(topicId, groupInfoB64, groupIdB64) {
      const r = await client.post<{ created: boolean }>(`${base(topicId)}/group-info`, {
        groupInfo: groupInfoB64,
        groupId: groupIdB64,
      });
      return r.created;
    },
    async postCommit(topicId, commitB64, groupInfoB64) {
      try {
        const r = await client.post<{ epoch: number }>(`${base(topicId)}/commit`, {
          commit: commitB64,
          groupInfo: groupInfoB64,
        });
        return { ok: true, epoch: r.epoch };
      } catch (e) {
        if (statusOf(e) === 409) return { ok: false };
        throw e;
      }
    },
    async getCommitsSince(topicId, sinceEpoch) {
      const r = await client.get<{ commits: { epoch: number; commit: string; welcome: string | null }[] }>(
        `${base(topicId)}/commit?sinceEpoch=${sinceEpoch}`,
      );
      return r.commits;
    },
  };
}

// Per-app-session device identity (the MLS leaf credential). In-memory like the
// group state — on app restart a fresh identity re-bootstraps via External
// Commit (a new leaf). Stable cross-restart identity is a follow-up.
let _identity: string | null = null;
function deviceIdentity(): string {
  if (!_identity) {
    const b = new Uint8Array(8);
    globalThis.crypto.getRandomValues(b);
    _identity = 'mobile-' + Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
  }
  return _identity;
}

/** Host secure-store shape (HostApi.secureStore) — adapted to SecureKVStore. */
type HostSecureStore = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
};

function adapt(h?: HostSecureStore): SecureKVStore | undefined {
  return h ? { get: (k) => h.getItem(k), set: (k, v) => h.setItem(k, v) } : undefined;
}

// Phase 4: the device master_key lives (plaintext bytes) in the host secure store
// (Keychain/Keystore) — the ONE unencrypted-at-rest secret, itself OS-protected;
// MLS state / TAK keys / message cache are written through EncryptingKVStore,
// sealed under HKDF(master_key,"local-store"). Gated on a host secure store being
// present; without one the mobile side stays in-memory (prior behavior, no key).
let _masterKeyPromise: Promise<Uint8Array> | null = null;
function masterKey(rootStore: SecureKVStore): Promise<Uint8Array> {
  if (!_masterKeyPromise) _masterKeyPromise = km.loadOrCreateMasterKey(rootStore);
  return _masterKeyPromise;
}
function encrypting(raw: SecureKVStore | undefined, rootStore: SecureKVStore | undefined): SecureKVStore | undefined {
  if (!raw || !rootStore) return raw; // no root → no master_key → pass through (in-memory/plain)
  return km.EncryptingKVStore.lazy(raw, () => masterKey(rootStore));
}

let _store: MlsSessionStore | null = null;
export function getMlsSessionStore(
  client: OpenStoaClient,
  hostSecureStore?: HostSecureStore,
  hostLocalStore?: HostSecureStore,
): MlsSessionStore {
  if (!_store) {
    // MLS ClientState → host secure store (Keychain/Keystore) so an app restart
    // restores the same leaf instead of re-joining (which dropped history).
    const rawSecure = adapt(hostSecureStore);
    // Decrypted-message cache → host local store (AsyncStorage). MLS keys are
    // consumed on first decrypt, so cached plaintext is what makes message
    // history survive restarts. Absent stores → in-memory only (prior behavior).
    const rawLocal = adapt(hostLocalStore);
    // Encrypt both at rest under the master_key (rootStore = the secure store).
    const store = encrypting(rawSecure, rawSecure);
    const msgCache = encrypting(rawLocal, rawSecure);
    _store = new MlsSessionStore(createMlsTransport(client), deviceIdentity(), store, msgCache);
  }
  return _store;
}

// TAK layer (Phase 3) over the authenticated client. Server is crypto-free —
// this only moves opaque ciphertext for the archive + bundle endpoints.
export function createTakTransport(client: OpenStoaClient): TakTransport {
  const base = (t: string) => `/api/topics/${t}`;
  return {
    async postArchive(topicId, messageId, takVersion, archiveB64) {
      await client.post(`${base(topicId)}/archive`, { messageId, takVersion, archive: archiveB64 });
    },
    async getArchive(topicId) {
      const out: ArchiveEntry[] = [];
      let cursor = '';
      for (;;) {
        const r = await client.get<{ archive: ArchiveEntry[] }>(`${base(topicId)}/archive?limit=500${cursor}`);
        out.push(...r.archive);
        if (r.archive.length < 500) break;
        const last = r.archive[r.archive.length - 1];
        cursor = `&since=${encodeURIComponent(last.createdAt)}&sinceMsg=${last.messageId}`;
      }
      return out;
    },
    async postBundle(topicId, recipientUserId, recipientDeviceId, bundleB64, scope) {
      await client.post(`${base(topicId)}/tak/bundles`, {
        recipientUserId,
        recipientDeviceId,
        bundle: bundleB64,
        scope,
      });
    },
    async getBundles(topicId, deviceId) {
      const r = await client.get<{ bundles: TakBundleRow[] }>(
        `${base(topicId)}/tak/bundles?deviceId=${encodeURIComponent(deviceId)}`,
      );
      return r.bundles;
    },
    async ackBundles(topicId, deviceId, ids) {
      await client.delete(`${base(topicId)}/tak/bundles`, { body: JSON.stringify({ deviceId, ids }) });
    },
  };
}

// Debounced upload of the master_key-encrypted TAK keychain (design §6.4.1) so a
// recovered master_key re-reads all archived history without another member
// online. Best-effort; a failure never breaks chat.
let _takBackupTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleTakKeychainBackup(client: OpenStoaClient, rootStore: SecureKVStore): void {
  if (_takBackupTimer) clearTimeout(_takBackupTimer);
  _takBackupTimer = setTimeout(() => {
    void (async () => {
      try {
        if (!_takStore) return;
        const keychain = await _takStore.exportKeychain();
        if (Object.keys(keychain).length === 0) return;
        await km.uploadTakKeychain(await masterKey(rootStore), keychain, (ciphertext) =>
          client.post('/api/keys/tak-backup', { ciphertext }),
        );
      } catch {
        /* best-effort backup; retried on the next keychain change */
      }
    })();
  }, 1500);
}

let _takStore: TakSessionStore | null = null;
export function getTakSessionStore(
  client: OpenStoaClient,
  hostSecureStore?: HostSecureStore,
  hostLocalStore?: HostSecureStore,
): TakSessionStore {
  if (!_takStore) {
    // TAK material (root + per-epoch keys) is sensitive → host secure store
    // (Keychain/Keystore), encrypted at rest under the master_key; falls back to
    // in-memory if no host store. Reuses the live MLS session store for reads.
    const rawSecure = adapt(hostSecureStore);
    const store: SecureKVStore =
      encrypting(rawSecure, rawSecure) ??
      (() => {
        const m = new Map<string, string>();
        return { get: async (k: string) => m.get(k) ?? null, set: async (k: string, v: string) => void m.set(k, v) };
      })();
    const onChange = rawSecure ? () => scheduleTakKeychainBackup(client, rawSecure) : undefined;
    _takStore = new TakSessionStore(
      getMlsSessionStore(client, hostSecureStore, hostLocalStore),
      createTakTransport(client),
      store,
      onChange,
    );
  }
  return _takStore;
}

// ---------------------------------------------------------------------------
// Phase 4 key-backup client (used by the mobile recovery / induction UI, P4-05).
// The host supplies WebAuthn PRF output via react-native-passkeys through the
// bridge; these helpers move the wrapped master_key + TAK backup over the client.
// ---------------------------------------------------------------------------

/** The device's master_key (loaded/created on first call). Requires a host secure store. */
export function getDeviceMasterKey(hostSecureStore: HostSecureStore): Promise<Uint8Array> {
  return masterKey(adapt(hostSecureStore)!);
}

/** HTTP client for /api/keys/backup + /api/keys/tak-backup over the authenticated client. */
export function keyBackupHttp(client: OpenStoaClient) {
  return {
    async getBackup(): Promise<km.KeyBackupState> {
      return client.get<km.KeyBackupState>('/api/keys/backup');
    },
    async postRecovery(wrappedMasterB64: string): Promise<void> {
      await client.post('/api/keys/backup', { type: 'recovery', wrappedMaster: wrappedMasterB64 });
    },
    async postPasskey(credentialId: string, prfWrappedB64: string): Promise<void> {
      await client.post('/api/keys/backup', { type: 'passkey', credentialId, prfWrapped: prfWrappedB64 });
    },
    async getTakBackup(): Promise<string | null> {
      return (await client.get<{ ciphertext: string | null }>('/api/keys/tak-backup')).ciphertext;
    },
  };
}

/**
 * Install a recovered master_key + restore the TAK keychain from the server
 * backup. Resets the store singletons so they rebuild under the recovered key;
 * chat then re-joins MLS as a new leaf and reads archived history the keychain
 * covers. Caller passes the host stores so the rebuilt singletons match.
 */
export async function recoverDevice(
  client: OpenStoaClient,
  recoveredMasterKey: Uint8Array,
  hostSecureStore: HostSecureStore,
  hostLocalStore?: HostSecureStore,
): Promise<void> {
  const rootStore = adapt(hostSecureStore)!;
  await km.installMasterKey(rootStore, recoveredMasterKey);
  _masterKeyPromise = Promise.resolve(recoveredMasterKey);
  _store = null;
  _takStore = null; // rebuild under the recovered key
  const tak = getTakSessionStore(client, hostSecureStore, hostLocalStore);
  const keychain = await km.restoreTakKeychain(recoveredMasterKey, () => keyBackupHttp(client).getTakBackup());
  if (keychain) await tak.importKeychain(keychain);
}

/**
 * Decrypt a server chat row for display via the live MLS session. User rows
 * carry a sealed body → decrypt into `message`; system rows (join/leave) pass
 * through. Undecryptable (pre-join epoch — forward secrecy) fails soft to a
 * placeholder. Replaces the Phase 1 placeholder `toDisplayMessage`.
 */
export async function toDisplayMessageMls(
  store: MlsSessionStore,
  topicId: string,
  raw: ChatMessage,
): Promise<ChatMessage> {
  if (raw?.type === 'message') {
    let text = '';
    if (raw.sealed?.ciphertext) {
      // openCached: MLS consumes per-message keys on first decrypt, so cache the
      // plaintext by id → message history survives app restarts.
      const opened = raw.id
        ? await store.openCached(topicId, raw.id, raw.sealed)
        : await store.open(topicId, raw.sealed);
      text = opened ?? '[unable to decrypt]';
    }
    return { ...raw, message: text };
  }
  return raw;
}
