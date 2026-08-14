// @vitest-environment jsdom
/**
 * ChatPanel — SSE reconnect catch-up (`?since=`) and history paging (`?before=`).
 *
 * The MLS hazard is simulated faithfully: the fake session store hands back a
 * plaintext the FIRST time a message id is opened and `null` (the real
 * forward-secrecy behaviour — the per-message key is consumed) on every later
 * attempt. So any regression that decrypts a message twice does not merely look
 * wasteful here, it renders the locked placeholder and fails the assertion.
 * The raw '[unable to decrypt]' sentinel is gone entirely — it is a boolean
 * flag now (ChatMessage.undecryptable), never user-facing text.
 *
 * Edge-case matrix rows covered here:
 *   boundary    — reconnect with 0 / 1 / many missed messages
 *   dedupe/race — a message delivered by BOTH catch-up and SSE appears once and
 *                 decrypts once; rapid disconnect/reconnect cycles
 *   first-open  — the initial subscription must NOT issue a catch-up request
 *   pagination  — <50-message topic shows no control; a full page shows one;
 *                 paging to the beginning hides it again with no duplicates
 *   failure     — an undecryptable message degrades to ONE row and leaves its
 *                 siblings readable
 *   own message — the sender's own echo never reaches the decrypt path
 *   scroll      — prepending older messages does not steal the scroll position;
 *                 a new bottom message does
 *   authz       — guests / non-members issue no chat request at all
 */
import enLocale from '@/lib/i18n/locales/en.json';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TOPIC = '11111111-2222-4333-8444-555555555555';
const ME = 'nullifier-me';

// ─── MLS / TAK doubles ───────────────────────────────────────────────────────

/** Message ids whose key has already been consumed by a decrypt. */
let consumed: Set<string>;
/** Every openCached call, in order — the double-decrypt detector. */
let decryptCalls: string[];
/** Ciphertexts the test wants to be undecryptable from the very first attempt. */
let undecryptable: Set<string>;

const mlsStore = {
  openCached: vi.fn(async (_topicId: string, msgId: string, sealed: { ciphertext: string }) => {
    decryptCalls.push(msgId);
    if (undecryptable.has(sealed.ciphertext)) return null;
    if (consumed.has(msgId)) return null; // MLS key already spent — forward secrecy
    consumed.add(msgId);
    return `plain(${sealed.ciphertext})`;
  }),
  open: vi.fn(async (_t: string, sealed: { ciphertext: string }) => `plain(${sealed.ciphertext})`),
  seal: vi.fn(async (_t: string, plaintext: string) => ({
    ciphertext: `ct-own-${plaintext}`,
    epoch: 0,
  })),
  cachePlaintext: vi.fn(async () => {}),
};

const takStore = {
  backfill: vi.fn(async () => [] as { messageId: string; plaintext: string }[]),
  myDeviceId: vi.fn(async () => 'device-1'),
  distributePublicRoot: vi.fn(async () => 0),
  grantPrivateHistory: vi.fn(async () => {}),
  sealForPush: vi.fn(async () => null),
  archiveOnSend: vi.fn(async () => {}),
};

vi.mock('@/lib/mls/webTransport', () => ({
  getMlsSessionStore: () => mlsStore,
  getTakSessionStore: () => takStore,
  // 'ready' keeps the locked-history notice out of these tests: they are about
  // the decrypt path itself, not the recovery affordance (see lockedHistory.test.tsx).
  getDeviceKeyState: async () => 'ready',
  recoverDeviceWithPasskey: async () => true,
}));

// Imported AFTER the mock so the component picks up the doubles.
const { default: ChatPanel } = await import('@/components/ChatPanel');
const { I18nProvider } = await import('@/lib/i18n/I18nProvider');

// ─── EventSource double ──────────────────────────────────────────────────────

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  listeners = new Map<string, ((e: { data: string }) => void)[]>();
  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;
  closed = false;

  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (e: { data: string }) => void) {
    const l = this.listeners.get(type) ?? [];
    l.push(fn);
    this.listeners.set(type, l);
  }
  close() {
    this.closed = true;
  }
  /** Server pushed an event. */
  emit(type: string, data: unknown) {
    for (const fn of this.listeners.get(type) ?? []) fn({ data: JSON.stringify(data) });
  }
  /** Stream became live. */
  open() {
    this.onopen?.();
  }
  /** Transport dropped. */
  fail() {
    this.onerror?.();
  }
  static get last(): FakeEventSource {
    return FakeEventSource.instances[FakeEventSource.instances.length - 1];
  }
}

// ─── HTTP double ─────────────────────────────────────────────────────────────

interface WireMessage {
  id: string;
  topicId: string;
  userId: string;
  nickname: string;
  type: 'message' | 'join' | 'leave';
  createdAt: string;
  message: string | null;
  sealed: { ciphertext: string; epoch: number } | null;
}

function wire(n: number, over: Partial<WireMessage> = {}): WireMessage {
  const id = over.id ?? `m${n}`;
  return {
    id,
    topicId: TOPIC,
    userId: 'nullifier-other',
    nickname: 'alice',
    type: 'message',
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString(),
    message: null,
    sealed: { ciphertext: `ct-${id}`, epoch: 0 },
    ...over,
  };
}

/** Requests the component issued, in order. */
let requests: string[];
/** Bodies of the POSTs it issued — the delivery ack is asserted on these. */
let postBodies: Array<{ url: string; body: string }> = [];
/** Newest-first history page returned for the initial `?limit=50` fetch. */
let historyPage: WireMessage[];
/** Queue of `?before=` pages (newest-first each), consumed in order. */
let beforePages: WireMessage[][];
/** Queue of `?since=` pages (chronological each), consumed in order. */
let sincePages: WireMessage[][];
/** Payload the POST /chat endpoint echoes back. */
let sendResponse: WireMessage | null;
/**
 * Held open to make the SSE echo beat the POST response.
 *
 * That order is not exotic — the server fans out to the stream from inside the
 * request handler, so the echo can reach an already-open EventSource before
 * `fetch` resolves in the sender's tab. It is also the order that produced a
 * duplicate bubble in front of users.
 */
let sendGate: { promise: Promise<void>; release: () => void } | null;

function json(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as unknown as Response;
}

function installFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push(url);
      if (typeof init?.body === 'string') postBodies.push({ url, body: init.body });
      if (url === '/api/auth/session') return json({ userId: ME });
      if (url === `/api/topics/${TOPIC}`) {
        return json({ topic: { visibility: 'public' }, currentUserRole: 'member' });
      }
      if (url.startsWith(`/api/topics/${TOPIC}/chat?`)) {
        if (url.includes('since=')) return json({ messages: sincePages.shift() ?? [], total: 0 });
        if (url.includes('before=')) return json({ messages: beforePages.shift() ?? [], total: 0 });
        return json({ messages: historyPage, total: historyPage.length });
      }
      if (url === `/api/topics/${TOPIC}/chat`) {
        if (sendGate) await sendGate.promise;
        return json({ message: sendResponse }, true, 201);
      }
      if (url === `/api/topics/${TOPIC}/chat/delivered`) {
        return json({ deliveredThrough: new Date().toISOString() });
      }
      // tak/holder, push prefs, OG previews … — nothing the panel depends on.
      return json({ error: 'not found' }, false, 404);
    }),
  );
}

// ─── Harness ─────────────────────────────────────────────────────────────────

let container: HTMLDivElement;
let root: Root;
let scrollCalls: number;

async function flush(times = 6) {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

// `ChatPanel` (and the `TopicMuteToggle` it renders internally) now read
// copy through `useTranslation()` — see src/lib/i18n/I18nProvider.tsx. Every
// render needs the provider in the tree, same as the app root
// (src/app/layout.tsx).
async function mount(props: Partial<React.ComponentProps<typeof ChatPanel>> = {}) {
  await act(async () => {
    root.render(
      <I18nProvider initialLocale="en">
        <ChatPanel topicId={TOPIC} isGuest={false} isMember={true} {...props} />
      </I18nProvider>,
    );
  });
  await flush();
}

function bodyText(): string {
  return container.textContent ?? '';
}

function loadOlderButton(): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find((b) =>
    /Load earlier messages|Loading/.test(b.textContent ?? ''),
  ) as HTMLButtonElement | undefined;
}

/** POSTs to the send endpoint — the URL has no query string. */
function sendRequests(): string[] {
  return requests.filter((u) => u === `/api/topics/${TOPIC}/chat`);
}

function chatRequests(kind: 'since' | 'before' | 'history'): string[] {
  return requests.filter((u) => {
    if (!u.startsWith(`/api/topics/${TOPIC}/chat?`)) return false;
    if (kind === 'since') return u.includes('since=');
    if (kind === 'before') return u.includes('before=');
    return !u.includes('since=') && !u.includes('before=');
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  consumed = new Set();
  decryptCalls = [];
  undecryptable = new Set();
  requests = [];
  postBodies = [];
  historyPage = [];
  beforePages = [];
  sincePages = [];
  sendResponse = null;
  sendGate = null;
  FakeEventSource.instances = [];
  scrollCalls = 0;
  vi.clearAllMocks();
  // jsdom has no layout engine; record the calls instead. `scrollTo` is what
  // `ChatPanel`'s `scrollToBottom` actually calls on `scrollerRef` (see its
  // doc comment there); `scrollIntoView` is kept polyfilled too in case any
  // other code path still reaches for it — neither exists on jsdom's
  // `Element` by default, so an unstubbed call throws `TypeError: ... is not
  // a function` from inside a `useEffect`, which crashes the whole render.
  Element.prototype.scrollIntoView = function scrollIntoView() {
    scrollCalls++;
  };
  Element.prototype.scrollTo = function scrollTo() {
    scrollCalls++;
  };
  vi.stubGlobal('EventSource', FakeEventSource as unknown as typeof EventSource);
  installFetch();
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ─── Gap A: SSE reconnect catch-up ───────────────────────────────────────────

describe('ChatPanel — SSE reconnect catch-up', () => {
  it('does NOT issue a catch-up request on the FIRST stream open', async () => {
    historyPage = [wire(2), wire(1)];
    await mount();
    await act(async () => {
      FakeEventSource.last.open();
    });
    await flush();
    expect(chatRequests('since')).toHaveLength(0);
  });

  it('reconnect with 0 missed messages: one catch-up request, list unchanged', async () => {
    historyPage = [wire(2), wire(1)];
    sincePages = [[]];
    await mount();
    await act(async () => FakeEventSource.last.open());
    await flush();

    await act(async () => FakeEventSource.last.fail());
    await act(async () => FakeEventSource.last.open());
    await flush();

    expect(chatRequests('since')).toHaveLength(1);
    expect(bodyText()).toContain('plain(ct-m1)');
    expect(bodyText()).toContain('plain(ct-m2)');
    expect(decryptCalls.sort()).toEqual(['m1', 'm2']);
  });

  it('reconnect with 1 missed message: it appears without a reload', async () => {
    historyPage = [wire(1)];
    sincePages = [[wire(2)]];
    await mount();
    await act(async () => FakeEventSource.last.open());
    await flush();
    expect(bodyText()).not.toContain('plain(ct-m2)');

    await act(async () => FakeEventSource.last.fail());
    await act(async () => FakeEventSource.last.open());
    await flush();

    expect(bodyText()).toContain('plain(ct-m2)');
    // Cursor is derived from what we hold, and rewound by the overlap window.
    const req = chatRequests('since')[0];
    expect(req).toContain('limit=500');
    expect(decodeURIComponent(req.split('since=')[1])).toBe(
      new Date(Date.parse(wire(1).createdAt) - 1000).toISOString(),
    );
  });

  it('reconnect with many missed messages: all of them arrive, each decrypted once', async () => {
    historyPage = [wire(1)];
    sincePages = [[wire(2), wire(3), wire(4)]];
    await mount();
    await act(async () => FakeEventSource.last.open());
    await flush();

    await act(async () => FakeEventSource.last.fail());
    await act(async () => FakeEventSource.last.open());
    await flush();

    for (const n of [1, 2, 3, 4]) expect(bodyText()).toContain(`plain(ct-m${n})`);
    expect(decryptCalls.sort()).toEqual(['m1', 'm2', 'm3', 'm4']);
  });

  it('a message delivered by BOTH catch-up and SSE renders once and decrypts once', async () => {
    historyPage = [wire(1)];
    sincePages = [[wire(2)]];
    await mount();
    await act(async () => FakeEventSource.last.open());
    await flush();

    await act(async () => FakeEventSource.last.fail());
    const es = FakeEventSource.last;
    // Catch-up and the live stream race on the same message.
    await act(async () => {
      es.open();
      es.emit('message', wire(2));
    });
    await flush();

    expect(decryptCalls.filter((id) => id === 'm2')).toHaveLength(1);
    expect(bodyText()).not.toContain(enLocale.chat.lockedMessage);
    const rendered = bodyText().split('plain(ct-m2)').length - 1;
    expect(rendered).toBe(1);
  });

  it('rapid disconnect/reconnect cycles do not duplicate or re-decrypt anything', async () => {
    historyPage = [wire(1)];
    sincePages = [[wire(2)], [wire(2)], [wire(2)]];
    await mount();
    await act(async () => FakeEventSource.last.open());
    await flush();

    for (let i = 0; i < 3; i++) {
      await act(async () => FakeEventSource.last.fail());
      await act(async () => FakeEventSource.last.open());
      await flush();
    }

    expect(decryptCalls.filter((id) => id === 'm2')).toHaveLength(1);
    expect(bodyText().split('plain(ct-m2)').length - 1).toBe(1);
    expect(bodyText()).not.toContain(enLocale.chat.lockedMessage);
  });

  it('a failing catch-up request is swallowed — chat keeps working and retries later', async () => {
    historyPage = [wire(1)];
    // First reconnect 404s (the default branch), second returns the message.
    sincePages = [];
    await mount();
    await act(async () => FakeEventSource.last.open());
    await flush();

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        requests.push(String(input));
        return json({ error: 'boom' }, false, 500);
      }),
    );
    await act(async () => FakeEventSource.last.fail());
    await act(async () => FakeEventSource.last.open());
    await flush();
    expect(bodyText()).toContain('plain(ct-m1)');

    installFetch();
    sincePages = [[wire(2)]];
    await act(async () => FakeEventSource.last.fail());
    await act(async () => FakeEventSource.last.open());
    await flush();
    expect(bodyText()).toContain('plain(ct-m2)');
  });
});

// ─── Gap B: history pagination ───────────────────────────────────────────────

describe('ChatPanel — history pagination', () => {
  const fullPage = (from: number) =>
    Array.from({ length: 50 }, (_, i) => wire(from - i)); // newest-first

  it('a topic with fewer than 50 messages offers no paging control', async () => {
    historyPage = [wire(3), wire(2), wire(1)];
    await mount();
    expect(loadOlderButton()).toBeUndefined();
    expect(chatRequests('before')).toHaveLength(0);
  });

  it('a full first page offers the control and pages backwards on click', async () => {
    historyPage = fullPage(100);
    beforePages = [[wire(50), wire(49)]];
    await mount();

    const btn = loadOlderButton();
    expect(btn).toBeDefined();
    await act(async () => {
      btn!.click();
    });
    await flush();

    // Cursor is the OLDEST row on screen (id-based, so concurrent inserts
    // cannot shift the window).
    expect(chatRequests('before')[0]).toContain(`before=${wire(51).id}`);
    expect(bodyText()).toContain('plain(ct-m49)');
    // Short page ⇒ beginning of the topic reached ⇒ control disappears.
    expect(loadOlderButton()).toBeUndefined();
  });

  it('paging to the very beginning stops: no infinite spinner, no repeat request', async () => {
    historyPage = fullPage(100);
    beforePages = [[]]; // already at the beginning
    await mount();

    await act(async () => loadOlderButton()!.click());
    await flush();

    expect(loadOlderButton()).toBeUndefined();
    expect(chatRequests('before')).toHaveLength(1);
  });

  it('clicking twice in a row does not fetch the same page twice or duplicate rows', async () => {
    historyPage = fullPage(100);
    beforePages = [[wire(50), wire(49)], [wire(48)]];
    await mount();

    const btn = loadOlderButton()!;
    await act(async () => {
      btn.click();
      btn.click();
    });
    await flush();

    expect(chatRequests('before')).toHaveLength(1);
    expect(bodyText().split('plain(ct-m49)').length - 1).toBe(1);
    expect(decryptCalls.filter((id) => id === 'm49')).toHaveLength(1);
  });

  it('older pages prepend without stealing the scroll position; a new message does scroll', async () => {
    historyPage = fullPage(100);
    beforePages = [[wire(50), wire(49)]];
    await mount();
    const afterInitial = scrollCalls;

    await act(async () => loadOlderButton()!.click());
    await flush();
    // Prepending must not auto-scroll — the reader stays where they were.
    expect(scrollCalls).toBe(afterInitial);

    await act(async () => {
      FakeEventSource.last.open();
      FakeEventSource.last.emit('message', wire(101));
    });
    await flush();
    // A new message at the bottom does scroll.
    expect(scrollCalls).toBeGreaterThan(afterInitial);
  });

  it('an older page decrypts each message exactly once, even one already on screen', async () => {
    historyPage = fullPage(100);
    // The server repeats a row the client already holds (cursor tie).
    beforePages = [[wire(51), wire(50)]];
    await mount();

    await act(async () => loadOlderButton()!.click());
    await flush();

    expect(decryptCalls.filter((id) => id === 'm51')).toHaveLength(1);
    expect(bodyText()).not.toContain(enLocale.chat.lockedMessage);
  });
});

// ─── Failure & identity paths ────────────────────────────────────────────────

describe('ChatPanel — decrypt failures and own messages', () => {
  it('an undecryptable message becomes ONE placeholder row and leaves siblings readable', async () => {
    historyPage = [wire(3), wire(2), wire(1)];
    undecryptable.add('ct-m2');
    await mount();

    expect(bodyText()).toContain('plain(ct-m1)');
    expect(bodyText()).toContain('plain(ct-m3)');
    expect(bodyText().split(enLocale.chat.lockedMessage).length - 1).toBe(1);
  });

  it('a decrypt that THROWS still degrades to one row instead of blanking the page', async () => {
    historyPage = [wire(2), wire(1)];
    mlsStore.openCached.mockImplementationOnce(async () => {
      throw new Error('key store unreadable');
    });
    await mount();

    expect(bodyText()).toContain(enLocale.chat.lockedMessage);
    // The sibling still rendered — Promise.all did not reject the whole page.
    expect(bodyText()).toMatch(/plain\(ct-m[12]\)/);
  });

  it("the sender's own message is never sent through the decrypt path", async () => {
    historyPage = [];
    sendResponse = wire(5, { id: 'own1', userId: ME, nickname: 'me' });
    await mount();
    await act(async () => FakeEventSource.last.open());
    await flush();

    const input = container.querySelector('input[type="text"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )!.set!;
    await act(async () => {
      setter.call(input, 'my own words');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // The send control is an icon button — its name lives in `aria-label`, so
    // the composer's width no longer depends on the locale's word for "send"
    // (see chatE2eeBanner.test.tsx).
    const send = container.querySelector(
      `button[aria-label="${enLocale.chat.send}"]`,
    ) as HTMLButtonElement;
    await act(async () => {
      send.click();
    });
    await flush();

    // The SSE echo of our own message arrives with the same id.
    await act(async () => {
      FakeEventSource.last.emit('message', sendResponse);
    });
    await flush();

    expect(decryptCalls).not.toContain('own1');
    expect(bodyText().split('my own words').length - 1).toBe(1);
    expect(bodyText()).not.toContain(enLocale.chat.lockedMessage);
  });

  it('REGRESSION: the echo beating the POST response leaves ONE bubble, not two', async () => {
    /*
     * The provisional row and the server row used to be reconciled only in the
     * POST-response handler, keyed on the provisional id. The SSE echo took a
     * different path that knew nothing about the provisional row, so when it
     * arrived first the same message was on screen twice until the response
     * caught up — visible, and reported.
     *
     * The two paths share exactly one value before the id exists: the
     * ciphertext this tab sealed. That is what they are matched on now.
     */
    historyPage = [];
    let release!: () => void;
    const promise = new Promise<void>((r) => {
      release = r;
    });
    sendGate = { promise, release };
    sendResponse = wire(9, {
      id: 'srv-1',
      userId: ME,
      nickname: 'me',
      sealed: { ciphertext: 'ct-own-hello', epoch: 0 },
    });

    await mount();
    await act(async () => FakeEventSource.last.open());
    await flush();

    const input = container.querySelector('input[type="text"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(input, 'hello');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const send = container.querySelector(`button[aria-label="${enLocale.chat.send}"]`) as HTMLButtonElement;
    await act(async () => {
      send.click();
    });
    await flush();

    // The echo lands while the POST is still in flight.
    await act(async () => {
      FakeEventSource.last.emit('message', sendResponse);
    });
    await flush();
    expect(bodyText().split('hello').length - 1).toBe(1);

    // …and the response, arriving second, must not add another.
    await act(async () => {
      release();
    });
    await flush();
    expect(bodyText().split('hello').length - 1).toBe(1);
  });

  it('REGRESSION: Enter that COMMITS a Korean composition is not a send', async () => {
    /*
     * Typing Korean leaves the last syllable in the IME buffer, and Enter first
     * commits it: the browser fires keydown with `isComposing` set, then fires
     * a SECOND Enter once the commit lands. Treating both as sends made every
     * Korean message arrive as two — the real one, then a single stray letter,
     * because the composer had been emptied and the IME wrote the committed
     * jamo back into it. Reported from the app: "ㅇㅁㄹㅇ" arrived as "ㅇㅁㄹㅇ"
     * and "ㅇ".
     */
    historyPage = [];
    sendResponse = wire(11, { id: 'srv-ko', userId: ME, nickname: 'me' });
    await mount();
    await act(async () => FakeEventSource.last.open());
    await flush();

    const input = container.querySelector('input[type="text"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(input, 'ㅇㅁㄹㅇ');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const enter = (isComposing: boolean) =>
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing }),
      );

    await act(async () => void enter(true));
    await flush();
    expect(sendRequests()).toHaveLength(0);

    // The second Enter, after the commit, is the real one.
    await act(async () => void enter(false));
    await flush();
    expect(sendRequests()).toHaveLength(1);
  });

  it('a guest issues no chat request at all', async () => {
    await mount({ isGuest: true, isMember: false });
    expect(chatRequests('history')).toHaveLength(0);
    expect(FakeEventSource.instances).toHaveLength(0);
    expect(bodyText()).toContain('Join this topic to view chat');
  });

  it('a non-member issues no chat request at all', async () => {
    await mount({ isGuest: false, isMember: false });
    expect(chatRequests('history')).toHaveLength(0);
    expect(FakeEventSource.instances).toHaveLength(0);
  });
});

/**
 * The delivery cursor (R-1). The server keeps a message's live ciphertext only
 * until every device that was in the group at send time has fetched it, so the
 * panel has to say what it now holds — and has to render the rows whose live
 * copy is already gone.
 *
 * Edge-case matrix rows: contract (every arrival path acks) · integrity (the
 * NEWEST instant, and never a rewind on an older page) · boundary (an empty
 * page acks nothing) · ext-failure (a refused ack leaves the history on screen)
 * · empty (a purged row consults the local cache before claiming to be locked).
 */
describe('delivery acknowledgement and purged rows', () => {
  function acks(): Array<{ deviceId: string; through: string }> {
    return postBodies
      .filter((r) => r.url === `/api/topics/${TOPIC}/chat/delivered`)
      .map((r) => JSON.parse(r.body));
  }

  it('CONTRACT: the initial history load acks the newest row for this device', async () => {
    historyPage = [wire(3), wire(2), wire(1)]; // newest-first, as the server sends
    await mount();

    const sent = acks();
    expect(sent.length).toBeGreaterThan(0);
    expect(sent[sent.length - 1].deviceId).toBe('device-1');
    expect(sent[sent.length - 1].through).toBe(wire(3).createdAt);
  });

  it('CONTRACT: a message arriving over SSE is acked too', async () => {
    historyPage = [];
    await mount();
    const before = acks().length;

    await act(async () => {
      FakeEventSource.last.open();
      FakeEventSource.last.emit('message', wire(9));
    });
    await flush();

    const sent = acks();
    expect(sent.length).toBeGreaterThan(before);
    expect(sent[sent.length - 1].through).toBe(wire(9).createdAt);
  });

  it('INTEGRITY: an older history page never rewinds the mark', async () => {
    // `?before=` pages are older by construction. Acking their newest row would
    // move the server's high-water mark BACKWARDS and re-block messages this
    // device has already taken delivery of.
    historyPage = Array.from({ length: 50 }, (_, i) => wire(100 - i));
    await mount();
    const newestSoFar = acks()[acks().length - 1].through;

    beforePages = [[wire(20), wire(19)]];
    await act(async () => void loadOlderButton()?.click());
    await flush();

    for (const a of acks()) {
      expect(new Date(a.through).getTime()).toBeLessThanOrEqual(new Date(newestSoFar).getTime());
    }
  });

  it('BOUNDARY: an empty topic acks nothing', async () => {
    historyPage = [];
    await mount();
    expect(acks()).toHaveLength(0);
  });

  it('EXT-FAILURE: a refused ack leaves the history on screen', async () => {
    // The rows are already rendered by then; a failed acknowledgement costs
    // some server storage and must cost nothing else.
    historyPage = [wire(1)];
    const original = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith('/chat/delivered')) throw new Error('offline');
        return (original as typeof fetch)(input, init);
      }),
    );
    await mount();
    expect(bodyText()).toContain('plain(ct-m1)');
  });


  it("the sender's own message is never sent through the decrypt path", async () => {
    historyPage = [];
    sendResponse = wire(5, { id: 'own1', userId: ME, nickname: 'me' });
    await mount();
    await act(async () => FakeEventSource.last.open());
    await flush();

    const input = container.querySelector('input[type="text"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )!.set!;
    await act(async () => {
      setter.call(input, 'my own words');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // The send control is an icon button — its name lives in `aria-label`, so
    // the composer's width no longer depends on the locale's word for "send"
    // (see chatE2eeBanner.test.tsx).
    const send = container.querySelector(
      `button[aria-label="${enLocale.chat.send}"]`,
    ) as HTMLButtonElement;
    await act(async () => {
      send.click();
    });
    await flush();

    // The SSE echo of our own message arrives with the same id.
    await act(async () => {
      FakeEventSource.last.emit('message', sendResponse);
    });
    await flush();

    expect(decryptCalls).not.toContain('own1');
    expect(bodyText().split('my own words').length - 1).toBe(1);
    expect(bodyText()).not.toContain(enLocale.chat.lockedMessage);
  });

  it('REGRESSION: the echo beating the POST response leaves ONE bubble, not two', async () => {
    /*
     * The provisional row and the server row used to be reconciled only in the
     * POST-response handler, keyed on the provisional id. The SSE echo took a
     * different path that knew nothing about the provisional row, so when it
     * arrived first the same message was on screen twice until the response
     * caught up — visible, and reported.
     *
     * The two paths share exactly one value before the id exists: the
     * ciphertext this tab sealed. That is what they are matched on now.
     */
    historyPage = [];
    let release!: () => void;
    const promise = new Promise<void>((r) => {
      release = r;
    });
    sendGate = { promise, release };
    sendResponse = wire(9, {
      id: 'srv-1',
      userId: ME,
      nickname: 'me',
      sealed: { ciphertext: 'ct-own-hello', epoch: 0 },
    });

    await mount();
    await act(async () => FakeEventSource.last.open());
    await flush();

    const input = container.querySelector('input[type="text"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(input, 'hello');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const send = container.querySelector(`button[aria-label="${enLocale.chat.send}"]`) as HTMLButtonElement;
    await act(async () => {
      send.click();
    });
    await flush();

    // The echo lands while the POST is still in flight.
    await act(async () => {
      FakeEventSource.last.emit('message', sendResponse);
    });
    await flush();
    expect(bodyText().split('hello').length - 1).toBe(1);

    // …and the response, arriving second, must not add another.
    await act(async () => {
      release();
    });
    await flush();
    expect(bodyText().split('hello').length - 1).toBe(1);
  });

  it('REGRESSION: Enter that COMMITS a Korean composition is not a send', async () => {
    /*
     * Typing Korean leaves the last syllable in the IME buffer, and Enter first
     * commits it: the browser fires keydown with `isComposing` set, then fires
     * a SECOND Enter once the commit lands. Treating both as sends made every
     * Korean message arrive as two — the real one, then a single stray letter,
     * because the composer had been emptied and the IME wrote the committed
     * jamo back into it. Reported from the app: "ㅇㅁㄹㅇ" arrived as "ㅇㅁㄹㅇ"
     * and "ㅇ".
     */
    historyPage = [];
    sendResponse = wire(11, { id: 'srv-ko', userId: ME, nickname: 'me' });
    await mount();
    await act(async () => FakeEventSource.last.open());
    await flush();

    const input = container.querySelector('input[type="text"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(input, 'ㅇㅁㄹㅇ');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const enter = (isComposing: boolean) =>
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing }),
      );

    await act(async () => void enter(true));
    await flush();
    expect(sendRequests()).toHaveLength(0);

    // The second Enter, after the commit, is the real one.
    await act(async () => void enter(false));
    await flush();
    expect(sendRequests()).toHaveLength(1);
  });

  it('a guest issues no chat request at all', async () => {
    await mount({ isGuest: true, isMember: false });
    expect(chatRequests('history')).toHaveLength(0);
    expect(FakeEventSource.instances).toHaveLength(0);
    expect(bodyText()).toContain('Join this topic to view chat');
  });

  it('a non-member issues no chat request at all', async () => {
    await mount({ isGuest: false, isMember: false });
    expect(chatRequests('history')).toHaveLength(0);
    expect(FakeEventSource.instances).toHaveLength(0);
  });
});

/**
 * The delivery cursor (R-1). The server keeps a message's live ciphertext only
 * until every device that was in the group at send time has fetched it, so the
 * panel has to say what it now holds — and has to render the rows whose live
 * copy is already gone.
 *
 * Edge-case matrix rows: contract (every arrival path acks) · integrity (the
 * NEWEST instant, and never a rewind on an older page) · boundary (an empty
 * page acks nothing) · ext-failure (a refused ack leaves the history on screen)
 * · empty (a purged row consults the local cache before claiming to be locked).
 */
describe('delivery acknowledgement and purged rows', () => {
  function acks(): Array<{ deviceId: string; through: string }> {
    return postBodies
      .filter((r) => r.url === `/api/topics/${TOPIC}/chat/delivered`)
      .map((r) => JSON.parse(r.body));
  }

  it('CONTRACT: the initial history load acks the newest row for this device', async () => {
    historyPage = [wire(3), wire(2), wire(1)]; // newest-first, as the server sends
    await mount();

    const sent = acks();
    expect(sent.length).toBeGreaterThan(0);
    expect(sent[sent.length - 1].deviceId).toBe('device-1');
    expect(sent[sent.length - 1].through).toBe(wire(3).createdAt);
  });

  it('CONTRACT: a message arriving over SSE is acked too', async () => {
    historyPage = [];
    await mount();
    const before = acks().length;

    await act(async () => {
      FakeEventSource.last.open();
      FakeEventSource.last.emit('message', wire(9));
    });
    await flush();

    const sent = acks();
    expect(sent.length).toBeGreaterThan(before);
    expect(sent[sent.length - 1].through).toBe(wire(9).createdAt);
  });

  it('INTEGRITY: an older history page never rewinds the mark', async () => {
    // `?before=` pages are older by construction. Acking their newest row would
    // move the server's high-water mark BACKWARDS and re-block messages this
    // device has already taken delivery of.
    historyPage = Array.from({ length: 50 }, (_, i) => wire(100 - i));
    await mount();
    const newestSoFar = acks()[acks().length - 1].through;

    beforePages = [[wire(20), wire(19)]];
    await act(async () => void loadOlderButton()?.click());
    await flush();

    for (const a of acks()) {
      expect(new Date(a.through).getTime()).toBeLessThanOrEqual(new Date(newestSoFar).getTime());
    }
  });

  it('BOUNDARY: an empty topic acks nothing', async () => {
    historyPage = [];
    await mount();
    expect(acks()).toHaveLength(0);
  });

  it('EXT-FAILURE: a refused ack leaves the history on screen', async () => {
    // The rows are already rendered by then; a failed acknowledgement costs
    // some server storage and must cost nothing else.
    historyPage = [wire(1)];
    const original = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith('/chat/delivered')) throw new Error('offline');
        return (original as typeof fetch)(input, init);
      }),
    );
    await mount();
    expect(bodyText()).toContain('plain(ct-m1)');
  });


});
