/**
 * Browser wiring for the MLS session manager: an HTTP transport over the
 * Delivery Service REST endpoints (cookie-authenticated) + a lazy per-device
 * singleton store. Browser-only — every entry point is called from client
 * event handlers / effects, never during SSR.
 */
import { MlsSessionStore, type MlsTransport, type SecureKVStore } from './mlsSession';

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

let _store: MlsSessionStore | null = null;
export function getMlsSessionStore(): MlsSessionStore {
  if (!_store) {
    // One IndexedDB store backs both the MLS ClientState and the decrypted
    // message cache; keys are namespaced (mls.state.* / mls.identity / mls.msg.*).
    const idb = indexedDbStore();
    _store = new MlsSessionStore(httpTransport(), deviceIdentity(), idb, idb);
  }
  return _store;
}
