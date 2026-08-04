// @vitest-environment jsdom
/**
 * `getDeviceKeyState()` — does THIS device hold the ACCOUNT's key?
 *
 * The bug this exists for: the first implementation asked
 * `km.hasMasterKey(idbStore())`, i.e. "is there a master_key stored locally".
 * There always is. `loadOrCreateMasterKey` MINTS one the instant chat touches
 * the encrypting store, so a brand-new browser answered 'ready' and the
 * locked-history recovery offer was hidden behind the very condition it was
 * built to detect. On a phone the user saw six locked messages and no way out.
 *
 * `lockedHistory.test.tsx` did not catch it because it mocks this function
 * wholesale — it proves the NOTICE reacts correctly to a state, never that the
 * state is computed correctly. Hence this file.
 *
 * The real question is whether the local key can OPEN the account's archive.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const km = vi.hoisted(() => ({
  restoreTakKeychain: vi.fn(),
  loadOrCreateMasterKey: vi.fn(async () => new Uint8Array(32)),
  hasMasterKey: vi.fn(async () => true), // a fresh device: ALWAYS true
  EncryptingKVStore: { lazy: () => ({ get: async () => null, set: async () => {} }) },
}));
vi.mock('@/lib/mls/keyManager', () => km);
vi.mock('@/lib/passkeyPrf', () => ({ getPasskeyPrf: vi.fn() }));
vi.mock('@/lib/mls/mlsSession', () => ({ MlsSessionStore: class {} }));
vi.mock('@/lib/mls/takSession', () => ({ TakSessionStore: class {} }));

const server = { takBlob: null as string | null, passkeys: [] as unknown[], wrappedMaster: null as string | null };

beforeEach(() => {
  vi.clearAllMocks();
  km.hasMasterKey.mockResolvedValue(true);
  km.loadOrCreateMasterKey.mockResolvedValue(new Uint8Array(32));
  server.takBlob = null;
  server.passkeys = [];
  server.wrappedMaster = null;

  vi.stubGlobal('indexedDB', { open: () => ({ onupgradeneeded: null, onsuccess: null, onerror: null }) });
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/keys/tak-backup')) {
      return Promise.resolve(new Response(JSON.stringify({ ciphertext: server.takBlob }), { status: 200 }));
    }
    if (url.includes('/api/keys/backup')) {
      return Promise.resolve(
        new Response(JSON.stringify({ passkeys: server.passkeys, wrappedMaster: server.wrappedMaster }), { status: 200 }),
      );
    }
    return Promise.resolve(new Response('{}', { status: 200 }));
  }));
});

async function probe() {
  const { getDeviceKeyState } = await import('@/lib/mls/webTransport');
  return getDeviceKeyState();
}

describe('getDeviceKeyState', () => {
  it('REGRESSION: a fresh device that minted its own key is NOT "ready"', async () => {
    // Exactly the reported situation: the archive exists, this browser holds a
    // master_key (its own), and the account has a passkey wrap to recover from.
    server.takBlob = 'sealed-under-the-real-key';
    server.passkeys = [{ credentialId: 'c1', prfWrapped: 'w' }];
    km.restoreTakKeychain.mockResolvedValue(null); // local key does not fit

    expect(await probe()).toBe('recoverable');
    // The old implementation short-circuited on this and never asked anything else.
    expect(km.restoreTakKeychain).toHaveBeenCalled();
  });

  it('a device whose key OPENS the archive is ready', async () => {
    server.takBlob = 'sealed';
    km.restoreTakKeychain.mockResolvedValue({ 'tak.root.t1': 'AAA' });

    expect(await probe()).toBe('ready');
  });

  it('no archive at all → no-backup, even when a passkey wrap exists', async () => {
    // Recovering the master_key would restore an empty keychain, so offering
    // "unlock history" would be a button that cannot deliver.
    server.takBlob = null;
    server.passkeys = [{ credentialId: 'c1', prfWrapped: 'w' }];

    expect(await probe()).toBe('no-backup');
  });

  it("archive exists, key does not fit, and nothing can produce the real key → no-backup", async () => {
    server.takBlob = 'sealed';
    server.passkeys = [];
    server.wrappedMaster = null;
    km.restoreTakKeychain.mockResolvedValue(null);

    expect(await probe()).toBe('no-backup');
  });

  it('a recovery-code wrap alone is enough to offer recovery', async () => {
    server.takBlob = 'sealed';
    server.wrappedMaster = 'wrapped';
    km.restoreTakKeychain.mockResolvedValue(null);

    expect(await probe()).toBe('recoverable');
  });

  it('EXTERNAL FAILURE: an unreachable endpoint claims nothing rather than throwing', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));
    await expect(probe()).resolves.toBe('no-backup');
  });

  it('does not decide readiness from the mere existence of a local key', async () => {
    // The precise inversion of the bug: hasMasterKey true must not, on its own,
    // produce 'ready'.
    server.takBlob = 'sealed';
    server.passkeys = [{ credentialId: 'c1', prfWrapped: 'w' }];
    km.hasMasterKey.mockResolvedValue(true);
    km.restoreTakKeychain.mockResolvedValue(null);

    expect(await probe()).not.toBe('ready');
  });
});
