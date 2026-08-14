// @vitest-environment jsdom
/**
 * Attaching an image that FAILS must say so — the defect a live browser found
 * and 136 mocked tests did not.
 *
 * What happened: the object store was unreachable, `POST .../chat/media`
 * answered 500, and the picture simply never appeared. No error, no failed row,
 * nothing. A silent drop is how people lose messages without knowing it, so
 * every failure on this path has to reach the composer.
 *
 * The other half of that incident — the index row left behind by the failed
 * upload — is a server concern and lives in `chat-media-route.test.ts`.
 *
 * These drive the REAL `ChatPanel` through a real file selection; only the
 * network and the crypto stores are doubled.
 */
import enLocale from '@/lib/i18n/locales/en.json';
import {
  CHAT_MEDIA_RETRY_WINDOW_MS,
  MAX_CHAT_MEDIA_BYTES,
  chatMediaObjectKey,
  parseFailedMedia,
  serializeFailedMedia,
} from '@/lib/chatMedia';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/*
 * The lazily-imported decoder is stubbed at the MODULE boundary — the
 * third-party package, not our conversion code — so both attempts are
 * deterministic. Without this the real libheif runs under WASM and the test
 * becomes a race between a slow decode and the flush window.
 */
const decoderState = vi.hoisted(() => ({ jpeg: null as Uint8Array | null }));
vi.mock('heic-convert/browser', () => ({
  default: async () => {
    if (!decoderState.jpeg) throw new Error('libheif cannot read this');
    return decoderState.jpeg.buffer.slice(0);
  },
}));
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TOPIC = '11111111-2222-4333-8444-555555555555';
const ME = 'nullifier-me';

/** What `sealMedia` should do this test — null means "no key held". */
let sealOutcome: 'ok' | 'no-key' | 'throw';

const mlsStore = {
  openCached: vi.fn(async () => null),
  open: vi.fn(async () => null),
  seal: vi.fn(async (_t: string, plaintext: string) => ({ ciphertext: `ct-${plaintext}`, epoch: 0 })),
  cachePlaintext: vi.fn(async () => {}),
};

const takStore = {
  backfill: vi.fn(async () => [] as { messageId: string; plaintext: string }[]),
  myDeviceId: vi.fn(async () => 'device-1'),
  distributePublicRoot: vi.fn(async () => 0),
  distributePublicRootWhenGroupChanged: vi.fn(async () => 0),
  grantPrivateHistory: vi.fn(async () => {}),
  sealForPush: vi.fn(async () => null),
  takForPush: vi.fn(async () => null),
  archiveOnSend: vi.fn(async () => {}),
  archiveRootState: vi.fn(async () => 'verified'),
  backfillMissingArchive: vi.fn(async () => 0),
  forgetUnsettledRoot: vi.fn(() => {}),
  sealMedia: vi.fn(async (_t: string, _id: string, bytes: Uint8Array) => {
    if (sealOutcome === 'no-key') return null;
    if (sealOutcome === 'throw') throw new Error('tak store exploded');
    const ct = new Uint8Array(bytes.length + 1);
    ct.set(bytes, 1);
    return { ciphertext: ct, takVersion: 0 };
  }),
  // A stored attachment opens — the failed ROW still shows its picture, which
  // is what makes retry-in-place better than re-picking the file.
  openMedia: vi.fn(async () => ({ ok: true as const, bytes: new Uint8Array([1, 2, 3]) })),
};

vi.mock('@/lib/mls/webTransport', () => ({
  getMlsSessionStore: () => mlsStore,
  getTakSessionStore: () => takStore,
  getDeviceKeyState: async () => 'ready',
  recoverDeviceWithPasskey: async () => true,
}));

const { default: ChatPanel } = await import('@/components/ChatPanel');
const { I18nProvider } = await import('@/lib/i18n/I18nProvider');

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

/** Status the media upload answers with. 200 means success. */
let mediaUploadStatus: number;
/**
 * Statuses `POST /chat` answers with, consumed in order (the last one repeats).
 * 409 is the real-world case this was reported for: MLS epoch-CAS conflict, so
 * the UPLOAD succeeded and only the message failed.
 */
let sendStatuses: number[];
let sentCount: number;
/** Status a media GET answers with — 404 is "the collector took it". */
let mediaGetStatus: number;
/** Every request the panel issued, in order. */
let requests: string[];

function json(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as unknown as Response;
}

function installFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push(`${(init?.method ?? 'GET').toUpperCase()} ${url}`);
      if (url === '/api/auth/session') return json({ userId: ME });
      if (url === `/api/topics/${TOPIC}`) {
        return json({ topic: { visibility: 'public' }, currentUserRole: 'member' });
      }
      if (url.startsWith(`/api/topics/${TOPIC}/chat/media`)) {
        const method = (init?.method ?? 'GET').toUpperCase();
        // A stored object reads back as ciphertext, the way the real route
        // answers — otherwise the attachment renders its OWN retry affordance
        // and the row's controls become ambiguous.
        if (method === 'GET') {
          if (mediaGetStatus !== 200) return json({ error: 'gone' }, false, mediaGetStatus);
          return json({ ciphertext: 'AQID' });
        }
        if (method === 'PATCH' || method === 'DELETE') return json({ ok: true });
        if (mediaUploadStatus !== 200) {
          return json({ error: 'R2_ACCOUNT_ID ... required' }, false, mediaUploadStatus);
        }
        // The real route derives the key FROM the posted mediaId, and the
        // envelope is rejected if the two disagree — so the stub must too.
        const posted = JSON.parse(String(init?.body ?? '{}')) as { mediaId?: string };
        return json({ key: chatMediaObjectKey(TOPIC, ME, posted.mediaId ?? '') });
      }
      if (url.startsWith(`/api/topics/${TOPIC}/chat?`)) return json({ messages: [], total: 0 });
      if (url === `/api/topics/${TOPIC}/chat`) {
        const status = sendStatuses.length > 1 ? sendStatuses.shift()! : sendStatuses[0];
        if (status !== 201) return json({ error: 'epoch conflict' }, false, status);
        return json({ message: { id: `m${++sentCount}`, createdAt: new Date().toISOString() } }, true, 201);
      }
      return json({ error: 'not found' }, false, 404);
    }),
  );
}

let container: HTMLDivElement;
let root: Root;

async function flush(times = 8) {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function mount() {
  await act(async () => {
    root.render(
      <I18nProvider initialLocale="en">
        <ChatPanel topicId={TOPIC} isGuest={false} isMember={true} />
      </I18nProvider>,
    );
  });
  await flush();
}

function bodyText(): string {
  return container.textContent ?? '';
}

/** The hidden `<input type="file">` the attach button drives. */
function fileInput(): HTMLInputElement {
  const el = container.querySelector('input[type="file"]');
  if (!el) throw new Error('no file input rendered');
  return el as HTMLInputElement;
}

/** Select a file, exactly as a browser does: set `files`, dispatch `change`. */
async function attach(name = 'photo.png', type = 'image/png', bytes = new Uint8Array([1, 2, 3])) {
  const file = new File([bytes], name, { type });
  // jsdom's FileList is read-only; define the property the handler reads.
  Object.defineProperty(fileInput(), 'files', { value: [file], configurable: true });
  // jsdom's File has no arrayBuffer() in some versions — the component needs it.
  if (typeof (file as unknown as { arrayBuffer?: unknown }).arrayBuffer !== 'function') {
    Object.defineProperty(file, 'arrayBuffer', {
      value: async () => bytes.buffer.slice(0),
      configurable: true,
    });
  }
  await act(async () => {
    fileInput().dispatchEvent(new Event('change', { bubbles: true }));
  });
  await flush();
}

/**
 * Give jsdom a HEIC decoder.
 *
 * `createImageBitmap` + canvas is the real pipeline; jsdom has neither, which
 * is also what a browser WITHOUT HEIC support looks like — so the default
 * (absent) is the Chrome/Firefox case and installing it is the Safari case.
 * Pass null to simulate a decoder that fails on this file.
 */
function installHeicSupport(jpeg: Uint8Array | null) {
  const decode = vi.fn(async () => ({ width: 100, height: 80, close: () => {} }));
  vi.stubGlobal('createImageBitmap', decode);
  vi.stubGlobal('document', {
    ...document,
    createElement: (tag: string) => {
      if (tag !== 'canvas') return document.createElement(tag);
      return {
        width: 0,
        height: 0,
        getContext: () => (jpeg ? { drawImage: () => {} } : null),
        toBlob: (cb: (b: Blob | null) => void) =>
          cb(jpeg ? ({ arrayBuffer: async () => jpeg.buffer.slice(0) } as unknown as Blob) : null),
      };
    },
  });
  return decode;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  requests = [];
  mediaUploadStatus = 200;
  sendStatuses = [201];
  sentCount = 0;
  mediaGetStatus = 200;
  decoderState.jpeg = null; // no second-attempt decoder unless a test wants one
  sealOutcome = 'ok';
  vi.clearAllMocks();
  Element.prototype.scrollIntoView = function scrollIntoView() {};
  (Element.prototype as unknown as { scrollTo: () => void }).scrollTo = function scrollTo() {};
  window.localStorage.clear();
  vi.stubGlobal('EventSource', FakeEventSource as unknown as typeof EventSource);
  vi.stubGlobal('URL', Object.assign(globalThis.URL, { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} }));
  installFetch();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  FakeEventSource.instances = [];
  vi.unstubAllGlobals();
});

describe('an attachment that cannot be sent says so', () => {
  it('REGRESSION: a 500 from the object store surfaces in the composer', async () => {
    /*
     * The live incident, exactly: R2 unconfigured, the upload answers 500, and
     * the picture never appears. Before the fix the panel showed NOTHING — the
     * sender had no way to know the send had failed.
     */
    await mount();
    mediaUploadStatus = 500;
    await attach();

    expect(bodyText()).toContain(enLocale.chat.media.error['upload-failed']);
  });

  it('the failure is announced, not just drawn', async () => {
    // A silent drop and a drop nobody can hear are the same defect for anyone
    // using a screen reader.
    await mount();
    mediaUploadStatus = 500;
    await attach();

    const alert = container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert!.textContent).toContain(enLocale.chat.media.error['upload-failed']);
  });

  it('no message is POSTed when the upload failed', async () => {
    await mount();
    mediaUploadStatus = 500;
    await attach();

    expect(requests.filter((r) => r === `POST /api/topics/${TOPIC}/chat`)).toEqual([]);
  });

  it('the error clears on dismiss, and again on the next attempt', async () => {
    await mount();
    mediaUploadStatus = 500;
    await attach();
    expect(bodyText()).toContain(enLocale.chat.media.error['upload-failed']);

    const dismiss = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === enLocale.chat.offline.dismiss,
    );
    expect(dismiss).toBeDefined();
    await act(async () => dismiss!.click());
    expect(bodyText()).not.toContain(enLocale.chat.media.error['upload-failed']);

    // A second failure re-raises it rather than staying quiet because the state
    // was already "dismissed".
    await attach();
    expect(bodyText()).toContain(enLocale.chat.media.error['upload-failed']);
  });

  it('NO KEY: a room whose key has not arrived says that, not "upload failed"', async () => {
    // Distinct reasons get distinct sentences — this one is transient and the
    // user should retry, which "upload failed" does not tell them.
    await mount();
    sealOutcome = 'no-key';
    await attach();

    expect(bodyText()).toContain(enLocale.chat.media.error['no-key']);
    expect(bodyText()).not.toContain(enLocale.chat.media.error['upload-failed']);
    // Nothing was uploaded: a topic with no key must not put bytes anywhere.
    expect(requests.filter((r) => r.startsWith('POST') && r.includes('/chat/media'))).toEqual([]);
  });

  it('an UNEXPECTED throw is still reported, never swallowed', async () => {
    // Not a ChatMediaError — the catch must not fall through silently for the
    // one class of failure nobody predicted.
    await mount();
    sealOutcome = 'throw';
    await attach();

    expect(bodyText()).toContain(enLocale.chat.media.error['send-failed']);
  });

  it('REGRESSION: an image the browser could not type is SENT, not dropped in silence', async () => {
    /*
     * The second silent path from the same incident. `file.type` is empty
     * routinely — an extension the browser does not know, some drag-and-drop
     * sources, some pickers — and the old guard was
     * `if (!file.type.startsWith('image/')) return;`, a bare return. A real PNG
     * therefore produced no upload, no error and no bubble.
     *
     * The bytes are the authority now, so this sends.
     */
    await mount();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    await attach('photo', '', png);

    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(requests.some((r) => r.includes('/chat/media'))).toBe(true);
    expect(requests).toContain(`POST /api/topics/${TOPIC}/chat`);
  });

  it('a file that is genuinely not an image REPORTS, rather than vanishing', async () => {
    // Silence was the defect. Refusing is fine; refusing quietly is not.
    await mount();
    await attach('notes.txt', 'text/plain', new Uint8Array([0x68, 0x69, 0x21]));

    expect(bodyText()).toContain(enLocale.chat.media.error['unsupported-type']);
    // Scoped to POST: a GET can still arrive from an earlier row's decrypt.
    expect(requests.filter((r) => r.startsWith('POST') && r.includes('/chat/media'))).toEqual([]);
  });

  it('a file LYING about its type is sent as what its bytes are', async () => {
    // Claims PNG, is actually a JPEG. The reader must render what it received,
    // not what the sender's browser guessed.
    await mount();
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    await attach('lies.png', 'image/png', jpeg);

    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(takStore.sealMedia).toHaveBeenCalled();
    expect(requests).toContain(`POST /api/topics/${TOPIC}/chat`);
  });

  it('a SUCCESSFUL attach shows no error at all', async () => {
    await mount();
    await attach();

    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(requests).toContain(`POST /api/topics/${TOPIC}/chat`);
  });
});

/**
 * The reported case: the upload SUCCEEDS and the message send fails (repeated
 * 409 from MLS epoch-CAS). The failure is then about a MESSAGE, so it belongs
 * in the conversation with a retry — not in the composer, which is where people
 * are not looking.
 */
describe('an iPhone photo (HEIC)', () => {
  /** `ftyp` + brand at 4..12 — what the picker actually hands over. */
  const heic = (length = 64) => {
    const b = new Uint8Array(length);
    const head = '0000ftypheic';
    for (let i = 0; i < head.length; i++) b[i] = head.charCodeAt(i);
    return b;
  };
  const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 7, 7, 7]);

  it('REGRESSION: converts in the tab and sends, instead of refusing', async () => {
    /*
     * It used to be refused outright: the server transcoded HEIC and
     * encryption removed that, so an iPhone photo could not be sent at all.
     */
    installHeicSupport(JPEG);
    await mount();
    await attach('IMG_0001.HEIC', 'image/heic', heic());

    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(requests).toContain(`POST /api/topics/${TOPIC}/chat`);
  });

  it('CONTRACT: what gets SEALED is the JPEG, never the HEIC', async () => {
    installHeicSupport(JPEG);
    await mount();
    await attach('IMG_0001.HEIC', 'image/heic', heic());

    const sealed = takStore.sealMedia.mock.calls[0][2] as Uint8Array;
    expect(Array.from(sealed.slice(0, 3))).toEqual([0xff, 0xd8, 0xff]); // JPEG magic
    expect(String.fromCharCode(...sealed.slice(4, 8))).not.toBe('ftyp');
  });

  it('the envelope describes the CONVERTED bytes', async () => {
    installHeicSupport(JPEG);
    await mount();
    await attach('IMG_0001.HEIC', 'image/heic', heic());

    const body = mlsStore.seal.mock.calls[0][1] as string;
    const envelope = JSON.parse(body.slice('openstoa:media:v1:'.length));
    expect(envelope.mime).toBe('image/jpeg');
    expect(envelope.size).toBe(JPEG.length);
  });

  it('SIZE CAP applies to the converted bytes, not the original', async () => {
    // A small HEIC can decode into a large JPEG. The cap has to describe what
    // is actually being sent.
    installHeicSupport(new Uint8Array(MAX_CHAT_MEDIA_BYTES + 1));
    await mount();
    await attach('IMG_0002.HEIC', 'image/heic', heic());

    expect(bodyText()).toContain(enLocale.chat.media.error['too-large']);
    expect(requests.filter((r) => r.startsWith('POST') && r.includes('/chat/media'))).toEqual([]);
  });

  it('REGRESSION: a browser with NO native HEIC support still gets the picture through', async () => {
    /*
     * Chrome and Firefox cannot decode HEIC, so the platform attempt finds
     * nothing and the bundled decoder is imported. This is the person who used
     * to be refused for owning the wrong browser — the whole point of H-2.
     */
    decoderState.jpeg = JPEG;
    await mount();
    await attach('IMG_0003.HEIC', 'image/heic', heic());

    expect(container.querySelector('[role="alert"]')).toBeNull();
    const sealed = takStore.sealMedia.mock.calls[0][2] as Uint8Array;
    expect(Array.from(sealed.slice(0, 3)), 'a JPEG must be what is sealed').toEqual([0xff, 0xd8, 0xff]);
    expect(requests).toContain(`POST /api/topics/${TOPIC}/chat`);
  });

  /*
   * The REAL decoder (not this stub) is exercised in `chatMediaHeic.test.ts`.
   * Running it unstubbed here would put a WASM decode inside a component test
   * and make the assertion a race with the flush window. The unit tests inject
   * the loader instead and pin the same behaviour deterministically: ordering,
   * an import that fails, a decoder that throws, zero-byte output, and the
   * input cap being applied before anything is downloaded.
   *
   * The user-visible consequence of that slowness is real and handled: the
   * composer's attach control shows its uploading state for the whole of
   * `sendImage`, so a long decode reads as work in progress rather than a
   * frozen button.
   */

  it('a failed conversion REFUSES — it never sends the original', async () => {
    installHeicSupport(null); // decoder present, conversion fails
    await mount();
    await attach('IMG_0004.HEIC', 'image/heic', heic());

    expect(bodyText()).toContain(enLocale.chat.media.error['heic-unsupported']);
    expect(takStore.sealMedia).not.toHaveBeenCalled();
  });

  it('HOSTILE: a PNG named .heic is sent as a PNG, not fed to the decoder', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);
    const decode = installHeicSupport(JPEG);
    await mount();
    await attach('liar.heic', 'image/heic', png);

    expect(decode).not.toHaveBeenCalled();
    const body = mlsStore.seal.mock.calls[0][1] as string;
    expect(JSON.parse(body.slice('openstoa:media:v1:'.length)).mime).toBe('image/png');
  });
});

describe('a failed attachment lives in the conversation, like a failed text', () => {
  /** Retry / Discard controls, by their labels. */
  const control = (label: string) =>
    Array.from(container.querySelectorAll('button')).find((b) => b.textContent === label);
  /*
   * The ROW's retry, not the attachment's.
   *
   * A decrypt that fails renders its own Retry inside the picture, with the
   * same label — so "find a button called Retry" is ambiguous exactly when the
   * object is missing, which is the case these tests are about. The row's
   * controls are the pair: Retry sits beside Discard.
   */
  const retryButton = () =>
    Array.from(container.querySelectorAll('button')).find(
      (b) =>
        b.textContent === enLocale.chat.sendFailedRetry &&
        Array.from(b.parentElement?.querySelectorAll('button') ?? []).some(
          (sib) => sib.textContent === enLocale.chat.sendFailedDiscard,
        ),
    );
  const discardButton = () => control(enLocale.chat.sendFailedDiscard);

  it('REGRESSION: a 409 on send leaves a failed ROW, not a composer banner', async () => {
    await mount();
    sendStatuses = [409];
    await attach();

    expect(retryButton(), 'the failed row must offer a retry').toBeDefined();
    expect(discardButton()).toBeDefined();
    // The composer banner is for failures BEFORE a message exists.
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('the object is KEPT when the send fails, so a retry has something to send', async () => {
    await mount();
    sendStatuses = [409];
    await attach();

    expect(requests.filter((r) => r.startsWith('DELETE'))).toEqual([]);
  });

  it("RETRY re-sends the stored object and does NOT re-upload", async () => {
    // The user cannot be asked to find the file again, and the bytes are
    // already paid for.
    await mount();
    sendStatuses = [409, 201];
    await attach();
    const uploadsBefore = requests.filter((r) => r.includes('/chat/media') && r.startsWith('POST')).length;

    await act(async () => retryButton()!.click());
    await flush();

    const uploadsAfter = requests.filter((r) => r.includes('/chat/media') && r.startsWith('POST')).length;
    expect(uploadsAfter).toBe(uploadsBefore);
    expect(requests.filter((r) => r === `POST /api/topics/${TOPIC}/chat`).length).toBe(2);
  });

  it('RETRY after the epoch settles clears the failed row', async () => {
    // The exact reported sequence: 409, then success once the group settles.
    await mount();
    sendStatuses = [409, 201];
    await attach();
    expect(retryButton()).toBeDefined();

    await act(async () => retryButton()!.click());
    await flush();

    expect(retryButton()).toBeUndefined();
    expect(discardButton()).toBeUndefined();
  });

  it('RETRY that fails again keeps ONE row, still retryable', async () => {
    await mount();
    sendStatuses = [409];
    await attach();
    await act(async () => retryButton()!.click());
    await flush();

    expect(retryButton()).toBeDefined();
    expect(
      Array.from(container.querySelectorAll('button')).filter(
        (b) => b.textContent === enLocale.chat.sendFailedRetry,
      ).length,
      'a retry must not clone the row',
    ).toBe(1);
  });

  it('a successful retry CLAIMS the object — it is referenced now', async () => {
    await mount();
    sendStatuses = [409, 201];
    await attach();
    await act(async () => retryButton()!.click());
    await flush();

    expect(requests.some((r) => r.startsWith('PATCH') && r.includes('/chat/media'))).toBe(true);
  });

  it('DISCARD deletes the object rather than stranding it', async () => {
    await mount();
    sendStatuses = [409];
    await attach();

    await act(async () => discardButton()!.click());
    await flush();

    expect(requests.some((r) => r.startsWith('DELETE') && r.includes('/chat/media'))).toBe(true);
    expect(retryButton()).toBeUndefined();
  });

  it('TWO failed attachments keep two independent rows', async () => {
    await mount();
    sendStatuses = [409];
    await attach('one.png');
    await attach('two.png');

    expect(
      Array.from(container.querySelectorAll('button')).filter(
        (b) => b.textContent === enLocale.chat.sendFailedRetry,
      ).length,
    ).toBe(2);
  });

  it('DISCARD while a retry is in flight removes exactly one row', async () => {
    await mount();
    sendStatuses = [409];
    await attach('one.png');
    await attach('two.png');

    // Start a retry on the first, then discard the second before it settles.
    const retries = Array.from(container.querySelectorAll('button')).filter(
      (b) => b.textContent === enLocale.chat.sendFailedRetry,
    );
    await act(async () => retries[0].click());
    const discards = Array.from(container.querySelectorAll('button')).filter(
      (b) => b.textContent === enLocale.chat.sendFailedDiscard,
    );
    if (discards.length > 0) await act(async () => discards[discards.length - 1].click());
    await flush();

    // Whatever the interleaving, no row was duplicated and the panel survives.
    const remaining = Array.from(container.querySelectorAll('button')).filter(
      (b) => b.textContent === enLocale.chat.sendFailedRetry,
    ).length;
    expect(remaining).toBeLessThanOrEqual(1);
  });

  it('PERSISTED: the failed row is written to storage, not just drawn', async () => {
    await mount();
    sendStatuses = [409];
    await attach();

    const stored = parseFailedMedia(window.localStorage.getItem(`openstoa.failedMedia.${TOPIC}`), Date.now());
    expect(stored).toHaveLength(1);
    expect(stored[0].key).toContain(TOPIC);
    // A reference, never the picture.
    expect(JSON.stringify(stored)).not.toContain('AQID');
  });

  it('REGRESSION: a failed row SURVIVES a remount — the OS-killed-app case', async () => {
    /*
     * The row used to live only in component state. On a phone the OS kills a
     * backgrounded app routinely, so the user came back to no picture, no row
     * and no error, with the bytes collected within the hour — worse than the
     * bug this all started from, which at least left something on screen.
     */
    await mount();
    sendStatuses = [409];
    await attach();
    expect(retryButton()).toBeDefined();

    // Same storage, brand new component tree.
    await act(async () => root.unmount());
    container.remove();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    sendStatuses = [201];
    await mount();

    expect(retryButton(), 'the failed row must come back').toBeDefined();
    expect(discardButton()).toBeDefined();
  });

  it('EXPIRED: a restored row whose object is gone says so instead of retrying', async () => {
    // The collector took the bytes before the user came back. Re-sending would
    // post a message pointing at nothing.
    const key = chatMediaObjectKey(TOPIC, ME, 'c'.repeat(32));
    const body = `openstoa:media:v1:${JSON.stringify({
      v: 1,
      key,
      mediaId: 'c'.repeat(32),
      takVersion: 0,
      mime: 'image/png',
      size: 3,
    })}`;
    window.localStorage.setItem(
      `openstoa.failedMedia.${TOPIC}`,
      serializeFailedMedia([{ rowId: 'pending-old', body, key, createdAt: Date.now() - 60_000 }]),
    );
    // The object is gone from storage.
    mediaGetStatus = 404;
    await mount();
    expect(retryButton()).toBeDefined();

    await act(async () => retryButton()!.click());
    await flush();

    expect(bodyText()).toContain(enLocale.chat.media.expired);
    expect(retryButton(), 'no retry once the bytes are gone').toBeUndefined();
    // And it never posted a message pointing at nothing.
    expect(requests.filter((r) => r === `POST /api/topics/${TOPIC}/chat`)).toEqual([]);
  });

  it('EXPIRED: the row is still SHOWN — silence was the defect', async () => {
    const key = chatMediaObjectKey(TOPIC, ME, 'd'.repeat(32));
    const body = `openstoa:media:v1:${JSON.stringify({
      v: 1,
      key,
      mediaId: 'd'.repeat(32),
      takVersion: 0,
      mime: 'image/png',
      size: 3,
    })}`;
    window.localStorage.setItem(
      `openstoa.failedMedia.${TOPIC}`,
      // Older than the retry window: expired on arrival.
      serializeFailedMedia([
        { rowId: 'pending-stale', body, key, createdAt: Date.now() - CHAT_MEDIA_RETRY_WINDOW_MS - 1000 },
      ]),
    );
    await mount();

    expect(discardButton(), 'an expired row still offers the way out').toBeDefined();
  });

  it('a successful retry clears the row from storage', async () => {
    await mount();
    sendStatuses = [409, 201];
    await attach();
    expect(
      parseFailedMedia(window.localStorage.getItem(`openstoa.failedMedia.${TOPIC}`), Date.now()),
    ).toHaveLength(1);

    await act(async () => retryButton()!.click());
    await flush();

    expect(
      parseFailedMedia(window.localStorage.getItem(`openstoa.failedMedia.${TOPIC}`), Date.now()),
    ).toEqual([]);
  });

  it('DISCARD clears the row from storage too', async () => {
    await mount();
    sendStatuses = [409];
    await attach();

    await act(async () => discardButton()!.click());
    await flush();

    expect(
      parseFailedMedia(window.localStorage.getItem(`openstoa.failedMedia.${TOPIC}`), Date.now()),
    ).toEqual([]);
  });

  it('UI: the row\'s Retry and the picture\'s Reload are different words', async () => {
    /*
     * They used to be the same word on the same row: one re-sends the message,
     * the other re-fetches the picture. A test could not tell them apart, which
     * is the tell that a reader could not either.
     */
    expect(enLocale.chat.sendFailedRetry).not.toBe(enLocale.chat.media.reload);
    await mount();
    sendStatuses = [409];
    mediaGetStatus = 500; // the picture also fails to load, so BOTH are on screen
    await attach();

    expect(bodyText()).toContain(enLocale.chat.sendFailedRetry);
    expect(bodyText()).toContain(enLocale.chat.media.reload);
  });

  it('a failure BEFORE the object exists still uses the composer banner', async () => {
    // The line between the two places, asserted from the other side.
    await mount();
    mediaUploadStatus = 500;
    await attach();

    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(retryButton()).toBeUndefined();
  });

  it('a SUCCESSFUL send leaves no failed row behind', async () => {
    await mount();
    await attach();

    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(requests).toContain(`POST /api/topics/${TOPIC}/chat`);
  });
});
