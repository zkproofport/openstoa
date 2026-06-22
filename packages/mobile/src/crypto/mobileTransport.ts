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

let _store: MlsSessionStore | null = null;
export function getMlsSessionStore(
  client: OpenStoaClient,
  hostSecureStore?: HostSecureStore,
  hostLocalStore?: HostSecureStore,
): MlsSessionStore {
  if (!_store) {
    // MLS ClientState → host secure store (Keychain/Keystore) so an app restart
    // restores the same leaf instead of re-joining (which dropped history).
    const store: SecureKVStore | undefined = hostSecureStore
      ? { get: (k) => hostSecureStore.getItem(k), set: (k, v) => hostSecureStore.setItem(k, v) }
      : undefined;
    // Decrypted-message cache → host local store (AsyncStorage). MLS keys are
    // consumed on first decrypt, so cached plaintext is what makes message
    // history survive restarts. Absent stores → in-memory only (prior behavior).
    const msgCache: SecureKVStore | undefined = hostLocalStore
      ? { get: (k) => hostLocalStore.getItem(k), set: (k, v) => hostLocalStore.setItem(k, v) }
      : undefined;
    _store = new MlsSessionStore(createMlsTransport(client), deviceIdentity(), store, msgCache);
  }
  return _store;
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
