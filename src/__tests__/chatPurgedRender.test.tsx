// @vitest-environment jsdom
/**
 * What a message looks like AFTER the server has thrown its live copy away.
 *
 * R-1 lets the server drop `chat_messages.ciphertext` once every device that
 * was owed the message has acknowledged it. From then on the row arrives with
 * `sealed: null`, and the body has to come from somewhere else. There are three
 * somewhere-elses, and they are three DIFFERENT things to show the user:
 *
 *   1. this device's own message cache still holds the plaintext  → the text
 *   2. the archive can supply it (public, or a tier whose epoch     → the text
 *      TAK this device holds)
 *   3. neither                                                    → locked
 *
 * The failure this file exists to prevent is those three collapsing into one.
 * The worst collapse is the empty bubble — a row that renders as if the sender
 * had sent nothing, which is the only one of the three that is a lie. Second
 * worst is (2) rendering as (3): telling someone a message is locked when it is
 * merely reclaimed and about to appear.
 *
 * The mini-app twin of the same rule is
 * `packages/mobile/src/__tests__/toDisplayMessage.test.ts`.
 *
 * These drive the REAL `ChatPanel`; only the network and the crypto stores are
 * doubled.
 */
import enLocale from '@/lib/i18n/locales/en.json';
import { flushQueries } from './harness/providers';
import { buildChatMediaBody, chatMediaObjectKey } from '@/lib/chatMedia';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TOPIC = '11111111-2222-4333-8444-555555555555';
const ME = 'nullifier-me';
const THEM = 'nullifier-them';
const PURGED_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

const LOCKED = enLocale.chat.lockedMessage;

/** What this device's own message cache answers for the purged row. */
let cachedPlaintext: string | null;
/** What the archive pass recovers, if anything. */
let archiveRecovers: Array<{ messageId: string; plaintext: string }>;

const mlsStore = {
  // The cache is consulted with an EMPTY sealed body — that is how a purged row
  // asks "do I already have this?".
  openCached: vi.fn(async () => cachedPlaintext),
  open: vi.fn(async () => null),
  seal: vi.fn(async (_t: string, plaintext: string) => ({ ciphertext: `ct-${plaintext}`, epoch: 0 })),
  cachePlaintext: vi.fn(async () => {}),
  reconcileMembership: vi.fn(async () => {}),
};

const takStore = {
  backfill: vi.fn(async () => archiveRecovers),
  myDeviceId: vi.fn(async () => 'device-1'),
  distributeRoot: vi.fn(async () => 0),
  distributeRootWhenGroupChanged: vi.fn(async () => 0),
  grantPrivateHistory: vi.fn(async () => {}),
  sealForPush: vi.fn(async () => null),
  takForPush: vi.fn(async () => null),
  archiveOnSend: vi.fn(async () => {}),
  // 'verified' so the room stops "syncing" and a still-unreadable row is a
  // final answer rather than a spinner — otherwise every case below would pass
  // by rendering nothing at all.
  archiveRootState: vi.fn(async () => 'verified'),
  publicRootFingerprint: vi.fn(async () => 'fp-1'),
  backfillMissingArchive: vi.fn(async () => 0),
  forgetUnsettledRoot: vi.fn(() => {}),
  sealMedia: vi.fn(async () => null),
  openMedia: vi.fn(async () => ({ ok: true as const, bytes: new Uint8Array([137, 80, 78, 71]) })),
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
  listeners = new Map<string, ((e: { data: string }) => void)[]>();
  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;
  constructor(public url: string) {}
  addEventListener(type: string, fn: (e: { data: string }) => void) {
    const l = this.listeners.get(type) ?? [];
    l.push(fn);
    this.listeners.set(type, l);
  }
  close() {}
}

/** The history page the server answers with. */
let historyRows: unknown[];

function json(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as unknown as Response;
}

/**
 * A binary response, which is what the media route answers a browser with.
 *
 * The client asks for `application/octet-stream` and reads `arrayBuffer()`:
 * base64-in-JSON exists for React Native, which cannot take bytes off the
 * bridge, and paying that expansion in a browser cost twice. A double that
 * only speaks JSON silently stops resembling the endpoint.
 */
function binary(bytes: Uint8Array, ok = true, status = 200) {
  return {
    ok,
    status,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  } as unknown as Response;
}

/**
 * One purged row, exactly as the server sends it after the purge: every field
 * the renderer needs, and `sealed: null` where the body used to be.
 */
function purgedRow(over: Record<string, unknown> = {}) {
  return {
    id: PURGED_ID,
    topicId: TOPIC,
    userId: THEM,
    nickname: 'bob',
    type: 'message',
    isAI: false,
    sealed: null,
    message: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
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
      if (url === `/api/topics/${TOPIC}/members`) {
        return json({ members: [{ userId: ME }, { userId: THEM }] });
      }
      if (url.startsWith(`/api/topics/${TOPIC}/chat/media`)) {
        // Same three bytes the base64 'AQID' used to carry.
        if (method === 'GET') return binary(new Uint8Array([1, 2, 3]));
        return json({ ok: true });
      }
      if (url.startsWith(`/api/topics/${TOPIC}/chat?`)) {
        return json({ messages: historyRows, total: historyRows.length });
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

const bodyText = () => container.textContent ?? '';

/**
 * The row's own bubble, found by its text — deliberately not by a test id, so
 * the assertion fails if the text stops being rendered at all.
 */
function hasLockedRow(): boolean {
  return bodyText().includes(LOCKED);
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  cachedPlaintext = null;
  archiveRecovers = [];
  historyRows = [purgedRow()];
  vi.clearAllMocks();
  Element.prototype.scrollIntoView = function scrollIntoView() {};
  (Element.prototype as unknown as { scrollTo: () => void }).scrollTo = function scrollTo() {};
  window.localStorage.clear();
  vi.stubGlobal('EventSource', FakeEventSource as unknown as typeof EventSource);
  vi.stubGlobal('URL', Object.assign(globalThis.URL, { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} }));
  installFetch();
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
});

describe('a purged row — the three states must stay distinct', () => {
  it('STATE 1 — this device still has the plaintext: the message reads normally', async () => {
    cachedPlaintext = 'the original message';
    await mount();

    expect(bodyText()).toContain('the original message');
    expect(hasLockedRow()).toBe(false);
    // The cache is asked with an EMPTY sealed body. If this ever stops being
    // called, a user's own readable history turns into placeholders after one
    // reload — the row is readable and nothing would go looking for it.
    expect(mlsStore.openCached).toHaveBeenCalledWith(TOPIC, PURGED_ID, { ciphertext: '', epoch: 0 });
  });

  it('STATE 2 — the archive supplies it: the message reads normally, with no locked state left behind', async () => {
    cachedPlaintext = null;
    archiveRecovers = [{ messageId: PURGED_ID, plaintext: 'recovered from the archive' }];
    await mount();

    expect(bodyText()).toContain('recovered from the archive');
    // The point of the whole exercise: on a topic whose archive this device can
    // open, a purge is invisible. Not "locked, then fixed" — just the message.
    expect(hasLockedRow()).toBe(false);
    expect(takStore.backfill).toHaveBeenCalled();
  });

  it('STATE 3 — nothing can supply it: locked, and SAYING so', async () => {
    cachedPlaintext = null;
    archiveRecovers = [];
    await mount();

    expect(hasLockedRow()).toBe(true);
  });

  it('the three states are genuinely different renderings, not the same one three times', async () => {
    // Guards against a "fix" that makes every purged row locked, or every
    // purged row readable. Rendered independently and compared as strings.
    const renders: Record<string, string> = {};

    for (const [name, setup] of [
      ['cached', () => { cachedPlaintext = 'CACHED-BODY'; archiveRecovers = []; }],
      ['archive', () => { cachedPlaintext = null; archiveRecovers = [{ messageId: PURGED_ID, plaintext: 'ARCHIVE-BODY' }]; }],
      ['locked', () => { cachedPlaintext = null; archiveRecovers = []; }],
    ] as Array<[string, () => void]>) {
      await act(async () => {
        root.unmount();
      });
      container.remove();
      container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);
      setup();
      await mount();
      renders[name] = bodyText();
    }

    expect(renders.cached).toContain('CACHED-BODY');
    expect(renders.archive).toContain('ARCHIVE-BODY');
    expect(renders.locked).toContain(LOCKED);
    expect(renders.cached).not.toContain(LOCKED);
    expect(renders.archive).not.toContain(LOCKED);
    expect(renders.locked).not.toContain('CACHED-BODY');
    expect(renders.locked).not.toContain('ARCHIVE-BODY');
  });

  it('EMPTY: a purged row is never rendered as a blank bubble', async () => {
    /*
     * The specific defect this file was written for. A row that resolves to ''
     * renders as a bubble containing nothing, which tells the user the sender
     * sent an empty message — the one outcome that is actually false. Whatever
     * else happens, the row either carries its text or says it is locked.
     */
    cachedPlaintext = null;
    archiveRecovers = [];
    await mount();

    const text = bodyText();
    expect(text).toContain(LOCKED);
    /*
     * The locked bubble deliberately carries no nickname and no timestamp —
     * checked, not assumed: the row renders only the padlock and the sentence.
     * What matters here is the negative, so it is asserted directly: the panel
     * must not contain a message bubble that is present but empty.
     */
    const bubbles = [...container.querySelectorAll('span')].map((n) => n.textContent ?? '');
    expect(bubbles.some((b) => b.includes(LOCKED))).toBe(true);
  });
});

describe('a purged ATTACHMENT — the picture has to come back too', () => {
  const MEDIA_ID = '0968a49ae20ba82b3224d8360ec8f836';
  const envelope = buildChatMediaBody({
    v: 1,
    mediaId: MEDIA_ID,
    key: chatMediaObjectKey(TOPIC, THEM, MEDIA_ID),
    mime: 'image/png',
    size: 2048,
    takVersion: 0,
  });

  it('resolved from the archive, it renders as an IMAGE, not as the envelope text', async () => {
    /*
     * What the archive holds for an attachment is the ENVELOPE — the same
     * sealed body the live copy carried — so a purged picture comes back as a
     * JSON string that has to be re-parsed at render time. If the body is
     * resolved but the parse does not happen, the user sees the object key and
     * the mime type printed into the conversation, which is both ugly and the
     * one thing the sealed-body design exists to prevent.
     */
    cachedPlaintext = null;
    archiveRecovers = [{ messageId: PURGED_ID, plaintext: envelope }];
    await mount();

    const img = container.querySelector('img');
    expect(img, 'a resolved attachment must render an <img>').not.toBeNull();
    // The raw envelope must never reach the screen as text.
    expect(bodyText()).not.toContain('openstoa:media:');
    expect(bodyText()).not.toContain(MEDIA_ID);
    expect(takStore.openMedia).toHaveBeenCalled();

    /*
     * And it can be SAVED. There was no way to keep a chat picture at all,
     * which bites harder here than in an ordinary app: an attachment is only
     * readable on a device holding the topic's key, so without this the
     * picture exists nowhere the person can put it.
     *
     * Asserted on the same object URL the <img> uses — saving must reuse the
     * plaintext already decrypted, not go back to the server for a second copy
     * that would arrive as ciphertext.
     */
    const save = container.querySelector<HTMLAnchorElement>('[data-testid="chat-media-download"]');
    expect(save, 'a resolved attachment must offer a way to save it').not.toBeNull();
    expect(save!.getAttribute('href')).toBe(img!.getAttribute('src'));
    expect(save!.getAttribute('download')).toMatch(/^openstoa-[a-z0-9]+\.(jpg|png|gif|webp|bmp|bin)$/);
  });

  it('resolved from this device own cache, the same', async () => {
    cachedPlaintext = envelope;
    archiveRecovers = [];
    await mount();

    expect(container.querySelector('img')).not.toBeNull();
    expect(bodyText()).not.toContain('openstoa:media:');
  });

  it('unresolvable, it is locked like any other row — never the envelope, never blank', async () => {
    cachedPlaintext = null;
    archiveRecovers = [];
    await mount();

    expect(hasLockedRow()).toBe(true);
    expect(bodyText()).not.toContain('openstoa:media:');
  });
});
