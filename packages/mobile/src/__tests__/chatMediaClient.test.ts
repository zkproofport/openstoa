/**
 * The mini-app's encrypted-attachment wire calls (R-3 / M-1).
 *
 * These three methods are what the failed-attachment row on `ChatRoomScreen`
 * is built out of — upload the ciphertext, claim it once its message goes out,
 * delete it when the user abandons it. The SCREEN cannot be driven here (this
 * package has no RN renderer in its test setup), so what is pinned is the
 * contract between the screen and the server: path, method, and the shape of
 * the body. A regression in any of them shows up as an attachment that is
 * uploaded twice, never claimed (and so collected an hour later while its
 * message is live), or abandoned without being deleted.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { OpenStoaClient } from '../api/openstoaClient';
import type { HostApi, HostEnvironmentInfo } from '@openstoa/miniapp-bridge';
import { chatMediaObjectKey } from '../lib/chatMedia';

const TOPIC = '11111111-2222-4333-8444-555555555555';
const USER = 'nullifier-me';
const MEDIA = 'a'.repeat(32);
const KEY = chatMediaObjectKey(TOPIC, USER, MEDIA);

function makeHost(): HostApi {
  const env: HostEnvironmentInfo = {
    isEmbedded: true,
    hostName: 'test-host',
    openstoaBaseUrl: 'https://test.openstoa.local',
  };
  return {
    getEnvironment: () => env,
    getOpenStoaToken: vi.fn(async () => 'jwt.token'),
    loginToOpenStoa: vi.fn(async () => ({ token: 'jwt.token', userId: USER, needsNickname: false })),
    logoutFromOpenStoa: vi.fn(async () => {}),
    generateProof: vi.fn(),
    exitToHost: vi.fn(),
    showError: vi.fn(),
    getLanguage: () => 'en',
    onLanguageChange: () => () => {},
    getTheme: () => 'light',
    onThemeChange: () => () => {},
  } as unknown as HostApi;
}

interface Call {
  url: string;
  method: string;
  body: unknown;
  contentType: string | null;
}

function installFetch(responses: Array<{ status: number; body?: unknown }>): Call[] {
  const calls: Call[] = [];
  let i = 0;
  (globalThis as unknown as { fetch: unknown }).fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const raw = init?.body;
    const headers = new Headers((init?.headers ?? {}) as HeadersInit);
    calls.push({
      url: String(input),
      method: (init?.method ?? 'GET').toString().toUpperCase(),
      body: typeof raw === 'string' ? JSON.parse(raw) : raw,
      contentType: headers.get('content-type'),
    });
    const spec = responses[i++] ?? { status: 500 };
    return {
      ok: spec.status >= 200 && spec.status < 300,
      status: spec.status,
      json: async () => spec.body ?? {},
      text: async () => JSON.stringify(spec.body ?? {}),
    } as unknown as Response;
  });
  return calls;
}

function client(): OpenStoaClient {
  const c = new OpenStoaClient({ host: makeHost() });
  c.setMode('authenticated');
  return c;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('uploadChatMedia', () => {
  const CT = new Uint8Array([1, 2, 3]);

  it('POSTs the ciphertext as RAW BYTES and returns the key the server assigned', async () => {
    const calls = installFetch([{ status: 200, body: { key: KEY } }]);
    const key = await client().uploadChatMedia(TOPIC, MEDIA, CT);

    expect(key).toBe(KEY);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toContain(`/api/topics/${TOPIC}/chat/media`);
    /*
     * The transport change, pinned. It used to be
     * `{ mediaId, ciphertext: '<base64>' }`, which spent a third of a 10MB
     * ceiling on an encoding neither end wanted and put the advertised cap out
     * of reach. A revert would send a JSON string here.
     */
    expect(calls[0].body).toBeInstanceOf(Uint8Array);
    expect(Array.from(calls[0].body as Uint8Array)).toEqual([1, 2, 3]);
    expect(calls[0].contentType).toBe('application/octet-stream');
  });

  it('CONTRACT: the media id rides in the query string, URL-encoded', async () => {
    // A raw body has nowhere to put it. The server builds the object key from
    // it, so a client that stopped sending it would upload to a 400 forever.
    const calls = installFetch([{ status: 200, body: { key: KEY } }]);
    await client().uploadChatMedia(TOPIC, MEDIA, CT);
    expect(calls[0].url).toContain(`mediaId=${MEDIA}`);
  });

  it('CONTRACT: the plaintext never appears in the request', async () => {
    // The body carries AEAD output and the URL carries an id. Anything else
    // would mean the encryption happened somewhere it should not have.
    const calls = installFetch([{ status: 200, body: { key: KEY } }]);
    await client().uploadChatMedia(TOPIC, MEDIA, CT);
    expect(calls[0].url).not.toContain('ciphertext');
    expect(typeof calls[0].body).not.toBe('string');
  });

  it('a refused upload throws rather than returning an empty key', async () => {
    installFetch([{ status: 500, body: { error: 'r2 down' } }]);
    await expect(client().uploadChatMedia(TOPIC, MEDIA, CT)).rejects.toThrow();
  });
});

describe('chatMediaFetchSpec', () => {
  /*
   * A SPEC rather than the bytes. RN's `Response.arrayBuffer()` is not
   * dependable (facebook/react-native#6743), so the download is done by the
   * native filesystem straight to disk — this client's job is the URL and the
   * credential, which is the part that needs the session.
   */
  it('names the membership-gated route and carries the bearer token', async () => {
    installFetch([]);
    const spec = await client().chatMediaFetchSpec(TOPIC, KEY);
    expect(spec.url).toContain(`/api/topics/${TOPIC}/chat/media`);
    expect(spec.headers.Authorization).toBe('Bearer jwt.token');
  });

  it('the key is URL-encoded — an unescaped `/` would address a different object', async () => {
    installFetch([]);
    const spec = await client().chatMediaFetchSpec(TOPIC, KEY);
    expect(spec.url).not.toContain(`key=${KEY}`);
    expect(spec.url).toContain('%2F');
  });

  it('CONTRACT: it never fetches anything itself', async () => {
    // Building the spec must not spend a round trip; the native download is
    // the only request on this path.
    const calls = installFetch([]);
    await client().chatMediaFetchSpec(TOPIC, KEY);
    expect(calls).toHaveLength(0);
  });

  it('a guest gets an auth error rather than an unauthenticated URL', async () => {
    // An anonymous download would 401 into a file and read as a broken image.
    installFetch([]);
    const c = new OpenStoaClient({ host: makeHost() });
    c.setMode('guest');
    await expect(c.chatMediaFetchSpec(TOPIC, KEY)).rejects.toThrow();
  });
});

describe('claimChatMedia', () => {
  it('PATCHes the key, so the collector leaves a referenced object alone', async () => {
    const calls = installFetch([{ status: 200, body: { claimed: true } }]);
    await client().claimChatMedia(TOPIC, KEY);

    expect(calls[0].method).toBe('PATCH');
    expect(calls[0].url).toContain(`key=${encodeURIComponent(KEY)}`);
  });

  it('the key is URL-encoded — an unescaped `/` would address a different object', async () => {
    const calls = installFetch([{ status: 200, body: { claimed: true } }]);
    await client().claimChatMedia(TOPIC, KEY);
    expect(calls[0].url).not.toContain(`key=${KEY}`);
    expect(calls[0].url).toContain('%2F');
  });
});

describe('deleteChatMedia', () => {
  it('DELETEs the key, so an abandoned attachment does not linger', async () => {
    const calls = installFetch([{ status: 200, body: { deleted: true } }]);
    await client().deleteChatMedia(TOPIC, KEY);

    expect(calls[0].method).toBe('DELETE');
    expect(calls[0].url).toContain(`key=${encodeURIComponent(KEY)}`);
  });

  it('a refused delete surfaces, so a caller can decide (the screen swallows it)', async () => {
    installFetch([{ status: 403, body: { error: 'not yours' } }]);
    await expect(client().deleteChatMedia(TOPIC, KEY)).rejects.toThrow();
  });
});
