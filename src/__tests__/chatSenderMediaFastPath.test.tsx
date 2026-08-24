// @vitest-environment jsdom
/**
 * The SENDER's own attachment renders from the bytes it already holds.
 *
 * `ChatMediaAttachment` is written from the reader's point of view — it has an
 * envelope naming an object, so it fetches the object and decrypts it. Right for
 * every bubble except the one belonging to the tab that encrypted and uploaded
 * those exact bytes a moment earlier and then discarded the plaintext. Measured
 * against staging, a 7.7MB image took 8661ms before its SENDER could see it, of
 * which the crypto was 18ms and 2441ms was that redundant round trip. Against a
 * local container the same round trip is 41ms, which is why nothing here
 * noticed.
 *
 * EDGE-CASE MATRIX → coverage
 *   contract      → the sender's bubble issues NO media GET
 *   integrity     → the fast-path blob is byte-identical, and same-mime, to the
 *                   one the reader path produces. Both surfaces key their image
 *                   cache on the URL, so a divergence here would be invisible.
 *   empty/miss    → with the cache dropped (a reload, another device) the reader
 *                   path still runs and still renders
 *   boundary      → an attachment larger than the whole budget is not cached,
 *                   and falls through rather than evicting everything for nothing
 *   race          → a send whose SEAL fails caches nothing, so no id is left
 *                   pointing at bytes no message will ever name
 *
 * The storage double is a real store: the GET serves back exactly the bytes the
 * POST uploaded, and `sealMedia`/`openMedia` are inverses. A fake that returned
 * some other plaintext on GET could not tell "identical" from "close enough".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushQueries } from './harness/providers';
import {
  MAX_CHAT_MEDIA_BYTES,
  chatMediaObjectKey,
} from '@/lib/chatMedia';
import {
  __resetSentChatMediaCache,
  rememberSentChatMedia,
  readSentChatMedia,
} from '@/lib/chatMediaPlaintextCache';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { minimalPng } from '../../packages/mls/src/__tests__/imageFixtures';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TOPIC = '11111111-2222-4333-8444-555555555555';
const ME = 'nullifier-me';

/** Self-inverse stand-in for the AEAD: ciphertext is not plaintext, and opens. */
const flip = (b: Uint8Array) => b.map((x) => x ^ 0x5a);

let sealFails = false;

/**
 * Ciphertext → body, so a REMOUNTED panel can read its own history back.
 *
 * Not a convenience: a reader who fetches an attachment is by definition one
 * whose message body decrypted, and without this the remount renders an empty
 * room and the reader path has nothing to run against. `openCached` refuses
 * anything it was not given, so it is no more permissive than the real store.
 */
const sealedBodies = new Map<string, string>();

const mlsStore = {
  openCached: vi.fn(async (_t: string, _id: string, sealed: { ciphertext: string }) =>
    sealedBodies.get(sealed.ciphertext) ?? null,
  ),
  open: vi.fn(async () => null),
  seal: vi.fn(async (_t: string, plaintext: string) => {
    const ciphertext = `ct-${sealedBodies.size}`;
    sealedBodies.set(ciphertext, plaintext);
    return { ciphertext, epoch: 0 };
  }),
  cachePlaintext: vi.fn(async () => {}),
};

const takStore = {
  backfill: vi.fn(async () => [] as { messageId: string; plaintext: string }[]),
  myDeviceId: vi.fn(async () => 'device-1'),
  distributeRoot: vi.fn(async () => 0),
  distributeRootWhenGroupChanged: vi.fn(async () => 0),
  grantPrivateHistory: vi.fn(async () => {}),
  sealForPush: vi.fn(async () => null),
  takForPush: vi.fn(async () => null),
  archiveOnSend: vi.fn(async () => {}),
  archiveRootState: vi.fn(async () => 'verified'),
  backfillMissingArchive: vi.fn(async () => 0),
  forgetUnsettledRoot: vi.fn(() => {}),
  sealMedia: vi.fn(async (_t: string, _id: string, bytes: Uint8Array) =>
    sealFails ? null : { ciphertext: flip(bytes), takVersion: 0 },
  ),
  openMedia: vi.fn(async (_t: string, _id: string, _v: number, sealed: Uint8Array) => ({
    ok: true as const,
    bytes: flip(sealed),
  })),
};

vi.mock('@/lib/mls/webTransport', () => ({
  getMlsSessionStore: () => mlsStore,
  getTakSessionStore: () => takStore,
  getDeviceKeyState: async () => 'ready',
  recoverDeviceWithPasskey: async () => true,
}));

const { default: ChatPanel } = await import('@/components/ChatPanel');
const { TestProviders } = await import('./harness/providers');

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  listeners = new Map<string, ((e: { data: string }) => void)[]>();
  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (e: { data: string }) => void) {
    const l = this.listeners.get(type) ?? [];
    l.push(fn);
    this.listeners.set(type, l);
  }
  close() {}
}

let requests: string[];
/** object key → the ciphertext the client actually uploaded. */
let stored: Map<string, Uint8Array>;
/** Every Blob handed to `createObjectURL`, in order. */
let blobs: { type: string; bytes: Uint8Array }[];
let sentCount: number;
/** Messages the server has accepted, served back as this room's history. */
let history: Record<string, unknown>[];

function json(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as unknown as Response;
}

function octets(bytes: Uint8Array) {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/octet-stream' }),
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    json: async () => {
      throw new Error('the attachment read route answers octets, not JSON');
    },
  } as unknown as Response;
}

function installFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      requests.push(`${method} ${url}`);
      if (url === '/api/auth/session') return json({ userId: ME });
      if (url === `/api/topics/${TOPIC}`) {
        return json({ topic: { visibility: 'public' }, currentUserRole: 'member' });
      }
      if (url.startsWith(`/api/topics/${TOPIC}/chat/media`)) {
        const key = new URL(url, 'http://x').searchParams.get('key');
        if (method === 'GET') {
          const bytes = key ? stored.get(key) : undefined;
          if (!bytes) return json({ error: 'gone' }, false, 404);
          return octets(bytes);
        }
        if (method === 'PATCH' || method === 'DELETE') return json({ ok: true });
        const mediaId = new URL(url, 'http://x').searchParams.get('mediaId');
        if (!mediaId) throw new Error('the attachment upload must name its mediaId');
        if (typeof init?.body === 'string') throw new Error('the upload takes raw bytes');
        const objectKey = chatMediaObjectKey(TOPIC, ME, mediaId);
        stored.set(objectKey, new Uint8Array(init!.body as ArrayBuffer & Uint8Array));
        return json({ key: objectKey });
      }
      if (url.startsWith(`/api/topics/${TOPIC}/chat?`)) {
        return json({ messages: history, total: history.length });
      }
      if (url === `/api/topics/${TOPIC}/chat`) {
        const { ciphertext, epoch } = JSON.parse(String(init?.body ?? '{}'));
        const message = {
          id: `m${++sentCount}`,
          topicId: TOPIC,
          userId: ME,
          nickname: 'me',
          type: 'message',
          createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, sentCount)).toISOString(),
          message: null,
          sealed: { ciphertext, epoch },
        };
        history.push(message);
        return json({ message }, true, 201);
      }
      return json({ error: 'not found' }, false, 404);
    }),
  );
}

let container: HTMLDivElement;
let root: Root;

/*
 * A macrotask drain, not a microtask one.
 *
 * TanStack Query delivers results through `notifyManager`, which schedules on a
 * real `setTimeout(0)` — so draining microtasks alone leaves every query result
 * undelivered and every assertion reading "not yet". Same helper, same reason,
 * as the mini-app harness's `settle`.
 */
const flush = flushQueries;

async function mount() {
  await act(async () => {
    root.render(
      <TestProviders initialLocale="en">
        <ChatPanel topicId={TOPIC} isGuest={false} isMember={true} />
      </TestProviders>,
    );
  });
  await flush();
}

async function remount() {
  await act(async () => {
    root.render(null); // unmount everything: this is the tab closing
  });
  await mount();
}

function fileInput(): HTMLInputElement {
  const el = container.querySelector('input[type="file"]');
  if (!el) throw new Error('no file input rendered');
  return el as HTMLInputElement;
}

async function attach(bytes = minimalPng(), name = 'photo.png', type = 'image/png') {
  const file = new File([bytes as BlobPart], name, { type });
  Object.defineProperty(fileInput(), 'files', { value: [file], configurable: true });
  Object.defineProperty(file, 'arrayBuffer', {
    value: async () => bytes.buffer.slice(0),
    configurable: true,
  });
  await act(async () => {
    fileInput().dispatchEvent(new Event('change', { bubbles: true }));
  });
  await flush();
}

const mediaGets = () => requests.filter((r) => r.startsWith(`GET /api/topics/${TOPIC}/chat/media`));
const renderedImage = () => container.querySelector('[data-testid="chat-media-image"]');

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  requests = [];
  history = [];
  sealedBodies.clear();
  stored = new Map();
  blobs = [];
  sentCount = 0;
  sealFails = false;
  __resetSentChatMediaCache();
  vi.clearAllMocks();
  Element.prototype.scrollIntoView = function scrollIntoView() {};
  (Element.prototype as unknown as { scrollTo: () => void }).scrollTo = function scrollTo() {};
  window.localStorage.clear();
  vi.stubGlobal('EventSource', FakeEventSource as unknown as typeof EventSource);
  let n = 0;
  vi.stubGlobal(
    'URL',
    Object.assign(globalThis.URL, {
      createObjectURL: (b: Blob) => {
        // Record what was actually put on screen. `Blob.arrayBuffer` is async
        // and this is not, so the bytes are read from the Blob's parts, which
        // is what the component passed in.
        const parts = (b as unknown as { __parts?: Uint8Array }).__parts;
        blobs.push({ type: b.type, bytes: parts ?? new Uint8Array() });
        return `blob:${++n}`;
      },
      revokeObjectURL: () => {},
    }),
  );
  // jsdom's Blob does not expose its parts; keep them so the assertions can
  // compare the bytes that reached the <img>, not just its size.
  const RealBlob = globalThis.Blob;
  vi.stubGlobal(
    'Blob',
    class extends RealBlob {
      __parts: Uint8Array;
      constructor(parts: BlobPart[] = [], options?: BlobPropertyBag) {
        super(parts, options);
        const first = parts[0];
        this.__parts = first instanceof Uint8Array ? new Uint8Array(first) : new Uint8Array();
      }
    },
  );
  installFetch();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  FakeEventSource.instances = [];
  vi.unstubAllGlobals();
});

describe("the sender's own attachment", () => {
  it('CONTRACT: renders without downloading or decrypting what this tab just uploaded', async () => {
    await mount();
    await attach();

    expect(renderedImage(), 'the sender never saw their own picture').toBeTruthy();
    expect(mediaGets(), 'the sender re-downloaded the bytes it just uploaded').toEqual([]);
    expect(takStore.openMedia).not.toHaveBeenCalled();
  });

  it('INTEGRITY: the fast-path bytes are the bytes a reload produces', async () => {
    /*
     * The one way this fix could be wrong and still look right. Both surfaces
     * cache images by URL, so a sender-rendered bubble that differed from the
     * reloaded one — a pre-strip original, a different mime — would not surface
     * anywhere; the picture would simply change when the tab was reopened.
     */
    await mount();
    await attach();
    const fromCache = blobs.at(-1)!;

    // Same failed row, same object, fresh tab: the reader path runs for real.
    __resetSentChatMediaCache();
    blobs = [];
    await remount();
    await flush();
    const fromNetwork = blobs.at(-1);

    expect(mediaGets().length, 'the reader path did not run').toBeGreaterThan(0);
    expect(fromNetwork, 'nothing was rendered after the reload').toBeTruthy();
    expect(fromNetwork!.type).toBe(fromCache.type);
    expect(Array.from(fromNetwork!.bytes)).toEqual(Array.from(fromCache.bytes));
  });

  it('MISS: with nothing cached the reader path still renders the picture', async () => {
    await mount();
    await attach();
    __resetSentChatMediaCache();
    await remount();

    expect(mediaGets().length).toBeGreaterThan(0);
    expect(renderedImage()).toBeTruthy();
  });

  it('RACE: a seal that fails caches nothing', async () => {
    // Nothing was sealed, so no id was minted into an envelope anyone will ever
    // name. Caching here would hold bytes until the tab closed for no reader.
    sealFails = true;
    await mount();
    await attach();

    expect(renderedImage()).toBeFalsy();
    expect(readSentChatMedia('any-id', 1, 'image/png')).toBeNull();
  });
});

describe('the sender cache itself', () => {
  it('BOUNDARY: an attachment bigger than the whole budget is skipped, not cached', () => {
    // The budget is bytes, not entries, because one entry can be the size cap.
    // A file that cannot fit must not evict everything else on the way to not
    // fitting.
    __resetSentChatMediaCache();
    rememberSentChatMedia('small', new Uint8Array(16), 'image/png');
    rememberSentChatMedia('huge', new Uint8Array(MAX_CHAT_MEDIA_BYTES * 4), 'image/png');

    expect(readSentChatMedia('huge', MAX_CHAT_MEDIA_BYTES * 4, 'image/png')).toBeNull();
    expect(readSentChatMedia('small', 16, 'image/png')).toBeTruthy();
  });

  it('BOUNDARY: the oldest entries are dropped once the budget is exceeded', () => {
    __resetSentChatMediaCache();
    const nine = 9 * 1024 * 1024;
    for (const id of ['a', 'b', 'c']) rememberSentChatMedia(id, new Uint8Array(nine), 'image/png');

    expect(readSentChatMedia('a', nine, 'image/png'), 'the oldest survived eviction').toBeNull();
    expect(readSentChatMedia('c', nine, 'image/png')).toBeTruthy();
  });

  it("HOSTILE: an envelope that disagrees with the cached entry is not served from it", () => {
    // The envelope describes what the reader must get back. Anything that
    // disagrees with it is not the thing being asked for, and the network is
    // always a correct answer.
    __resetSentChatMediaCache();
    rememberSentChatMedia('id-1', new Uint8Array([1, 2, 3]), 'image/png');

    expect(readSentChatMedia('id-1', 4, 'image/png'), 'a size mismatch was served').toBeNull();
    expect(readSentChatMedia('id-1', 3, 'image/jpeg'), 'a mime mismatch was served').toBeNull();
    expect(readSentChatMedia('id-1', 3, 'image/png')).toBeTruthy();
  });
});
