/**
 * Browser wiring for the MLS session manager: an HTTP transport over the
 * Delivery Service REST endpoints (cookie-authenticated) + a lazy per-device
 * singleton store. Browser-only — every entry point is called from client
 * event handlers / effects, never during SSR.
 */
import { MlsSessionStore, type MlsTransport, type SecureKVStore } from './mlsSession';
import { TakSessionStore, type TakTransport, type TakBundleRow, type ArchiveEntry } from './takSession';
import * as km from './keyManager';

function httpTransport(): MlsTransport {
  const base = (t: string) => `/api/topics/${t}/mls`;
  const json = { 'Content-Type': 'application/json' };
  return {
    async getGroupInfo(topicId) {
      const r = await fetch(`${base(topicId)}/group-info`, { credentials: 'include' });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`group-info GET ${r.status}`);
      return (await r.json()).groupInfo as string;
    },
    async postGroupInfo(topicId, groupInfoB64, groupIdB64) {
      const r = await fetch(`${base(topicId)}/group-info`, {
        method: 'POST',
        credentials: 'include',
        headers: json,
        body: JSON.stringify({ groupInfo: groupInfoB64, groupId: groupIdB64 }),
      });
      if (!r.ok) throw new Error(`group-info POST ${r.status}`);
      return (await r.json()).created as boolean;
    },
    async postCommit(topicId, commitB64, groupInfoB64) {
      const r = await fetch(`${base(topicId)}/commit`, {
        method: 'POST',
        credentials: 'include',
        headers: json,
        body: JSON.stringify({ commit: commitB64, groupInfo: groupInfoB64 }),
      });
      if (r.status === 409) return { ok: false }; // epoch-CAS conflict → caller rebases
      if (!r.ok) throw new Error(`commit POST ${r.status}`);
      return { ok: true, epoch: (await r.json()).epoch as number };
    },
    async getCommitsSince(topicId, sinceEpoch) {
      const r = await fetch(`${base(topicId)}/commit?sinceEpoch=${sinceEpoch}`, { credentials: 'include' });
      if (!r.ok) throw new Error(`commit GET ${r.status}`);
      return (await r.json()).commits;
    },
  };
}

// Stable per-browser-device MLS identity (the leaf credential). Device-scoped,
// not user-scoped — a user's devices are distinct MLS leaves by design.
function deviceIdentity(): string {
  const KEY = 'openstoa.mls.device';
  let id = localStorage.getItem(KEY);
  if (!id) {
    id = `web-${crypto.randomUUID()}`;
    localStorage.setItem(KEY, id);
  }
  return id;
}

// IndexedDB-backed persistence for the live MLS ClientState (~1.7KB/topic), so
// a page reload restores the same leaf instead of re-joining (which dropped
// pre-reload history). Web-only; called lazily from client code.
function indexedDbStore(): SecureKVStore {
  const DB_NAME = 'openstoa-mls';
  const STORE = 'state';
  let dbp: Promise<IDBDatabase> | null = null;
  function openDb(): Promise<IDBDatabase> {
    if (!dbp) {
      dbp = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbp;
  }
  return {
    async get(key) {
      const db = await openDb();
      return new Promise((resolve, reject) => {
        const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
        req.onsuccess = () => resolve((req.result as string | undefined) ?? null);
        req.onerror = () => reject(req.error);
      });
    },
    async set(key, value) {
      const db = await openDb();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    },
  };
}

// Single memoized IndexedDB handle shared by the root (master_key) store and the
// encrypting wrapper — avoids opening multiple connections to the same DB.
let _idb: SecureKVStore | null = null;
function idbStore(): SecureKVStore {
  if (!_idb) _idb = indexedDbStore();
  return _idb;
}

// Phase 4: the device master_key lives (plaintext bytes) in the raw idb under a
// reserved key; everything else (MLS state, TAK keys, message cache) is written
// through EncryptingKVStore, sealed under HKDF(master_key,"local-store"). Memoized.
let _masterKeyPromise: Promise<Uint8Array> | null = null;
function masterKey(): Promise<Uint8Array> {
  if (!_masterKeyPromise) _masterKeyPromise = km.loadOrCreateMasterKey(idbStore());
  return _masterKeyPromise;
}

let _encStore: SecureKVStore | null = null;
function encStore(): SecureKVStore {
  if (!_encStore) _encStore = km.EncryptingKVStore.lazy(idbStore(), masterKey);
  return _encStore;
}

let _store: MlsSessionStore | null = null;
export function getMlsSessionStore(): MlsSessionStore {
  if (!_store) {
    // MLS ClientState + decrypted message cache, both at-rest encrypted under the
    // master_key. Keys are namespaced (mls.state.* / mls.identity / mls.msg.*).
    const s = encStore();
    _store = new MlsSessionStore(httpTransport(), deviceIdentity(), s, s);
  }
  return _store;
}

// HTTP transport for the Phase 3 TAK layer (archive + bundle endpoints). The
// server is crypto-free — this only moves opaque ciphertext.
function httpTakTransport(): TakTransport {
  const base = (t: string) => `/api/topics/${t}`;
  const json = { 'Content-Type': 'application/json' };
  return {
    async postArchive(topicId, messageId, takVersion, archiveB64) {
      const r = await fetch(`${base(topicId)}/archive`, {
        method: 'POST',
        credentials: 'include',
        headers: json,
        body: JSON.stringify({ messageId, takVersion, archive: archiveB64 }),
      });
      if (!r.ok && r.status !== 200) throw new Error(`archive POST ${r.status}`);
    },
    async getArchive(topicId) {
      // Walk the keyset cursor to completion so callers get the full archive.
      const out: ArchiveEntry[] = [];
      let cursor = '';
      for (;;) {
        const r = await fetch(`${base(topicId)}/archive?limit=500${cursor}`, { credentials: 'include' });
        if (!r.ok) throw new Error(`archive GET ${r.status}`);
        const page = (await r.json()).archive as ArchiveEntry[];
        out.push(...page);
        if (page.length < 500) break;
        const last = page[page.length - 1];
        cursor = `&since=${encodeURIComponent(last.createdAt)}&sinceMsg=${last.messageId}`;
      }
      return out;
    },
    async postBundle(topicId, recipientUserId, recipientDeviceId, bundleB64, scope) {
      const r = await fetch(`${base(topicId)}/tak/bundles`, {
        method: 'POST',
        credentials: 'include',
        headers: json,
        body: JSON.stringify({ recipientUserId, recipientDeviceId, bundle: bundleB64, scope }),
      });
      if (!r.ok) throw new Error(`bundle POST ${r.status}`);
    },
    async getBundles(topicId, deviceId) {
      const r = await fetch(`${base(topicId)}/tak/bundles?deviceId=${encodeURIComponent(deviceId)}`, {
        credentials: 'include',
      });
      if (!r.ok) throw new Error(`bundle GET ${r.status}`);
      return (await r.json()).bundles as TakBundleRow[];
    },
    async ackBundles(topicId, deviceId, ids) {
      const r = await fetch(`${base(topicId)}/tak/bundles`, {
        method: 'DELETE',
        credentials: 'include',
        headers: json,
        body: JSON.stringify({ deviceId, ids }),
      });
      if (!r.ok) throw new Error(`bundle DELETE ${r.status}`);
    },
  };
}

// Debounced upload of the master_key-encrypted TAK keychain to the server, so a
// recovered master_key re-reads all archived history with no other member online
// (design §6.4.1). Fired after any TAK write; best-effort (a failure never breaks
// chat — the local keychain is still authoritative).
let _takBackupTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleTakKeychainBackup(): void {
  if (_takBackupTimer) clearTimeout(_takBackupTimer);
  _takBackupTimer = setTimeout(() => {
    void (async () => {
      try {
        const keychain = await getTakSessionStore().exportKeychain();
        if (Object.keys(keychain).length === 0) return;
        await km.uploadTakKeychain(await masterKey(), keychain, async (ciphertext) => {
          const r = await fetch('/api/keys/tak-backup', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ciphertext }),
          });
          if (!r.ok) throw new Error(`tak-backup POST ${r.status}`);
        });
      } catch {
        /* best-effort backup; retried on the next keychain change */
      }
    })();
  }, 1500);
}

let _takStore: TakSessionStore | null = null;
export function getTakSessionStore(): TakSessionStore {
  if (!_takStore) {
    // Reuse the encrypting store (TAK keys namespaced tak.root.* / tak.epoch.*)
    // and the live MLS session store for group-state reads. onKeychainChange
    // schedules the encrypted server backup.
    _takStore = new TakSessionStore(getMlsSessionStore(), httpTakTransport(), encStore(), scheduleTakKeychainBackup);
  }
  return _takStore;
}

// ---------------------------------------------------------------------------
// Phase 4 key-backup client (used by the recovery / induction UI, P4-05)
// ---------------------------------------------------------------------------

/** The device's master_key (loaded/created on first call). */
export function getDeviceMasterKey(): Promise<Uint8Array> {
  return masterKey();
}

/** HTTP client for /api/keys/backup + /api/keys/tak-backup (cookie auth). */
export function keyBackupHttp() {
  const json = { 'Content-Type': 'application/json' };
  return {
    async getBackup(): Promise<km.KeyBackupState> {
      const r = await fetch('/api/keys/backup', { credentials: 'include' });
      if (!r.ok) throw new Error(`keys/backup GET ${r.status}`);
      return (await r.json()) as km.KeyBackupState;
    },
    async postRecovery(wrappedMasterB64: string): Promise<void> {
      const r = await fetch('/api/keys/backup', {
        method: 'POST',
        credentials: 'include',
        headers: json,
        body: JSON.stringify({ type: 'recovery', wrappedMaster: wrappedMasterB64 }),
      });
      if (!r.ok) throw new Error(`keys/backup POST recovery ${r.status}`);
    },
    async postPasskey(credentialId: string, prfWrappedB64: string): Promise<void> {
      const r = await fetch('/api/keys/backup', {
        method: 'POST',
        credentials: 'include',
        headers: json,
        body: JSON.stringify({ type: 'passkey', credentialId, prfWrapped: prfWrappedB64 }),
      });
      if (!r.ok) throw new Error(`keys/backup POST passkey ${r.status}`);
    },
    async getTakBackup(): Promise<string | null> {
      const r = await fetch('/api/keys/tak-backup', { credentials: 'include' });
      if (!r.ok) throw new Error(`keys/tak-backup GET ${r.status}`);
      return (await r.json()).ciphertext as string | null;
    },
  };
}

/**
 * Install a recovered master_key on this device and restore the TAK keychain from
 * the server backup (recovery path). After this, chat re-joins MLS as a new leaf
 * and reads all archived history the recovered keychain covers.
 */
export async function recoverDevice(recoveredMasterKey: Uint8Array): Promise<void> {
  await km.installMasterKey(idbStore(), recoveredMasterKey);
  _masterKeyPromise = Promise.resolve(recoveredMasterKey); // refresh memo for the encrypting store
  _encStore = null;
  _store = null;
  _takStore = null; // rebuild stores under the recovered key
  const keychain = await km.restoreTakKeychain(recoveredMasterKey, () => keyBackupHttp().getTakBackup());
  if (keychain) await getTakSessionStore().importKeychain(keychain);
}
