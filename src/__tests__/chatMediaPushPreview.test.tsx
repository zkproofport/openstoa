// @vitest-environment jsdom
/**
 * An attachment notifies people (P-1).
 *
 * A picture used to arrive as a content-free "New message" while a text message
 * arrived with its text. The reason was defensible and wrong: the push preview
 * is a TAK-sealed copy of the message BODY, an attachment's body is a JSON
 * envelope, so sending it would have put `openstoa:media:v1:{"v":1,…}` on
 * someone's lock screen. The fix was to stop sending the copy — which removed
 * the preview instead of teaching the recipient's handler to read it.
 *
 * It also did not work. The SDK's `sendMedia` goes through `sendChat`, which
 * always seals the preview, so agent-sent pictures shipped exactly the JSON
 * notification the omission existed to prevent — the guard was in two of the
 * three clients and the hole was in the one nobody was watching.
 *
 * So the envelope is sent for attachments as well, and the native handlers are
 * what refuse to render it as text (`ChatMediaEnvelope.swift`,
 * `OpenStoaPushHandler.kt`, both pinned to `chatMedia.ts` by
 * `nativeChatMediaConstants.test.ts`). This file holds the SENDER to its half:
 * the sealed copy goes out, for a first send and for a retry, and its absence
 * never sinks a message.
 *
 * These drive the REAL `ChatPanel` through a real file selection; only the
 * network and the crypto stores are doubled.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage in this file
 *   contract invocation → 'an attachment carries the sealed push copy',
 *                         'the copy is sealed from the ENVELOPE body',
 *                         'a retry carries it too', and the mini-app's
 *                         source-level twin at the bottom
 *   race / fire-and-forget → 'a preview that cannot be sealed never sinks the
 *                         send' (sealForPush rejecting AND resolving null)
 *   boundary            → takVersion 0 (the public archive root) is a real
 *                         version and must survive as 0, not be dropped
 *   empty / null        → sealForPush → null; the field is then absent, not
 *                         `null`, so the route's validator ignores it
 *   authorization / UTF-8 / very large / hostile input → N/A here: this file
 *                         asserts which fields a request carries. The envelope
 *                         parser's hostile, UTF-8 and boundary rows are covered
 *                         in `chatMedia.test.ts` and in the Swift/Kotlin vector
 *                         harnesses, and the route's validation of `pushArchive`
 *                         in `chat-route-push-archive.test.ts`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHAT_MEDIA_BODY_PREFIX, chatMediaObjectKey, parseChatMediaBody } from '@/lib/chatMedia';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { minimalPng } from '../../packages/mls/src/__tests__/imageFixtures';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TOPIC = '11111111-2222-4333-8444-555555555555';
const ME = 'nullifier-me';

const mlsStore = {
  openCached: vi.fn(async () => null),
  open: vi.fn(async () => null),
  seal: vi.fn(async (_t: string, plaintext: string) => ({ ciphertext: `ct-${plaintext}`, epoch: 0 })),
  cachePlaintext: vi.fn(async () => {}),
};

/** What `sealForPush` does this test. */
let pushSeal: 'ok' | 'null' | 'throw';

const takStore = {
  backfill: vi.fn(async () => [] as { messageId: string; plaintext: string }[]),
  myDeviceId: vi.fn(async () => 'device-1'),
  distributePublicRoot: vi.fn(async () => 0),
  distributePublicRootWhenGroupChanged: vi.fn(async () => 0),
  grantPrivateHistory: vi.fn(async () => {}),
  sealForPush: vi.fn(async (_t: string, body: string) => {
    if (pushSeal === 'throw') throw new Error('no root verified');
    if (pushSeal === 'null') return null;
    // The real one returns base64 of nonce‖AEAD(body). The body is what matters
    // here: the NSE decrypts THIS and must find the envelope.
    return { ct: `sealed(${body})`, takVersion: 0 };
  }),
  takForPush: vi.fn(async () => null),
  archiveOnSend: vi.fn(async () => {}),
  archiveRootState: vi.fn(async () => 'verified'),
  backfillMissingArchive: vi.fn(async () => 0),
  forgetUnsettledRoot: vi.fn(() => {}),
  sealMedia: vi.fn(async (_t: string, _id: string, bytes: Uint8Array) => {
    const ct = new Uint8Array(bytes.length + 1);
    ct.set(bytes, 1);
    return { ciphertext: ct, takVersion: 0 };
  }),
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

interface SentBody {
  ciphertext?: string;
  epoch?: number;
  pushArchive?: { ct: string; takVersion: number };
}

/** Every `POST /chat` body, in order — this is what the test is about. */
let sent: SentBody[];
/** Statuses `POST /chat` answers with, consumed in order (the last repeats). */
let sendStatuses: number[];

function json(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as unknown as Response;
}

function installFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url === '/api/auth/session') return json({ userId: ME });
      if (url === `/api/topics/${TOPIC}`) {
        return json({ topic: { visibility: 'public' }, currentUserRole: 'member' });
      }
      if (url.startsWith(`/api/topics/${TOPIC}/chat/media`)) {
        /*
         * BINARY on both hops, modelled as the route's REFUSALS.
         *
         * The read answers raw octets and the upload takes them, with the id in
         * the query string. A double that still accepted `{ mediaId,
         * ciphertext }` would be more permissive than the server, which answers
         * 415 to anything not framed as octets — and a lenient mock certifies a
         * broken client as working, which is this codebase's dominant way of
         * being wrong.
         */
        if (method === 'GET') {
          return {
            ok: true,
            status: 200,
            headers: new Headers({ 'content-type': 'application/octet-stream' }),
            arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
            json: async () => {
              throw new Error('the attachment read route answers octets, not JSON');
            },
          } as unknown as Response;
        }
        if (method === 'PATCH' || method === 'DELETE') return json({ ok: true });
        if (typeof init?.body === 'string') {
          throw new Error('the attachment upload takes raw bytes, not a JSON string');
        }
        const postedId = new URL(url, 'http://x').searchParams.get('mediaId');
        if (!postedId) throw new Error('the attachment upload must name its mediaId in the query string');
        return json({ key: chatMediaObjectKey(TOPIC, ME, postedId) });
      }
      if (url.startsWith(`/api/topics/${TOPIC}/chat?`)) return json({ messages: [], total: 0 });
      if (url === `/api/topics/${TOPIC}/chat`) {
        sent.push(JSON.parse(String(init?.body ?? '{}')) as SentBody);
        const status = sendStatuses.length > 1 ? sendStatuses.shift()! : sendStatuses[0];
        if (status !== 201) return json({ error: 'epoch conflict' }, false, status);
        return json({ message: { id: `m${sent.length}`, createdAt: new Date().toISOString() } }, true, 201);
      }
      return json({ error: 'not found' }, false, 404);
    }),
  );
}

let container: HTMLDivElement;
let root: Root;

async function flush(times = 10) {
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

function fileInput(): HTMLInputElement {
  const el = container.querySelector('input[type="file"]');
  if (!el) throw new Error('no file input rendered');
  return el as HTMLInputElement;
}

/** Select a file, exactly as a browser does: set `files`, dispatch `change`. */
async function attach(bytes = minimalPng()) {
  const file = new File([bytes as BlobPart], 'photo.png', { type: 'image/png' });
  const input = fileInput();
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await flush();
}

/** The one and only chat POST that carried an attachment envelope. */
function envelopeSend(): SentBody {
  const rows = sent.filter((s) => String(s.ciphertext ?? '').includes(CHAT_MEDIA_BODY_PREFIX));
  expect(rows.length, 'exactly one attachment message should have been posted').toBe(1);
  return rows[0];
}

beforeEach(() => {
  pushSeal = 'ok';
  sent = [];
  sendStatuses = [201];
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  // jsdom implements neither, and the panel scrolls itself to the newest row.
  Element.prototype.scrollIntoView = function scrollIntoView() {};
  (Element.prototype as unknown as { scrollTo: () => void }).scrollTo = function scrollTo() {};
  window.localStorage.clear();
  vi.stubGlobal('EventSource', FakeEventSource as unknown as typeof EventSource);
  vi.stubGlobal(
    'URL',
    Object.assign(globalThis.URL, { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} }),
  );
  installFetch();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  FakeEventSource.instances = [];
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('CONTRACT: an attachment ships a push preview like any other message', () => {
  it('the POST carries pushArchive', async () => {
    await mount();
    await attach();
    const body = envelopeSend();
    expect(body.pushArchive).toBeTruthy();
    expect(typeof body.pushArchive!.ct).toBe('string');
    expect(body.pushArchive!.ct.length).toBeGreaterThan(0);
  });

  it('the copy is sealed from the ENVELOPE body — the thing the NSE parses', async () => {
    await mount();
    await attach();
    // The seal input must be the message body, or the extension decrypts
    // something that is not an envelope and shows the placeholder forever.
    const sealedBodies = takStore.sealForPush.mock.calls
      .map((c) => c[1] as string)
      .filter((b) => b.startsWith(CHAT_MEDIA_BODY_PREFIX));
    expect(sealedBodies).toHaveLength(1);
    // And it must be a body the shared parser accepts, so the Swift port —
    // which is pinned to that parser — can read it.
    const envelope = parseChatMediaBody(sealedBodies[0]);
    expect(envelope).not.toBeNull();
    expect(envelope!.mime).toBe('image/png');
    expect(envelope!.key).toBe(chatMediaObjectKey(TOPIC, ME, envelope!.mediaId));
  });

  it('takVersion 0 is carried as 0 — the public archive root is a real version', async () => {
    await mount();
    await attach();
    // A falsy-check anywhere on this path would drop the root-key case, which
    // is every public topic.
    expect(envelopeSend().pushArchive!.takVersion).toBe(0);
  });

  it('a retry carries it too, so a picture that failed once still notifies', async () => {
    // First POST fails (MLS epoch CAS conflict — the real reported case), the
    // row offers Retry, and the retry is a send like any other.
    sendStatuses = [409, 201];
    await mount();
    await attach();
    const retry = Array.from(container.querySelectorAll('button')).find((b) =>
      /retry/i.test(b.textContent ?? ''),
    );
    expect(retry, 'a failed attachment should offer Retry').toBeTruthy();
    await act(async () => {
      retry!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();
    const envelopeSends = sent.filter((s) => String(s.ciphertext ?? '').includes(CHAT_MEDIA_BODY_PREFIX));
    expect(envelopeSends.length).toBeGreaterThanOrEqual(2);
    for (const s of envelopeSends) expect(s.pushArchive).toBeTruthy();
  });
});

describe('a preview that cannot be sealed never sinks the message', () => {
  it('sealForPush → null: the attachment still posts, with the field absent', async () => {
    pushSeal = 'null';
    await mount();
    await attach();
    const body = envelopeSend();
    // Absent, not `null`: the route treats a malformed value as "no preview"
    // and never 400s on it, but sending `null` would still be sending noise.
    expect(body.pushArchive ?? undefined).toBeUndefined();
    expect(body.ciphertext).toBeTruthy();
  });

  it('sealForPush throwing: the attachment still posts', async () => {
    pushSeal = 'throw';
    await mount();
    await attach();
    expect(envelopeSend().ciphertext).toBeTruthy();
  });
});

describe('the mini-app sends it too', () => {
  /*
   * Source-level, because the mini-app's ChatRoomScreen cannot be mounted in
   * this suite yet (T-1). Narrow on purpose: it names the exact expression that
   * used to withhold the preview, so it fails if that comes back and not if the
   * file is merely refactored around it.
   */
  const CHAT_ROOM = 'packages/mobile/src/screens/chat/ChatRoomScreen.tsx';
  const source = () => readFileSync(join(process.cwd(), CHAT_ROOM), 'utf8');

  it('does not withhold the push copy for an attachment', () => {
    expect(source()).not.toMatch(/media\s*\?\s*null\s*:\s*await\s+buildPushArchive/);
    expect(source()).toMatch(/const pushArchive = await buildPushArchive\(text\)/);
  });

  it('mirrors the session the extension needs to fetch the picture', () => {
    // Without this the NSE parses the envelope and then has no credential for
    // the membership-gated route: caption, no thumbnail.
    expect(source()).toMatch(/mirrorPushSessionToSharedKeychain\(/);
    expect(source()).toMatch(/pushSessionCredential\(\)/);
  });
});
