import { describe, it, expect, vi } from 'vitest';
import {
  mirrorPushSessionWith,
  mirrorTakWith,
  sharedPushSessionKey,
  sharedTakKey,
  SHARED_KEYCHAIN_ACCESS_GROUP,
  TAK_BYTES,
  type SecureStoreLike,
  type TakMirrorHost,
} from '../crypto/sharedKeychain';

/**
 * P-Q — mirroring the Topic Archive Key into storage the platform's BACKGROUND
 * push handler can read, so it can decrypt a push preview without touching the
 * MLS ratchet (design §13.6 strategy A).
 *
 * Two destinations: the iOS shared Keychain access group (written here through
 * expo-secure-store, for `OpenStoaNSE`) and the Android host store (written over
 * `HostApi.mirrorTopicArchiveKey`, for `OpenStoaMessagingService`).
 *
 * Matrix rows: platform routing (each platform reaches its own destination and
 * only its own), contract invocation (exact key name / value / access group /
 * accessibility), hostile + empty + boundary input (bad base64, wrong key
 * length, bad takVersion, empty topicId) enforced identically on BOTH platforms,
 * external-dependency failure (missing module, missing bridge method, throwing
 * Keychain, throwing bridge), and format integrity (the value stays verbatim
 * base64, never re-encoded).
 */

const TAK_B64 = Buffer.alloc(TAK_BYTES, 7).toString('base64'); // 32 bytes → 44 chars
const TOPIC = '00000000-0000-4000-8000-00000000abcd';

function store(impl?: SecureStoreLike['setItemAsync']) {
  const spy = vi.fn<SecureStoreLike['setItemAsync']>(impl ?? (async () => {}));
  const s: SecureStoreLike = { setItemAsync: spy, AFTER_FIRST_UNLOCK: 'afterFirstUnlock' };
  return { s, spy };
}

function hostBridge(impl?: NonNullable<TakMirrorHost['mirrorTopicArchiveKey']>) {
  const spy = vi.fn(impl ?? (async () => true));
  const host: TakMirrorHost = { mirrorTopicArchiveKey: spy };
  return { host, spy };
}

describe('mirrorTakWith — happy path + contract invocation', () => {
  it('writes the exact key/value/options the NSE reads', async () => {
    const { s, spy } = store();
    await expect(mirrorTakWith(s, 'ios', TOPIC, 3, TAK_B64)).resolves.toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    const [key, value, options] = spy.mock.calls[0];
    expect(key).toBe(`openstoa.tak.${TOPIC}.3`);
    expect(key).toBe(sharedTakKey(TOPIC, 3));
    expect(value).toBe(TAK_B64); // verbatim base64 of the 32 raw bytes
    expect(options).toEqual({
      keychainAccessGroup: SHARED_KEYCHAIN_ACCESS_GROUP,
      keychainAccessible: 'afterFirstUnlock', // readable while the device is locked
    });
    expect(SHARED_KEYCHAIN_ACCESS_GROUP).toBe('com.masselabs.zkproofport.openstoa');
  });

  it('takVersion 0 (public archive root) is a valid version, not a missing one', async () => {
    const { s, spy } = store();
    await expect(mirrorTakWith(s, 'ios', TOPIC, 0, TAK_B64)).resolves.toBe(true);
    expect(spy.mock.calls[0][0]).toBe(`openstoa.tak.${TOPIC}.0`);
  });

  it('each (topic, version) is its own item — versions never overwrite each other', async () => {
    const { s, spy } = store();
    await mirrorTakWith(s, 'ios', TOPIC, 0, TAK_B64);
    await mirrorTakWith(s, 'ios', TOPIC, 1, TAK_B64);
    await mirrorTakWith(s, 'ios', 'other-topic', 1, TAK_B64);
    expect(spy.mock.calls.map((c) => c[0])).toEqual([
      `openstoa.tak.${TOPIC}.0`,
      `openstoa.tak.${TOPIC}.1`,
      'openstoa.tak.other-topic.1',
    ]);
  });

  it('an older module without AFTER_FIRST_UNLOCK still writes (option omitted)', async () => {
    // Typed to the real `setItemAsync`, not `async () => {}` — a zero-arg
    // stub makes `spy.mock.calls` a `[][]`, so asserting on the options
    // argument (index 2) is an out-of-bounds read on an empty tuple.
    const spy = vi.fn<SecureStoreLike['setItemAsync']>(async () => {});
    const s: SecureStoreLike = { setItemAsync: spy };
    await expect(mirrorTakWith(s, 'ios', TOPIC, 1, TAK_B64)).resolves.toBe(true);
    expect(spy.mock.calls[0][2]).toEqual({
      keychainAccessGroup: SHARED_KEYCHAIN_ACCESS_GROUP,
      keychainAccessible: undefined,
    });
  });

  it('only ever writes openstoa.tak.* — it cannot clobber other stored keys', async () => {
    const { s, spy } = store();
    await mirrorTakWith(s, 'ios', TOPIC, 2, TAK_B64);
    for (const [key] of spy.mock.calls) expect(String(key).startsWith('openstoa.tak.')).toBe(true);
  });
});

describe('mirrorTakWith — platform + dependency gates', () => {
  it('Android never touches the Keychain — it has no access group', async () => {
    const { s, spy } = store();
    const { host, spy: bridge } = hostBridge();
    await expect(mirrorTakWith(s, 'android', TOPIC, 1, TAK_B64, host)).resolves.toBe(true);
    expect(spy).not.toHaveBeenCalled();
    expect(bridge).toHaveBeenCalledTimes(1);
  });

  it('iOS never uses the host bridge — the mini-app writes the Keychain itself', async () => {
    const { s, spy } = store();
    const { host, spy: bridge } = hostBridge();
    await expect(mirrorTakWith(s, 'ios', TOPIC, 1, TAK_B64, host)).resolves.toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(bridge).not.toHaveBeenCalled();
  });

  it('web / unknown platforms are a no-op on both paths', async () => {
    const { s, spy } = store();
    const { host, spy: bridge } = hostBridge();
    for (const os of ['web', 'windows', 'macos', '']) {
      await expect(mirrorTakWith(s, os, TOPIC, 1, TAK_B64, host)).resolves.toBe(false);
    }
    expect(spy).not.toHaveBeenCalled();
    expect(bridge).not.toHaveBeenCalled();
  });

  it('a missing expo-secure-store (stale host binary) is a no-op, not a crash', async () => {
    await expect(mirrorTakWith(null, 'ios', TOPIC, 1, TAK_B64)).resolves.toBe(false);
    await expect(
      mirrorTakWith({} as unknown as SecureStoreLike, 'ios', TOPIC, 1, TAK_B64),
    ).resolves.toBe(false);
  });

  it('a throwing Keychain resolves false instead of rejecting', async () => {
    const { s } = store(async () => {
      throw new Error('errSecMissingEntitlement');
    });
    await expect(mirrorTakWith(s, 'ios', TOPIC, 1, TAK_B64)).resolves.toBe(false);
  });
});

describe('mirrorTakWith — Android host bridge', () => {
  it('hands the host the raw arguments, not a pre-built key path', async () => {
    const { s } = store();
    const { host, spy } = hostBridge();
    await expect(mirrorTakWith(s, 'android', TOPIC, 3, TAK_B64, host)).resolves.toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    // The native side owns the entry-key format (OpenStoaTakStore.entryKey) so the
    // two implementations of `openstoa.tak.<topic>.<version>` cannot drift apart
    // through this call.
    expect(spy.mock.calls[0]).toEqual([TOPIC, 3, TAK_B64]);
  });

  it('takVersion 0 (public archive root) reaches the host as 0', async () => {
    const { s } = store();
    const { host, spy } = hostBridge();
    await expect(mirrorTakWith(s, 'android', TOPIC, 0, TAK_B64, host)).resolves.toBe(true);
    expect(spy.mock.calls[0][1]).toBe(0);
  });

  it('a host binary without the bridge method is a no-op, not a crash', async () => {
    const { s } = store();
    await expect(mirrorTakWith(s, 'android', TOPIC, 1, TAK_B64)).resolves.toBe(false);
    await expect(mirrorTakWith(s, 'android', TOPIC, 1, TAK_B64, null)).resolves.toBe(false);
    await expect(mirrorTakWith(s, 'android', TOPIC, 1, TAK_B64, {})).resolves.toBe(false);
  });

  it('a throwing host resolves false instead of rejecting', async () => {
    const { s } = store();
    const { host } = hostBridge(async () => {
      throw new Error('native module gone');
    });
    await expect(mirrorTakWith(s, 'android', TOPIC, 1, TAK_B64, host)).resolves.toBe(false);
  });

  it('a host that reports a failed write reports false, not true', async () => {
    const { s } = store();
    const { host } = hostBridge(async () => false);
    await expect(mirrorTakWith(s, 'android', TOPIC, 1, TAK_B64, host)).resolves.toBe(false);
  });

  it('a host returning a non-boolean is never treated as success', async () => {
    const { s } = store();
    for (const value of [undefined, null, 0, 1, 'true', {}]) {
      const { host } = hostBridge(async () => value as never);
      await expect(mirrorTakWith(s, 'android', TOPIC, 1, TAK_B64, host)).resolves.toBe(false);
    }
  });

  it('applies the SAME key-material validation as the iOS path', async () => {
    const { s } = store();
    const { host, spy } = hostBridge();
    const bad = [
      '',
      '   ',
      'not base64!!',
      Buffer.alloc(31, 1).toString('base64'),
      Buffer.alloc(33, 1).toString('base64'),
      TAK_B64 + '\n',
      undefined as never,
      12345 as never,
    ];
    for (const v of bad) {
      await expect(mirrorTakWith(s, 'android', TOPIC, 1, v, host)).resolves.toBe(false);
    }
    for (const v of [-1, 1.5, NaN, Infinity, '2' as never]) {
      await expect(mirrorTakWith(s, 'android', TOPIC, v, TAK_B64, host)).resolves.toBe(false);
    }
    for (const t of ['', null as never, 42 as never]) {
      await expect(mirrorTakWith(s, 'android', t, 1, TAK_B64, host)).resolves.toBe(false);
    }
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('mirrorTakWith — hostile / boundary input', () => {
  it('rejects anything that is not base64 of exactly 32 bytes', async () => {
    const { s, spy } = store();
    const bad = [
      '', // empty
      '   ', // whitespace
      'not base64!!',
      'aGVsbG8', // non-canonical (length % 4)
      Buffer.alloc(31, 1).toString('base64'), // 31 bytes — one short
      Buffer.alloc(33, 1).toString('base64'), // 33 bytes — one long
      Buffer.alloc(0).toString('base64'), // zero bytes
      Buffer.alloc(4096, 1).toString('base64'), // absurdly large
      TAK_B64 + '\n', // trailing newline
      undefined as never,
      null as never,
      12345 as never,
      {} as never,
    ];
    for (const v of bad) {
      await expect(mirrorTakWith(s, 'ios', TOPIC, 1, v)).resolves.toBe(false);
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it('rejects a bad takVersion', async () => {
    const { s, spy } = store();
    for (const v of [-1, 1.5, NaN, Infinity, Number.MAX_VALUE, '2' as never, null as never, undefined as never]) {
      await expect(mirrorTakWith(s, 'ios', TOPIC, v, TAK_B64)).resolves.toBe(false);
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it('rejects an empty or non-string topicId', async () => {
    const { s, spy } = store();
    for (const t of ['', null as never, undefined as never, 42 as never]) {
      await expect(mirrorTakWith(s, 'ios', t, 1, TAK_B64)).resolves.toBe(false);
    }
    expect(spy).not.toHaveBeenCalled();
  });
});

/**
 * P-1 — mirroring the SESSION the iOS extension fetches an ATTACHMENT with.
 *
 * A message preview needs only a key, because the ciphertext rides in the push.
 * A picture does not fit in a push, so the extension has to go and get it, and
 * the read route is membership-gated. The extension cannot ask this process for
 * a token — different process, app not running — so it has to be in shared
 * storage before the push arrives.
 *
 * Matrix rows: contract invocation (exact key / value shape / access group /
 * accessibility), platform routing (iOS only — Android's handler shows text and
 * never fetches, so a token there would be a credential for a caller that does
 * not exist), hostile + empty input (non-http base URLs, empty token, empty
 * topic), boundary (a very long token), external-dependency failure (missing
 * module, throwing Keychain), and overwrite semantics.
 */
describe('mirrorPushSessionWith — the extension is given a way to fetch', () => {
  const BASE = 'https://openstoa.xyz';
  const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.payload.sig';

  it('writes the exact key and JSON shape the NSE parses', async () => {
    const { s, spy } = store();
    await expect(mirrorPushSessionWith(s, 'ios', TOPIC, BASE, TOKEN)).resolves.toBe(true);
    const [key, value, options] = spy.mock.calls[0];
    expect(key).toBe(`openstoa.push.session.${TOPIC}`);
    expect(key).toBe(sharedPushSessionKey(TOPIC));
    // `PushSession.parse` in the NSE reads exactly these two fields.
    expect(JSON.parse(value as string)).toEqual({ baseUrl: BASE, token: TOKEN });
    expect(options).toEqual({
      keychainAccessGroup: SHARED_KEYCHAIN_ACCESS_GROUP,
      // A push arrives while the device is locked; a `WhenUnlocked` item would
      // simply be invisible to the extension.
      keychainAccessible: 'afterFirstUnlock',
    });
  });

  it('is per topic, so one session never answers for another topic', async () => {
    const { s, spy } = store();
    await mirrorPushSessionWith(s, 'ios', TOPIC, BASE, TOKEN);
    await mirrorPushSessionWith(s, 'ios', 'other-topic', BASE, 'other-token');
    expect(spy.mock.calls.map((c) => c[0])).toEqual([
      `openstoa.push.session.${TOPIC}`,
      'openstoa.push.session.other-topic',
    ]);
  });

  it('overwrites the same entry, so a refreshed token replaces the stale one', async () => {
    const { s, spy } = store();
    await mirrorPushSessionWith(s, 'ios', TOPIC, BASE, 'old');
    await mirrorPushSessionWith(s, 'ios', TOPIC, BASE, 'new');
    expect(spy.mock.calls[0][0]).toBe(spy.mock.calls[1][0]);
    expect(JSON.parse(spy.mock.calls[1][1] as string).token).toBe('new');
  });

  it('never writes on Android — its handler shows text and never fetches', async () => {
    const { s, spy } = store();
    await expect(mirrorPushSessionWith(s, 'android', TOPIC, BASE, TOKEN)).resolves.toBe(false);
    await expect(mirrorPushSessionWith(s, 'web', TOPIC, BASE, TOKEN)).resolves.toBe(false);
    await expect(mirrorPushSessionWith(s, 'macos', TOPIC, BASE, TOKEN)).resolves.toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('degrades to false on a stale host binary or a throwing Keychain', async () => {
    await expect(mirrorPushSessionWith(null, 'ios', TOPIC, BASE, TOKEN)).resolves.toBe(false);
    await expect(
      mirrorPushSessionWith({} as SecureStoreLike, 'ios', TOPIC, BASE, TOKEN),
    ).resolves.toBe(false);
    const { s } = store(async () => {
      throw new Error('keychain unavailable');
    });
    await expect(mirrorPushSessionWith(s, 'ios', TOPIC, BASE, TOKEN)).resolves.toBe(false);
  });

  it('refuses a base URL that could send the token somewhere else', async () => {
    const { s, spy } = store();
    const bad = [
      '',
      '   ',
      '/api',
      'openstoa.xyz',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'ftp://openstoa.xyz',
      'https://',
      'https:// openstoa.xyz',
      null as never,
      undefined as never,
      42 as never,
    ];
    for (const b of bad) {
      await expect(mirrorPushSessionWith(s, 'ios', TOPIC, b, TOKEN)).resolves.toBe(false);
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it('accepts a LAN http origin, because that is what local dev is', async () => {
    const { s } = store();
    await expect(
      mirrorPushSessionWith(s, 'ios', TOPIC, 'http://192.168.0.2:3200', TOKEN),
    ).resolves.toBe(true);
  });

  it('refuses an empty token or topic rather than writing a useless entry', async () => {
    const { s, spy } = store();
    for (const t of ['', null as never, undefined as never, 42 as never]) {
      await expect(mirrorPushSessionWith(s, 'ios', TOPIC, BASE, t)).resolves.toBe(false);
    }
    for (const t of ['', null as never, undefined as never]) {
      await expect(mirrorPushSessionWith(s, 'ios', t, BASE, TOKEN)).resolves.toBe(false);
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it('carries a very long token verbatim — a JWT has no fixed length', async () => {
    const { s, spy } = store();
    const long = 'a'.repeat(8192);
    await expect(mirrorPushSessionWith(s, 'ios', TOPIC, BASE, long)).resolves.toBe(true);
    expect(JSON.parse(spy.mock.calls[0][1] as string).token).toBe(long);
  });

  it('a base URL with a path prefix survives — some hosts mount under one', async () => {
    const { s, spy } = store();
    await expect(
      mirrorPushSessionWith(s, 'ios', TOPIC, 'https://example.test/openstoa', TOKEN),
    ).resolves.toBe(true);
    expect(JSON.parse(spy.mock.calls[0][1] as string).baseUrl).toBe('https://example.test/openstoa');
  });
});
