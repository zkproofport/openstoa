/**
 * Mobile wiring for the MLS session manager: an MlsTransport over the host's
 * authenticated OpenStoaClient (Bearer), plus a per-session device identity.
 *
 * The client throws `OpenStoaApiError` on non-2xx, and its `status` is what maps
 * 404 (no group yet) / 409 (epoch-CAS conflict) the way the session manager
 * expects.
 *
 * Device identity + MLS state are in-memory for the app session (Keychain/
 * Keystore persistence + reload resilience are a follow-up, mirroring the web
 * IndexedDB follow-up).
 */
import { UNREADABLE_BODY } from '@openstoa/api-types';
import type { ChatMessage } from '@openstoa/api-types';
import type { OpenStoaClient } from '../api/openstoaClient';
import { rateLimitedUntil } from '../api/openstoaClient';
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
import { BackupRetry } from './backupRetry';
import { b64, unb64 } from './keyBackup';
import { ackDelivery } from '../lib/chatDeliveryAck';

/**
 * The HTTP status of a failed request, or null if it did not come from one.
 *
 * READ OFF THE ERROR, not out of its text. This used to regex `err.message`
 * for `→ 404:`, which held only while that message happened to be the
 * flattened `METHOD path → STATUS: body` string. When `OpenStoaApiError`
 * started putting the server's own SENTENCE in `message` (so screens could
 * show a refusal instead of the API's shape) and moved the flattened form to
 * `debugMessage`, this quietly began returning null for every request.
 *
 * The damage was not a bad log line. `getGroupInfo` maps 404 to "no group
 * yet"; with the status unreadable it rethrew instead, so MLS bootstrap never
 * reached its genesis branch and every topic created on this client got NO
 * `mls_groups` row — a room where nobody, ever, can send a message. `postCommit`
 * lost its 409 epoch-CAS retry the same way. Both failed in silence.
 *
 * Duck-typed on `kind` rather than `instanceof`: the same class arriving
 * through two module instances is a real hazard in a mini-app bundled into a
 * host, and an identity check that fails there would reintroduce exactly this
 * bug. The regex stays only as a fallback for anything still throwing the old
 * flattened string.
 */
function statusOf(e: unknown): number | null {
  const api = e as { kind?: unknown; status?: unknown } | null;
  if (api && api.kind === 'API_ERROR' && typeof api.status === 'number') {
    return api.status;
  }
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

/*
 * FIRST-RUN SEED for this device's MLS leaf credential — not the identity.
 *
 * The comment here used to say the identity was in-memory and that a restart
 * re-bootstrapped a fresh leaf. That has not been true since `mlsSession`
 * started persisting `mls.identity` (see its `mintIdentity`): this value is
 * consulted only when nothing is stored yet, and the stored one is reused
 * forever after — changing it would orphan the saved group state, whose key is
 * derived from it. Left stale, the note reads as a leaf-churn bug that does not
 * exist, and it is exactly the kind of thing that gets "fixed".
 */
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
  // rootStore is passed twice on purpose: once to load the live master_key, once
  // so reads can fall back to the key used before recovery — otherwise recovery
  // silently empties this device's own history.
  return km.EncryptingKVStore.lazy(raw, () => masterKey(rootStore), rootStore);
}

/**
 * Acknowledge delivery for this device (R-1) — the mini-app's transport half.
 *
 * The rule (which instant may be claimed, and that a failure must be silent)
 * lives in the twinned `lib/chatDeliveryAck`; only the POST is here, because
 * the browser sends a cookie and this sends the host's Bearer.
 */
export function ackDeliveryMls(
  client: OpenStoaClient,
  topicId: string,
  messages: readonly { id?: string; createdAt: string; message?: string | null }[],
  hostSecureStore?: HostSecureStore,
  hostLocalStore?: HostSecureStore,
): void {
  /*
   * Translate this platform's "unreadable" into the shared rule's.
   *
   * The web client carries an `undecryptable` FLAG and `chatDeliveryAck.claimable`
   * reads it; the mini-app carries the `UNREADABLE_BODY` SENTINEL instead,
   * because its back-fill, its locked count and its sync filter all match on that
   * exact string. Without this mapping the rule would see no flag, judge every
   * locked row claimable, and acknowledge ciphertext this device cannot read —
   * which is the one mistake that makes the server delete the copy the device is
   * still waiting for. The two representations meet HERE rather than in the
   * shared rule, which has no business knowing a platform's placeholder text.
   */
  const shaped = messages.map((m) => ({
    id: m.id,
    createdAt: m.createdAt,
    undecryptable: m.message === UNREADABLE_BODY,
  }));
  void ackDelivery(topicId, shaped, {
    deviceId: () => getTakSessionStore(client, hostSecureStore, hostLocalStore).myDeviceId(topicId),
    post: async (t, deviceId, through) => {
      await client.post(`/api/topics/${t}/chat/delivered`, { deviceId, through });
    },
  });
}

/**
 * The signed-in account, for naming this device's MLS leaf `<userId>:<deviceId>`
 * so a later removal can find every device the account owns. Null on failure —
 * chat still works, only attribution is lost, and a guessed id would be worse.
 */
async function sessionUserId(client: OpenStoaClient): Promise<string | null> {
  try {
    const d = await client.request<{ userId?: string }>('/api/auth/session');
    return d?.userId ?? null;
  } catch {
    return null;
  }
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
    /*
     * `rawSecure` — NOT `store` — for the device identity.
     *
     * `store` is sealed under the master_key, and an unopenable value there reads
     * as absent, which mints a new leaf and orphans the epochs this device already
     * holds. The identity is `<userId>:<deviceId>`, which the server already keeps
     * in plain text, so there is nothing to protect by sealing it and everything
     * to lose. See the `identityStore` parameter on `MlsSessionStore`.
     */
    _store = new MlsSessionStore(
      createMlsTransport(client),
      deviceIdentity(),
      store,
      msgCache,
      () => sessionUserId(client),
      rawSecure,
    );
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
    async getArchive(topicId, since, limit) {
      const out: ArchiveEntry[] = [];
      /*
       * `pageSize` is what goes on the wire; `limit` is what the caller asked
       * for. A caller that wants one row must not be handed 500 and then have
       * 499 thrown away — the cost is the transfer, not the slice.
       */
      const pageSize = Math.min(limit ?? 500, 500);
      // Resume where the device left off. `since` is what makes a re-entry cost
      // the delta instead of the conversation; the loop below still exists for
      // a first visit, or for a device that has been away long enough to owe
      // more than one page.
      let cursor = since
        ? `&since=${encodeURIComponent(since.createdAt)}&sinceMsg=${encodeURIComponent(since.messageId)}`
        : '';
      for (;;) {
        const r = await client.get<{ archive: ArchiveEntry[] }>(`${base(topicId)}/archive?limit=${pageSize}${cursor}`);
        out.push(...r.archive);
        if (limit !== undefined || r.archive.length < pageSize) break;
        const last = r.archive[r.archive.length - 1];
        cursor = `&since=${encodeURIComponent(last.createdAt)}&sinceMsg=${encodeURIComponent(last.messageId)}`;
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
    async getServerRoot(topicId) {
      try {
        const r = await client.get<{ rootKey?: string } | null>(`${base(topicId)}/archive/root`);
        const k = r?.rootKey;
        return typeof k === 'string' && k.length > 0 ? unb64(k) : null;
      } catch (e) {
        // 204 = nothing deposited yet; 403 = a tier that keeps its key on
        // devices; 404 = topic gone. All three mean "the server has nothing for
        // you", which is an answer, not a failure. Anything else propagates.
        const st = statusOf(e);
        if (st === 204 || st === 403 || st === 404) return null;
        throw e;
      }
    },
    async putServerRoot(topicId, root) {
      try {
        await client.put(`${base(topicId)}/archive/root`, { rootKey: b64(root) });
        return true;
      } catch (e) {
        // 409 = somebody deposited a different key first. A normal race: the
        // caller reads theirs rather than keeping a key nothing was sealed
        // under.
        if (statusOf(e) === 409) return false;
        throw e;
      }
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
/*
 * RETRIED UNTIL IT LANDS, not "until the next keychain change".
 *
 * That comment used to sit on the line below and it was the whole retry policy.
 * It holds for somebody who writes keys often; the person this backup exists
 * for may not touch one for weeks, so a single failed upload meant no backup at
 * all — while the app still handed them a recovery code that would come back
 * and open nothing. `BackupRetry` climbs a ladder and WRAPS back to the fast
 * end rather than settling at the ceiling, because the failure that lasts is
 * usually a phone that was somewhere without signal, and that phone deserves a
 * quick attempt soon after it returns. See `@openstoa/mls`'s `backupRetry.ts`.
 */
/*
 * ONE retry for the whole process, whoever asks for it.
 *
 * Two callers want an upload — a keychain write, and `RecoveryRepair` finding
 * the account has no backup. Giving each its own ladder would put two uploads
 * on the same account, and the upload MERGES local keys into whatever the
 * server holds, so the later write can drop what the earlier one added. One
 * instance, and the newest caller supplies the closure.
 */
let _takBackupRetry: BackupRetry | null = null;
let _takBackupUpload: (() => Promise<boolean>) | null = null;

/**
 * Which outcomes mean the account is backed up.
 *
 * `empty` and `present` are done — there was nothing to send, or the server
 * already had it. `untrusted` is NOT: the server row could not be safely merged
 * (see the clobber guard), so this device's keys are not up there, and the
 * condition clears on its own once the right master_key is loaded. Retrying it
 * costs one GET on a widening schedule and is the difference between a backup
 * that arrives late and one that never arrives.
 */
function landed(outcome: TakBackupOutcome): boolean {
  return outcome === 'uploaded' || outcome === 'present' || outcome === 'empty';
}

function takBackupRetry(): BackupRetry {
  if (!_takBackupRetry) {
    _takBackupRetry = new BackupRetry(
      async () => (await _takBackupUpload?.()) ?? false,
      { setTimeout, clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) },
      (e) => report('backup/retry', { ...e }),
    );
  }
  return _takBackupRetry;
}

function scheduleTakKeychainBackup(client: OpenStoaClient, rootStore: SecureKVStore): void {
  _takBackupUpload = async () => {
    /*
     * DO NOT SPEND A REQUEST WHILE THE EDGE IS BANNING US.
     *
     * Every request during the pause counts towards it, so a retry here is the
     * one thing guaranteed to keep the ban alive. Reporting `false` leaves the
     * schedule alone: it will come back on its own, by which time the clock has
     * run down. Measured 2026-08-27 — the phone banned itself and its own
     * retries held it there.
     */
    const until = rateLimitedUntil();
    if (Date.now() < until) {
      report('backup/paused', { untilMs: until });
      return false;
    }
    return _takStore ? landed(await pushTakKeychain(client, rootStore, _takStore)) : false;
  };
  takBackupRetry().schedule();
}

/**
 * Keep trying an account-level backup that just failed.
 *
 * `RecoveryRepair` runs `ensureTakKeychainBackup` once per account per launch
 * and then latches on the user id. Without this, a failure there waited for the
 * app to be killed and reopened — and nothing told the person that was what was
 * needed, because the repair is silent by design.
 */
export function retryTakKeychainBackup(
  client: OpenStoaClient,
  hostSecureStore: HostSecureStore,
  hostLocalStore?: HostSecureStore,
): void {
  _takBackupUpload = async () =>
    landed(await uploadTakKeychainNow(client, hostSecureStore, hostLocalStore));
  takBackupRetry().schedule();
}

/** Sign-out and erase: stop trying, and forget who we were trying for. */
export function stopTakKeychainBackupRetry(): void {
  _takBackupRetry?.cancel();
  _takBackupUpload = null;
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
    /*
     * Decrypted history goes to the LOCAL store, not the Keychain, and is
     * encrypted at rest under the same master key as everything else here.
     *
     * The split matches what each holds. TAK material is small, permanent and
     * unrecoverable once an epoch advances, which is what the Keychain is for.
     * History is bulk, bounded, and re-derivable from the archive at any time —
     * putting hundreds of kilobytes of it in the Keychain would crowd the one
     * store whose contents cannot be rebuilt. Same choice `msgCache` already
     * makes for MLS plaintext.
     */
    const rawLocal = adapt(hostLocalStore);
    const historyStore = encrypting(rawLocal, rawSecure) ?? undefined;
    _takStore = new TakSessionStore(
      getMlsSessionStore(client, hostSecureStore, hostLocalStore),
      createTakTransport(client),
      store,
      onChange,
      historyStore,
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
 * How far a recovery got.
 *
 * `recovered` — master key in, chat keys in. `no-keys-yet` — master key in, and
 * the account has no chat-key snapshot to restore, which is the right outcome
 * for someone who had not chatted yet. `keys-pending` — master key in, the
 * snapshot could not be READ this time; the boot-time repair retries it.
 *
 * None of these is a failure: the step that cannot be repeated is the master
 * key, and it succeeded in all three.
 */
export type RecoverOutcome = 'recovered' | 'no-keys-yet' | 'keys-pending';

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
): Promise<RecoverOutcome> {
  const rootStore = adapt(hostSecureStore)!;
  await km.installMasterKey(rootStore, recoveredMasterKey);
  _masterKeyPromise = Promise.resolve(recoveredMasterKey);
  _store = null;
  _takStore = null; // rebuild under the recovered key
  const tak = getTakSessionStore(client, hostSecureStore, hostLocalStore);

  /*
   * THE MASTER KEY IS ALREADY IN. A failure from here is not a failed recovery.
   *
   * WHAT HAPPENED, on a phone 2026-08-27. The read of the chat-key bundle was
   * refused once — the edge was rate-limiting us — and the throw travelled all
   * the way to the screen, which told the person their recovery had failed. It
   * had not: the half that cannot be retried, installing the master key, was
   * already durable, and the half that failed is retried on its own by the
   * boot-time repair. Reporting "failed" for that costs the person the one
   * thing they came to do, and invites them to burn their code again.
   */
  let keychain: Record<string, string> | null = null;
  try {
    keychain = await km.restoreTakKeychain(recoveredMasterKey, () =>
      keyBackupHttp(client).getTakBackup(),
    );
  } catch (e) {
    report('recover/keychain-read-failed', { error: String(e) });
    bumpCryptoGeneration();
    return 'keys-pending';
  }
  if (keychain) await tak.importKeychain(keychain);
  // Last, so listeners see a device whose keys are already in place.
  bumpCryptoGeneration();
  return keychain ? 'recovered' : 'no-keys-yet';
}

/**
 * The MLS leaf identity this device has persisted, or null if it has none yet.
 *
 * Read from the RAW secure store, not the encrypting one, because that is where
 * `mlsSession` puts it — see the `identityStore` note in `getMlsSessionStore`.
 * Exported for the device-data erase, which needs it to derive the
 * `mls.state.<identity>.<topicId>` key names: the Keychain cannot be
 * enumerated, so a key nobody can name survives a wipe.
 */
export async function readDeviceIdentity(hostSecureStore?: HostSecureStore): Promise<string | null> {
  const raw = adapt(hostSecureStore);
  if (!raw) return null;
  try {
    return await raw.get('mls.identity');
  } catch {
    return null;
  }
}

/**
 * Drop every in-process handle to this device's chat keys.
 *
 * WHY AN ERASE IS NOT FINISHED WITHOUT IT. `_masterKeyPromise`, `_store` and
 * `_takStore` are module singletons holding a live master_key and open
 * sessions. Deleting the stored copies while those are alive leaves the key in
 * memory and, worse, leaves writers that will happily persist it again — the
 * next message decrypt re-creates a master_key, and the device the person just
 * erased is quietly re-keyed with something no backup covers.
 *
 * Same three fields `recoverDevice` resets, for the same reason.
 */
/**
 * A COUNTER THAT GOES UP WHENEVER THIS DEVICE'S CHAT KEYS CHANGE.
 *
 * THE DEFECT IT EXISTS FOR, measured on a phone on 2026-08-27. A secret room
 * was left open; the person recovered with their code on another tab and came
 * back. All five epoch keys were restored — the log says so — and the room
 * still read `키를 기다리는 중…` a minute and a half later. Leaving and
 * re-entering opened it at once. Nobody would guess to do that; they read a
 * recovery that "succeeded" over an empty room as their messages being gone.
 *
 * WHY NOTHING NOTICED, and why invalidating the query is not enough on its own
 * — this was tried first and did not work. The room decrypts inside its query
 * function using the MLS session it holds, and that session is the module
 * singleton `_store`, which `recoverDevice` sets to null so the NEXT caller
 * builds a fresh one. The room's next caller is its next RENDER. Invalidating
 * from the recovery screen refetches immediately, while the room still holds
 * the dead session, so the rows come back locked, the entry is fresh again,
 * and returning to the room refetches nothing.
 *
 * So the room has to move first. It subscribes here, a bump re-renders it —
 * which is when it picks up the new session — and only then does it ask for
 * its history again. The ordering is inside the room, where it can be relied
 * on, instead of across two screens where it cannot.
 *
 * ONE COUNTER, NOT ONE PER CALLER. Recovery raises it today because that is
 * the path that was measured. A device RECEIVING epochs another member granted
 * looks like the same shape of hole — `useAccountEvents` applies them app-wide
 * and tells no screen either — but that path has not been reproduced on a
 * device, so it is named here rather than assumed and wired blind. Whoever
 * confirms it raises this counter from wherever the ingest lands; nothing else
 * has to change.
 */
let cryptoGeneration = 0;
const cryptoGenerationListeners = new Set<() => void>();

/** Announce that this device's chat keys changed. Safe to call often. */
export function bumpCryptoGeneration(): void {
  cryptoGeneration += 1;
  for (const fn of cryptoGenerationListeners) {
    try {
      fn();
    } catch {
      // A listener that throws must not stop the others from hearing.
    }
  }
}

/** For `useSyncExternalStore`. */
export function subscribeCryptoGeneration(fn: () => void): () => void {
  cryptoGenerationListeners.add(fn);
  return () => cryptoGenerationListeners.delete(fn);
}

/** For `useSyncExternalStore`. */
export function getCryptoGeneration(): number {
  return cryptoGeneration;
}

export function resetChatCryptoState(): void {
  _masterKeyPromise = null;
  _store = null;
  _takStore = null;
  _identity = null;
  // A pending upload would re-read the store we are about to empty and push
  // whatever it found — or nothing — over the account's real backup. The retry
  // ladder goes with it: an armed retry outlives the state it was retrying for.
  stopTakKeychainBackupRetry();
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
 * therefore degrade to the same `UNREADABLE_BODY` placeholder that a plain
 * `null` produces, for THAT row only. This mirrors the web twin
 * (openstoa/src/components/ChatPanel.tsx `toDisplayMessage`).
 */
/**
 * Re-export. The definition, and the reason it is load-bearing, live in
 * `@openstoa/api-types` — the cipher writes this sentinel, the room screen
 * reads it, and neither calls this module, so none of the three owns it.
 *
 * Kept as an export because callers already import it from here.
 */
export { UNREADABLE_BODY };

export async function toDisplayMessageMls(
  store: MlsSessionStore,
  topicId: string,
  raw: ChatMessage,
): Promise<ChatMessage> {
  /*
   * `notice` decrypts by the same path as `message`, and forgetting that is how
   * it shipped empty.
   *
   * A notice is sealed exactly like a member's message — only its authorship
   * differs (see `messageSide`). This gate used to name `message` alone, so a
   * notice skipped the cache lookup entirely and rendered as an empty bubble on
   * a real phone: no text, no "Waiting for the key…", nothing to read.
   */
  if (raw?.type === 'message' || raw?.type === 'notice') {
    let text = '';
    if (raw.sealed?.ciphertext) {
      try {
        // openCached: MLS consumes per-message keys on first decrypt, so cache the
        // plaintext by id → message history survives app restarts.
        const opened = raw.id
          ? await store.openCached(topicId, raw.id, raw.sealed)
          : await store.open(topicId, raw.sealed);
        text = opened ?? UNREADABLE_BODY;
      } catch {
        text = UNREADABLE_BODY;
      }
    } else if (raw.id) {
      /*
       * NO sealed body: the server reclaimed the live copy once every device in
       * the group at send time had fetched it (R-1). The plaintext may still be
       * on THIS device from when it WAS delivered, and `openCached` checks the
       * message cache before it looks at the sealed body — so an empty one is
       * enough to ask "do we already have this?". A miss falls through to the
       * placeholder below, which is what the archive pass matches on.
       */
      try {
        text = (await store.openCached(topicId, raw.id, { ciphertext: '', epoch: 0 })) ?? '';
      } catch {
        text = '';
      }
    }
    /*
     * A row with no body is NOT an empty message — it is one this device cannot
     * read YET, and it has to say so in the one vocabulary the rest of the
     * screen understands.
     *
     * Everything downstream keys off this exact sentinel: the archive back-fill
     * only rewrites rows equal to it (`ChatRoomScreen` ~:802), the locked count
     * only counts those rows (~:816), and the sync filter only hides those rows
     * while history is still arriving (~:833). An empty string matches none of
     * them, so a purged row whose plaintext this device does not hold rendered
     * as an EMPTY BUBBLE — and, because the back-fill skipped it, stayed empty
     * forever even when the archive could have supplied it. The web twin has
     * never had this shape: it sets `undecryptable: true` and its three states
     * fall out of that flag.
     *
     * Purged and locked deliberately share one sentinel because the DEVICE
     * cannot tell them apart — "the live copy is gone" and "I was not in the
     * group yet" both arrive as no readable body. What separates them is what
     * happens next, and that is not this function's call: the archive pass
     * resolves the first and leaves the second, which is exactly why the row
     * must be visible to that pass rather than silently blank.
     */
    if (text === '') text = UNREADABLE_BODY;
    return { ...raw, message: text };
  }
  return raw;
}
