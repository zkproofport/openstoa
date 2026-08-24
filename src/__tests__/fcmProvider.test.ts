/**
 * Android goes to FCM as a DATA message. Nothing else will do.
 *
 * Design §13.2.1 requires it — "Android | FCM data message(암호문) | data
 * message는 앱이 처리, Google이 내용 못 봄" — and until now it was not what
 * happened. Through Expo's push service the message arrived as an FCM
 * *notification* message, so Firebase displayed it and the app was never asked.
 * Measured, not assumed: on a debug build, where `expo-notifications`'
 * `DebugLogging` fires unconditionally, `FirebaseMessagingDelegate.onMessageReceived`
 * did not log a single line while the notification appeared in the tray.
 *
 * Two shipped features were dead because of it — the Android half of the
 * lock-screen preview (`OpenStoaMessagingService` never ran) and per-room
 * dismissal (a Firebase-built notification carries none of the extras
 * `expo-notifications` stamps). So the assertions here are about the SHAPE of
 * what leaves the server, because the shape is the whole fix.
 *
 * Matrix rows: contract (no notification block, data is strings), integrity
 * (the tag that makes dismissal possible), hostile (an error body that echoes
 * a token is never logged), empty (absent credential disables cleanly), UTF-8
 * (Korean survives the string-only encoding), external failure (a rejected
 * send never reaches the caller). N/A: authorization — this layer has no
 * caller identity; very-large — the payload budget is enforced upstream in
 * `push.ts`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const warn = vi.fn();
const info = vi.fn();
vi.mock('@/lib/logger', () => ({
  logger: {
    warn: (...a: unknown[]) => warn(...a),
    info: (...a: unknown[]) => info(...a),
    error: (...a: unknown[]) => warn(...a),
    debug: () => {},
  },
}));

import {
  FcmPushProvider,
  getFcmProvider,
  serialiseData,
  extractFcmError,
  isDeadToken,
} from '@/lib/fcmProvider';

/** A syntactically valid RSA key, so the signer has something real to sign. */
const KEY = [
  '-----BEGIN PRIVATE KEY-----',
  'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj',
  '-----END PRIVATE KEY-----',
].join('\n');

const TOKEN = 'fcm-registration-token-xxxxxxxxxxxxxxxx';
const TARGET = { pushToken: TOKEN, platform: 'android' as const };

let fetchMock: ReturnType<typeof vi.fn>;

/** Answers the token endpoint, then the send, in that order. */
function stubFetch(sendResponse: { ok: boolean; status: number; body?: unknown }) {
  fetchMock = vi.fn(async (url: string) => {
    if (String(url).includes('oauth2.googleapis.com')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: 'at-1', expires_in: 3600 }),
      };
    }
    return {
      ok: sendResponse.ok,
      status: sendResponse.status,
      json: async () => sendResponse.body ?? {},
      text: async () => JSON.stringify(sendResponse.body ?? {}),
    };
  });
  vi.stubGlobal('fetch', fetchMock);
}

/** The body of the FCM send call, parsed. */
function sentMessage() {
  const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('fcm.googleapis.com'));
  return JSON.parse((call![1] as { body: string }).body).message;
}

function provider() {
  return new FcmPushProvider({
    client_email: 'svc@example.iam.gserviceaccount.com',
    private_key: KEY,
    project_id: 'zkproofport-93ffd',
  });
}

beforeEach(() => {
  warn.mockReset();
  info.mockReset();
  stubFetch({ ok: true, status: 200 });
  // The RS256 signature is not what this file is about; a real key would make
  // every case depend on crypto that is already tested by Node.
  vi.doMock('node:crypto', () => ({
    createSign: () => ({ update: () => {}, sign: () => 'sig' }),
  }));
});

describe('CONTRACT: the message has no notification block', () => {
  it('sends data only', async () => {
    await provider().send(TARGET, { title: 'OpenStoa', body: 'New message', data: { topicId: 't1' } } as never);
    const msg = sentMessage();
    /*
     * THE assertion — and it has to cover BOTH places a notification block can
     * live. Checking only `msg.notification` let `msg.android.notification`
     * through, and `android.notification: { channel_id }` is still a
     * notification block: Firebase's table sends any message carrying one to
     * the system tray in the background and never calls `onMessageReceived`.
     * The test passed while the device showed the defect.
     */
    expect(msg.notification).toBeUndefined();
    expect(msg.android?.notification).toBeUndefined();
    expect(Object.keys(msg.android ?? {})).toEqual(['priority']);
    expect(msg.data).toBeDefined();
  });

  it('addresses the device token and nothing else', async () => {
    await provider().send(TARGET, { title: 'x', body: 'y', data: { topicId: 't1' } } as never);
    expect(sentMessage().token).toBe(TOKEN);
  });

  it('asks for HIGH priority so a data message is not held by Doze', async () => {
    await provider().send(TARGET, { title: 'x', body: 'y', data: { topicId: 't1' } } as never);
    expect(sentMessage().android.priority).toBe('HIGH');
  });

  it('names the channel in DATA, never under android.notification', async () => {
    await provider().send(TARGET, { title: 'x', body: 'y', data: { topicId: 't1' } } as never);
    const msg = sentMessage();
    // `expo-notifications` reads the channel off the data message when it
    // builds the notification. Putting it under `android.notification` names
    // the same channel and costs the entire fix.
    expect(msg.data.channelId).toBe('chat');
    expect(msg.android?.notification).toBeUndefined();
  });

  it('reuses the access token rather than minting one per push', async () => {
    const p = provider();
    await p.send(TARGET, { title: 'x', body: 'y', data: { topicId: 't1' } } as never);
    await p.send(TARGET, { title: 'x', body: 'y', data: { topicId: 't2' } } as never);
    const tokenCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes('oauth2'));
    expect(tokenCalls).toHaveLength(1);
  });
});

describe('INTEGRITY: the tag is what makes dismissal possible', () => {
  it('sets data.tag from topicId', () => {
    // `expo-notifications` uses `data["tag"]` as the notification identifier
    // (`FirebaseMessagingDelegate.getNotificationIdentifier`), so this is what
    // lets the app clear one room by name without enumerating the tray.
    expect(serialiseData({ topicId: 't1' }).tag).toBe('t1');
  });

  it('leaves tag alone when there is no topic to name', () => {
    expect(serialiseData({ other: 'x' }).tag).toBeUndefined();
    expect(serialiseData(undefined).tag).toBeUndefined();
  });

  it('BOUNDARY: every value is a string, because FCM has no other type', () => {
    const out = serialiseData({ topicId: 't1', tv: 3, flag: true, obj: { a: 1 } });
    for (const [key, value] of Object.entries(out)) {
      expect(typeof value, key).toBe('string');
    }
    expect(out.tv).toBe('3');
    expect(JSON.parse(out.obj)).toEqual({ a: 1 });
  });

  it('EMPTY: null and undefined are dropped rather than stringified', () => {
    // "null" and "undefined" as literal strings would reach the app as truthy.
    const out = serialiseData({ topicId: 't1', a: null, b: undefined });
    expect(out.a).toBeUndefined();
    expect(out.b).toBeUndefined();
  });

  it('UTF-8: Korean survives the string-only encoding', () => {
    expect(serialiseData({ topicId: 't1', title: '안녕하세요 🌟' }).title).toBe('안녕하세요 🌟');
  });
});

describe('SI-1: what the log is allowed to say', () => {
  it('logs FCM error names, never the body that echoes the token', async () => {
    stubFetch({
      ok: false,
      status: 404,
      body: { error: { status: 'UNREGISTERED', message: `token ${TOKEN} not found` } },
    });
    await provider().send(TARGET, { title: 'x', body: 'y', data: { topicId: 't1' } } as never);

    const logged = warn.mock.calls.map((c) => JSON.stringify(c)).join('\n');
    expect(logged).toContain('UNREGISTERED');
    expect(logged).not.toContain(TOKEN);
  });

  it.each(['UNREGISTERED', 'INVALID_ARGUMENT', 'SENDER_ID_MISMATCH', 'QUOTA_EXCEEDED'])(
    'extracts %s',
    (code) => {
      expect(extractFcmError(`{"error":{"status":"${code}"}}`)).toBe(code);
    },
  );

  it('says "unknown" rather than nothing for an unparseable body', () => {
    expect(extractFcmError('not json at all')).toBe('unknown');
    expect(extractFcmError('')).toBe('unknown');
  });
});

describe('EXTERNAL FAILURE and EMPTY', () => {
  it('a rejected send never reaches the caller', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    await expect(
      provider().send(TARGET, { title: 'x', body: 'y', data: { topicId: 't1' } } as never),
    ).resolves.toBeUndefined();
  });

  it('a non-200 send never reaches the caller', async () => {
    stubFetch({ ok: false, status: 500, body: {} });
    await expect(
      provider().send(TARGET, { title: 'x', body: 'y', data: { topicId: 't1' } } as never),
    ).resolves.toBeUndefined();
  });

  it.each([
    ['absent', undefined],
    ['blank', ''],
    ['not json', 'nonsense'],
    ['missing client_email', JSON.stringify({ private_key: 'k', project_id: 'p' })],
    ['missing private_key', JSON.stringify({ client_email: 'e', project_id: 'p' })],
    ['missing project_id', JSON.stringify({ client_email: 'e', private_key: 'k' })],
  ])('a %s credential yields no provider rather than a broken one', (_label, raw) => {
    const before = process.env.FCM_SERVICE_ACCOUNT;
    if (raw === undefined) delete process.env.FCM_SERVICE_ACCOUNT;
    else process.env.FCM_SERVICE_ACCOUNT = raw;
    expect(getFcmProvider()).toBeNull();
    if (before === undefined) delete process.env.FCM_SERVICE_ACCOUNT;
    else process.env.FCM_SERVICE_ACCOUNT = before;
  });

  it('accepts the base64 form the deploy actually passes', () => {
    // Raw JSON has spaces, and `gcloud run deploy --set-env-vars` split the
    // value at the first one — failing the deploy and printing the private key
    // into the CI log. Base64 contains nothing any shell treats specially.
    const before = process.env.FCM_SERVICE_ACCOUNT;
    const json = JSON.stringify({ client_email: 'e', private_key: 'k', project_id: 'p' });
    process.env.FCM_SERVICE_ACCOUNT = Buffer.from(json).toString('base64');
    expect(getFcmProvider()).not.toBeNull();
    if (before === undefined) delete process.env.FCM_SERVICE_ACCOUNT;
    else process.env.FCM_SERVICE_ACCOUNT = before;
  });

  it('a complete credential yields a provider', () => {
    const before = process.env.FCM_SERVICE_ACCOUNT;
    process.env.FCM_SERVICE_ACCOUNT = JSON.stringify({
      client_email: 'e',
      private_key: 'k',
      project_id: 'p',
    });
    expect(getFcmProvider()).not.toBeNull();
    if (before === undefined) delete process.env.FCM_SERVICE_ACCOUNT;
    else process.env.FCM_SERVICE_ACCOUNT = before;
  });
});

describe('A DEAD TOKEN IS DROPPED, and a live one never is', () => {
  /*
   * Why this exists. Nothing acted on FCM's terminal answers, so a token whose
   * app had been uninstalled or whose data had been cleared stayed in the table
   * and was retried on every fan-out — measured on staging, the same row id
   * refused on every send for hours while the device showed as registered.
   *
   * The risk in fixing it is the opposite mistake: `INVALID_ARGUMENT` is also
   * what a MALFORMED PAYLOAD returns, and treating that as a dead token would
   * unregister working devices because of our own bug. Hence the field check,
   * and hence these cases.
   */
  it('UNREGISTERED: the token is reported dead', async () => {
    stubFetch({ ok: false, status: 404, body: { error: { status: 'UNREGISTERED' } } });
    const dead: string[] = [];
    const p = new FcmPushProvider(
      { client_email: 'e', private_key: KEY, project_id: 'p' },
      (t) => dead.push(t),
    );
    await p.send(TARGET, { title: 'x', body: 'y', data: { topicId: 't1' } } as never);
    expect(dead).toEqual([TOKEN]);
  });

  it('INVALID_ARGUMENT on message.token: dead', async () => {
    stubFetch({
      ok: false,
      status: 400,
      body: {
        error: {
          status: 'INVALID_ARGUMENT',
          details: [{ fieldViolations: [{ field: 'message.token', description: 'not valid' }] }],
        },
      },
    });
    const dead: string[] = [];
    const p = new FcmPushProvider(
      { client_email: 'e', private_key: KEY, project_id: 'p' },
      (t) => dead.push(t),
    );
    await p.send(TARGET, { title: 'x', body: 'y', data: { topicId: 't1' } } as never);
    expect(dead).toEqual([TOKEN]);
  });

  it('HOSTILE: INVALID_ARGUMENT on ANY OTHER field keeps the token', async () => {
    // Our payload bug must never cost a user their registration.
    stubFetch({
      ok: false,
      status: 400,
      body: {
        error: {
          status: 'INVALID_ARGUMENT',
          details: [{ fieldViolations: [{ field: 'message.android.notification' }] }],
        },
      },
    });
    const dead: string[] = [];
    const p = new FcmPushProvider(
      { client_email: 'e', private_key: KEY, project_id: 'p' },
      (t) => dead.push(t),
    );
    await p.send(TARGET, { title: 'x', body: 'y', data: { topicId: 't1' } } as never);
    expect(dead, 'a payload bug unregistered a working device').toEqual([]);
  });

  it.each([
    ['QUOTA_EXCEEDED', 429],
    ['UNAVAILABLE', 503],
    ['INTERNAL', 500],
  ])('RETRYABLE: %s keeps the token', async (status, http) => {
    stubFetch({ ok: false, status: http, body: { error: { status } } });
    const dead: string[] = [];
    const p = new FcmPushProvider(
      { client_email: 'e', private_key: KEY, project_id: 'p' },
      (t) => dead.push(t),
    );
    await p.send(TARGET, { title: 'x', body: 'y', data: { topicId: 't1' } } as never);
    expect(dead).toEqual([]);
  });

  it('a successful send reports nothing', async () => {
    stubFetch({ ok: true, status: 200 });
    const dead: string[] = [];
    const p = new FcmPushProvider(
      { client_email: 'e', private_key: KEY, project_id: 'p' },
      (t) => dead.push(t),
    );
    await p.send(TARGET, { title: 'x', body: 'y', data: { topicId: 't1' } } as never);
    expect(dead).toEqual([]);
  });

  it('EMPTY: no callback at all is not a crash', async () => {
    stubFetch({ ok: false, status: 404, body: { error: { status: 'UNREGISTERED' } } });
    await expect(
      provider().send(TARGET, { title: 'x', body: 'y', data: { topicId: 't1' } } as never),
    ).resolves.toBeUndefined();
  });

  it('HOSTILE: a callback that throws never reaches the caller', async () => {
    stubFetch({ ok: false, status: 404, body: { error: { status: 'UNREGISTERED' } } });
    const p = new FcmPushProvider({ client_email: 'e', private_key: KEY, project_id: 'p' }, () => {
      throw new Error('db down');
    });
    await expect(
      p.send(TARGET, { title: 'x', body: 'y', data: { topicId: 't1' } } as never),
    ).resolves.toBeUndefined();
  });

  describe('isDeadToken on its own', () => {
    it.each([
      ['UNREGISTERED', '', true],
      ['SENDER_ID_MISMATCH', '', true],
      ['INVALID_ARGUMENT', '{"field":"message.token"}', true],
      ['INVALID_ARGUMENT', '{"field":"message.data"}', false],
      ['INVALID_ARGUMENT', '', false],
      ['QUOTA_EXCEEDED', '{"field":"message.token"}', false],
      ['unknown', '', false],
      ['', '', false],
    ])('%s + %s → %s', (error, body, expected) => {
      expect(isDeadToken(error, body)).toBe(expected);
    });
  });
});
