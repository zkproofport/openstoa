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
import {
  TakSessionStore,
  type TakTransport,
  type TakBundleRow,
  type ArchiveEntry,
  type ArchiveRootIdentity,
  type ArchiveRootClaim,
} from './takSession';
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
    async getRootFingerprint(topicId) {
      try {
        return await client.get<ArchiveRootIdentity>(`${base(topicId)}/tak/root-fingerprint`);
      } catch (e) {
        // 400 = not a public topic, 404 = topic gone. Neither is a failure to
        // report: those topics have no shared archive root at all, so the honest
        // answer is "nothing published". Anything else (offline, 5xx) must
        // propagate so callers fail safe instead of minting a root blind.
        const s = statusOf(e);
        if (s === 400 || s === 404) return { fingerprint: null, archiveCount: 0 };
        throw e;
      }
    },
    async setRootFingerprint(topicId, fingerprint) {
      return client.put<ArchiveRootClaim>(`${base(topicId)}/tak/root-fingerprint`, { fingerprint });
    },
  };
}

/**
 * What an attempt to put this device's TAK keychain on the server did. Mirrors
 * the web twin (`src/lib/mls/webTransport.ts`) — see there for why a
 * USER-FACING caller has to tell these apart.
 */
export type TakBackupOutcome = 'uploaded' | 'empty' | 'present' | 'untrusted' | 'failed';

/**
 * Would uploading from this device DESTROY the account's recovery snapshot?
 *
 * `POST /api/keys/tak-backup` upserts a single row per user. A device that
 * minted its own master_key would replace a keychain sealed under the REAL key
 * with one only it can open, and the user's recovery code would then restore a
 * keychain that decrypts to nothing. So: skip only when a backup exists, this
 * device's key cannot open it, AND something can still produce the real key. If
 * nothing can, the existing row is already unrecoverable and replacing it is
 * strictly better than leaving it.
 *
 * This is the same rule web enforces through `getDeviceKeyState() === 'recoverable'`.
 */
async function readBackedUpKeychain(
  client: OpenStoaClient,
  rootStore: SecureKVStore,
): Promise<Record<string, string> | 'clobber'> {
  const http = keyBackupHttp(client);
  const blob = await http.getTakBackup();
  if (!blob) return {}; // nothing on the server to lose
  const opened = await km.restoreTakKeychain(await masterKey(rootStore), async () => blob);
  if (opened) return opened; // our key opens it → merge into it
  const wraps = await http.getBackup();
  const clobber = wraps.passkeys.length > 0 || !!wraps.wrappedMaster;
  report('clobber-check', {
    serverBytes: blob.length,
    opensWithOurKey: false,
    passkeys: wraps.passkeys.length,
    wrappedMaster: !!wraps.wrappedMaster,
    verdict: clobber,
  });
  // Something can still produce the real key, so the snapshot is somebody's
  // history — leave it. Otherwise NOTHING can ever open it again, so preserving
  // it protects nobody: treat it as absent and let our keys take its place.
  return clobber ? 'clobber' : {};
}

/**
 * Why this path narrates itself: every failure inside it used to collapse into
 * one swallowed `catch` returning 'failed', so on a real device a missing key,
 * an expired session and a thrown fingerprint check were indistinguishable —
 * and each wrong guess cost a full rebuild-and-reinstall cycle to disprove.
 *
 * Only key NAMES, counts and booleans are reported. No key material, no
 * ciphertext, no message content.
 */
// The client to narrate through. `console.log` alone was useless here: a release
// build runs Hermes, whose console output never reaches the native log, so a
// device console capture showed 402 lines of native chatter and not one line of
// ours. The server sink is the only channel that actually arrives.
let _diagClient: OpenStoaClient | null = null;

/** Remember the authenticated client so `report` has somewhere to send to. */
function armDiagnostics(client: OpenStoaClient): void {
  _diagClient = client;
}

export function report(step: string, detail: Record<string, unknown>): void {
  try {
    console.log('[TAKBACKUP]', step, JSON.stringify(detail));
    // Fire-and-forget: diagnosing a failure must never cause one.
    void _diagClient?.post('/api/diag/e2ee', { step, detail }).catch(() => {});
  } catch {
    // Diagnostics must never be the thing that breaks chat.
  }
}

/**
 * Topic ids to probe for keys the manifest never recorded. `/api/topics` returns
 * exactly the caller's joined topics when authenticated. Best-effort: a failure
 * here narrows the diagnosis, it does not stop the backup.
 */
async function joinedTopicIds(client: OpenStoaClient): Promise<string[]> {
  try {
    const res = await client.get<{ topics?: { id: string }[] } | { id: string }[]>('/api/topics');
    const list = Array.isArray(res) ? res : (res.topics ?? []);
    return list.map((t) => t.id).filter(Boolean);
  } catch (e) {
    report('probe-topics-failed', { error: String(e) });
    return [];
  }
}

/**
 * The ONE uploader. Every call site — the debounced key-change hook, recovery
 * setup, and the session-boot repair — routes through here so the trust guards
 * cannot be bypassed by adding a second one.
 */
async function pushTakKeychain(
  client: OpenStoaClient,
  rootStore: SecureKVStore,
  tak: TakSessionStore,
  probeTopicIds: string[] = [],
): Promise<TakBackupOutcome> {
  try {
    // MERGE, NEVER REPLACE. The row is one per user and the POST overwrites it
    // whole, so a device that uploads only what it happens to hold DELETES every
    // key it does not — and holding the account's real key makes that device look
    // maximally trustworthy while it does so. That is not hypothetical: a browser
    // that had just recovered wrote its 2 keys over the account's 6 and re-locked
    // history the user could read minutes earlier.
    const base = await readBackedUpKeychain(client, rootStore);
    if (base === 'clobber') return 'untrusted';

    // Names and counts of what this device actually holds, logged BEFORE the
    // export so an empty result can be read as "no keys" or "keys the manifest
    // never listed" rather than guessed at. Isolated: a diagnostic that can fail
    // the upload it is diagnosing is worse than no diagnostic.
    try {
      report('diagnose', await tak.diagnoseKeychain(probeTopicIds));
    } catch (e) {
      report('diagnose-failed', { error: String(e) });
    }
    // `exportKeychain` drops orphan roots and THROWS when it cannot check one,
    // so an unverified root can never reach the account's single backup row.
    const mine = await tak.exportKeychain();
    const merged = { ...base, ...mine };
    const keys = Object.keys(merged);
    report('export', { mine: Object.keys(mine).length, backedUp: Object.keys(base).length, merged: keys.length });
    if (keys.length === 0) return 'empty';
    if (keys.length === Object.keys(base).length) {
      // Nothing of ours was missing. Re-uploading an identical map is pure churn.
      report('already-covered', { count: keys.length });
      return 'present';
    }
    await km.uploadTakKeychain(await masterKey(rootStore), merged, (ciphertext) =>
      client.post('/api/keys/tak-backup', { ciphertext }),
    );
    report('uploaded', { was: Object.keys(base).length, now: keys.length });
    return 'uploaded';
  } catch (e) {
    report('failed', { error: String(e) });
    return 'failed';
  }
}

/** Upload this device's TAK keychain now (recovery setup calls this). */
export async function uploadTakKeychainNow(
  client: OpenStoaClient,
  hostSecureStore: HostSecureStore,
  hostLocalStore?: HostSecureStore,
  probeTopicIds?: string[],
): Promise<TakBackupOutcome> {
  armDiagnostics(client);
  const rootStore = adapt(hostSecureStore);
  if (!rootStore) {
    report('no-secure-store', {});
    return 'failed';
  }
  return pushTakKeychain(
    client,
    rootStore,
    getTakSessionStore(client, hostSecureStore, hostLocalStore),
    probeTopicIds ?? (await joinedTopicIds(client)),
  );
}

/**
 * Idempotent repair: make sure the account HAS a TAK-keychain backup.
 *
 * The defect this exists for: `tak_key_backups` was only ever written by the
 * key-CHANGE hook below, which fires when a key is newly WRITTEN. A user who
 * already held their keys and then set recovery up got a `key_backups` row and
 * an EMPTY `tak_key_backups` — recovery came back, opened nothing, and opening
 * a chat wrote no new key so the change hook never fired again. Every account
 * already in that state needs a trigger that does not depend on writing a key.
 *
 * Runs when the session is established, NOT on chat-room entry: the backup is
 * account-level (one row per user, covering every topic), so binding its repair
 * to entering one room is what let the gap persist.
 */
export async function ensureTakKeychainBackup(
  client: OpenStoaClient,
  hostSecureStore: HostSecureStore,
  hostLocalStore?: HostSecureStore,
): Promise<TakBackupOutcome> {
  armDiagnostics(client);
  let existing: string | null = null;
  try {
    existing = await keyBackupHttp(client).getTakBackup();
  } catch (e) {
    // Claim nothing when the server cannot be read — never upload on a guess.
    report('ensure/read-failed', { error: String(e) });
    return 'failed';
  }
  report('ensure', { hasServerBackup: !!existing, serverBytes: existing?.length ?? 0 });
  // Deliberately NOT "a row exists, so we are done". That short-circuit is a
  // one-way door: once any device writes a partial snapshot, every device holding
  // the missing keys sees a row and stays quiet, so the account can never climb
  // back out. The uploader merges and reports 'present' by itself when it finds
  // nothing to add — same cheap outcome, without the trap.
  return uploadTakKeychainNow(client, hostSecureStore, hostLocalStore);
}

// Debounced upload of the master_key-encrypted TAK keychain (design §6.4.1) so a
// recovered master_key re-reads all archived history without another member
// online. Best-effort; a failure never breaks chat.
let _takBackupTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleTakKeychainBackup(client: OpenStoaClient, rootStore: SecureKVStore): void {
  if (_takBackupTimer) clearTimeout(_takBackupTimer);
  _takBackupTimer = setTimeout(() => {
    // retried on the next keychain change
    if (_takStore) void pushTakKeychain(client, rootStore, _takStore);
  }, 1500);
}

let _takStore: TakSessionStore | null = null;
export function getTakSessionStore(
  client: OpenStoaClient,
  hostSecureStore?: HostSecureStore,
  hostLocalStore?: HostSecureStore,
): TakSessionStore {
  armDiagnostics(client);
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
 *
 * FAILURE IS PER-ROW, NEVER PER-PAGE. Callers map this over a whole history page
 * through `Promise.all` (ChatRoomScreen), so a single REJECTION would discard
 * every sibling row and blank the list. A throw from anywhere below — a failed
 * MLS bootstrap/rejoin, an unreadable key store, a corrupt cached row — must
 * therefore degrade to the same '[unable to decrypt]' placeholder that a plain
 * `null` produces, for THAT row only. This mirrors the web twin
 * (openstoa/src/components/ChatPanel.tsx `toDisplayMessage`).
 */
export async function toDisplayMessageMls(
  store: MlsSessionStore,
  topicId: string,
  raw: ChatMessage,
): Promise<ChatMessage> {
  if (raw?.type === 'message') {
    let text = '';
    if (raw.sealed?.ciphertext) {
      try {
        // openCached: MLS consumes per-message keys on first decrypt, so cache the
        // plaintext by id → message history survives app restarts.
        const opened = raw.id
          ? await store.openCached(topicId, raw.id, raw.sealed)
          : await store.open(topicId, raw.sealed);
        text = opened ?? '[unable to decrypt]';
      } catch {
        text = '[unable to decrypt]';
      }
    }
    return { ...raw, message: text };
  }
  return raw;
}
