/**
 * Real Expo push provider adapter — unit tests (design §13). Device-free: the
 * network edge is a mocked global `fetch`, so we assert the exact Expo message
 * SHAPE that crosses the wire without an APNs/FCM/Expo dependency.
 *
 * Covers the provider-owned edge matrix rows:
 *   integrity (SI-1) — content-free carries NO ct/plaintext; ciphertext carries
 *                      only the opaque ct + iOS mutable-content flags
 *   batching        — chunk() splits >100 into ≤100 groups; a send POSTs an array
 *   auth            — Authorization header attached only when EXPO_ACCESS_TOKEN set
 *   graceful        — a rejected fetch / non-ok response is swallowed (never throws)
 *   disabled        — getPushProvider(): null unless PUSH_MODE set; PUSH_DISABLED forces null
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ExpoPushProvider,
  getPushProvider,
  chunk,
  EXPO_BATCH_MAX,
} from '@/lib/pushProvider';
import type {
  PushTarget,
  DummyPushPayload,
  CiphertextPushPayload,
} from '@/lib/push';

const EXPO_URL = 'https://exp.host/--/api/v2/push/send';
const TARGET: PushTarget = { pushToken: 'ExponentPushToken[xxxx]', platform: 'ios' };

const DUMMY: DummyPushPayload = {
  title: 'OpenStoa',
  body: 'New message',
  data: { topicId: 'topic-1' },
};

const CIPHERTEXT: CiphertextPushPayload = {
  title: 'OpenStoa',
  body: 'New message',
  data: { topicId: 'topic-1', messageId: 'msg-1', epoch: 3, ct: 'c2VhbGVkLW9wYXF1ZQ==' },
  mutableContent: true,
  dataOnly: true,
};

/** Build a minimal ok/!ok fetch Response stand-in. */
function fakeResponse(ok: boolean, body: unknown = { data: [{ status: 'ok' }] }) {
  return {
    ok,
    status: ok ? 200 : 400,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/** Parse the JSON array body of the Nth fetch call. */
function bodyOf(mock: ReturnType<typeof vi.fn>, call = 0): Array<Record<string, unknown>> {
  const init = mock.mock.calls[call][1] as RequestInit;
  return JSON.parse(init.body as string);
}
function headersOf(mock: ReturnType<typeof vi.fn>, call = 0): Record<string, string> {
  const init = mock.mock.calls[call][1] as RequestInit;
  return init.headers as Record<string, string>;
}

describe('chunk (≤100 batching contract)', () => {
  it('splits into groups of at most `size`', () => {
    const items = Array.from({ length: 250 }, (_, i) => i);
    const groups = chunk(items, EXPO_BATCH_MAX);
    expect(groups.map((g) => g.length)).toEqual([100, 100, 50]);
    expect(groups.flat()).toEqual(items); // order + completeness preserved
  });
  it('empty input → no groups; size<=0 → single passthrough group', () => {
    expect(chunk([], 100)).toEqual([]);
    expect(chunk([1, 2, 3], 0)).toEqual([[1, 2, 3]]);
  });
});

describe('ExpoPushProvider.send (content-free)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn(async () => fakeResponse(true));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('SI-1: POSTs an array with exactly {to,title,body,data,channelId} — NO ct/plaintext/flags', async () => {
    await new ExpoPushProvider().send(TARGET, DUMMY);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(EXPO_URL);
    const body = bodyOf(fetchMock);
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(1);
    const msg = body[0];
    /*
     * The key set is enumerated, not sampled, so a field added later cannot
     * smuggle content past this file unnoticed — which is exactly what it just
     * did for `channelId`, and why that key is listed here with its reason
     * rather than waved through.
     *
     * `channelId` is a fixed string naming an Android notification channel. It
     * is not derived from the message, the topic or the user, so it carries no
     * information about any of them; the assertion below pins its VALUE for
     * the same reason the key list exists.
     */
    expect(Object.keys(msg).sort()).toEqual(['body', 'channelId', 'data', 'title', 'to']);
    expect(msg.channelId).toBe('chat');
    expect(msg.to).toBe(TARGET.pushToken);
    expect(msg.data).toEqual({ topicId: 'topic-1' });
    // No content-bearing or delivery-mode fields on the content-free message.
    const flat = JSON.stringify(body).toLowerCase();
    for (const forbidden of ['ct', 'plaintext', 'mutablecontent', 'contentavailable', 'priority']) {
      expect(flat.includes(forbidden)).toBe(false);
    }
  });

  it('omits Authorization when no access token; includes Bearer when set', async () => {
    await new ExpoPushProvider().send(TARGET, DUMMY);
    expect('Authorization' in headersOf(fetchMock)).toBe(false);

    fetchMock.mockClear();
    await new ExpoPushProvider('secret-token').send(TARGET, DUMMY);
    expect(headersOf(fetchMock).Authorization).toBe('Bearer secret-token');
  });
});

describe('ExpoPushProvider.sendCiphertext (Phase B)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn(async () => fakeResponse(true));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('carries opaque ct + mutableContent + _contentAvailable + priority; no plaintext', async () => {
    await new ExpoPushProvider().sendCiphertext(TARGET, CIPHERTEXT);
    const msg = bodyOf(fetchMock)[0];
    expect(msg.to).toBe(TARGET.pushToken);
    expect((msg.data as Record<string, unknown>).ct).toBe('c2VhbGVkLW9wYXF1ZQ==');
    expect(msg.mutableContent).toBe(true);
    expect(msg._contentAvailable).toBe(true);
    expect(msg.priority).toBe('high');
    const flat = JSON.stringify(msg).toLowerCase();
    for (const forbidden of ['plaintext', 'sender', 'nickname']) {
      expect(flat.includes(forbidden)).toBe(false);
    }
  });
});

describe('graceful error handling (fire-and-forget)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('a rejected fetch is swallowed (never throws into the chat path)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    await expect(new ExpoPushProvider().send(TARGET, DUMMY)).resolves.toBeUndefined();
  });
  it('a non-ok HTTP response is swallowed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(false)));
    await expect(new ExpoPushProvider().sendCiphertext(TARGET, CIPHERTEXT)).resolves.toBeUndefined();
  });
});

describe('getPushProvider (disabled by default)', () => {
  const orig = { mode: process.env.PUSH_MODE, disabled: process.env.PUSH_DISABLED };
  beforeEach(() => {
    delete process.env.PUSH_MODE;
    delete process.env.PUSH_DISABLED;
  });
  afterEach(() => {
    if (orig.mode === undefined) delete process.env.PUSH_MODE; else process.env.PUSH_MODE = orig.mode;
    if (orig.disabled === undefined) delete process.env.PUSH_DISABLED; else process.env.PUSH_DISABLED = orig.disabled;
  });

  it('returns null when PUSH_MODE is unset (push OFF by default)', () => {
    expect(getPushProvider()).toBeNull();
  });
  it('returns an ExpoPushProvider when PUSH_MODE is set', () => {
    process.env.PUSH_MODE = 'content-free';
    expect(getPushProvider()).toBeInstanceOf(ExpoPushProvider);
    process.env.PUSH_MODE = 'ciphertext';
    expect(getPushProvider()).toBeInstanceOf(ExpoPushProvider);
  });
  it('PUSH_DISABLED forces null even when PUSH_MODE is set', () => {
    process.env.PUSH_MODE = 'ciphertext';
    process.env.PUSH_DISABLED = '1';
    expect(getPushProvider()).toBeNull();
    process.env.PUSH_DISABLED = 'true';
    expect(getPushProvider()).toBeNull();
  });
});
