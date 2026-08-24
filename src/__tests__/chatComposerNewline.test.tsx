// @vitest-environment jsdom
/**
 * ChatPanel composer — Shift+Enter inserts a newline, Enter still sends.
 *
 * THE DEFECT THESE GUARD: the composer was `<input type="text">`. The keydown
 * handler already excluded Shift+Enter from the send path, so the code read as
 * correct — but an `<input>` cannot contain a newline at all, so the browser
 * had nothing to insert and Shift+Enter did nothing on the web while doing the
 * expected thing everywhere else. The element was the bug, not the handler,
 * and that is what the first test pins.
 *
 * WHAT THESE TESTS CANNOT PROVE: that a newline literally lands in the box.
 * jsdom does not run the browser's default editing behaviour, so no assertion
 * here would distinguish "the browser inserted \n" from "nothing happened".
 * What IS provable, and is what actually broke, is:
 *   • the element is one that CAN hold a newline (textarea, not input);
 *   • Shift+Enter is left alone — not sent, and `preventDefault` NOT called,
 *     so the browser's own insertion is allowed to happen;
 *   • Enter alone still sends and still prevents the default (the constraint:
 *     Enter-to-send semantics are unchanged by this fix);
 *   • an IME composition Enter does neither, in either shift state — the
 *     reporter types Korean, and this is the path that doubled every message
 *     before;
 *   • a message carrying a newline renders in a bubble that preserves it,
 *     because HTML collapses whitespace by default and the break would
 *     otherwise survive the composer, the seal and the wire only to vanish at
 *     the last inch.
 *
 * The last describe covers what the swap must NOT break — the paste-to-upload
 * handler moved elements with the composer, and it had no test at all before
 * this file.
 *
 * Mutation-checked, each guard watched going red: reverting the element to
 * `<input type="text">` fails the first test; deleting `whiteSpace: 'pre-wrap'`
 * fails the render test; dropping `!e.shiftKey` fails the Shift+Enter test;
 * unwiring `onPaste` fails the image-paste test; an unconditional
 * `preventDefault` in the paste handler fails the text-paste test.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushQueries } from './harness/providers';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TOPIC = '11111111-2222-4333-8444-555555555555';
const ME = 'nullifier-me';

// ─── MLS doubles ─────────────────────────────────────────────────────────────
// Same shape as chatPanel-sync.test.tsx: a seal that reports what it sealed, so
// a test can tell "Enter sent" from "Enter did something else".

let sealed: string[];

const mlsStore = {
  openCached: vi.fn(async (_t: string, _id: string, s: { ciphertext: string }) => `plain(${s.ciphertext})`),
  open: vi.fn(async (_t: string, s: { ciphertext: string }) => `plain(${s.ciphertext})`),
  seal: vi.fn(async (_t: string, plaintext: string) => {
    sealed.push(plaintext);
    return { ciphertext: `ct-own-${plaintext}`, epoch: 0 };
  }),
  cachePlaintext: vi.fn(async () => {}),
};

const takStore = {
  backfill: vi.fn(async () => [] as { messageId: string; plaintext: string }[]),
  myDeviceId: vi.fn(async () => 'device-1'),
  distributeRoot: vi.fn(async () => 0),
  grantPrivateHistory: vi.fn(async () => {}),
  sealForPush: vi.fn(async () => null),
  archiveOnSend: vi.fn(async () => {}),
};

vi.mock('@/lib/mls/webTransport', () => ({
  getMlsSessionStore: () => mlsStore,
  getTakSessionStore: () => takStore,
  getDeviceKeyState: async () => 'ready',
  recoverDeviceWithPasskey: async () => true,
}));

/**
 * PARTIAL mock: only the seal-and-upload step is doubled.
 *
 * `resolveChatMediaMime`, the size cap and the HEIC sniff stay REAL, so a paste
 * this file calls successful is one the shipped module would also have
 * accepted. Doubling the whole module would let a paste of anything at all
 * "work" here.
 */
const sendEncryptedChatMedia = vi.fn(async () => {});
vi.mock('@/lib/chatMedia', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/chatMedia')>();
  return { ...actual, sendEncryptedChatMedia: (...args: unknown[]) => sendEncryptedChatMedia(...(args as [])) };
});

const { default: ChatPanel } = await import('@/components/ChatPanel');
const { TestProviders } = await import('./harness/providers');

// ─── EventSource double ──────────────────────────────────────────────────────

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
  open() {
    this.onopen?.();
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
  type: 'message';
  createdAt: string;
  message: string | null;
  sealed: { ciphertext: string; epoch: number } | null;
}

let requests: string[];
let historyPage: WireMessage[];

function json(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as unknown as Response;
}

function installFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requests.push(url);
      if (url === '/api/auth/session') return json({ userId: ME });
      if (url === `/api/topics/${TOPIC}`) {
        return json({ topic: { visibility: 'public' }, currentUserRole: 'member' });
      }
      if (url.startsWith(`/api/topics/${TOPIC}/chat?`)) {
        return json({ messages: historyPage, total: historyPage.length });
      }
      if (url === `/api/topics/${TOPIC}/chat`) return json({ message: null }, true, 201);
      if (url === `/api/topics/${TOPIC}/chat/delivered`) {
        return json({ deliveredThrough: new Date().toISOString() });
      }
      return json({ error: 'not found' }, false, 404);
    }),
  );
}

// ─── Harness ─────────────────────────────────────────────────────────────────

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
  // The composer is disabled until the stream is live.
  await act(async () => FakeEventSource.last.open());
  await flush();
}

/** The composer. Typed as the element it MUST be — see the header. */
function composer(): HTMLTextAreaElement {
  const el = container.querySelector('textarea');
  if (!el) {
    const input = container.querySelector('input[type="text"]');
    throw new Error(
      input
        ? 'composer is an <input type="text"> — it cannot hold a newline; Shift+Enter has nothing to insert'
        : 'no composer found',
    );
  }
  return el;
}

/** Type into the controlled composer the way React expects. */
async function type(text: string) {
  const el = composer();
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    'value',
  )?.set;
  setter?.call(el, text);
  await act(async () => {
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await flush(2);
}

/**
 * Dispatch a keydown the way the browser would, and report whether the page
 * let the default happen.
 *
 * `keyCode` is defined explicitly because jsdom's KeyboardEvent ignores it in
 * the init dict, and the handler reads it as the IME signal browsers that do
 * not set `isComposing` still send.
 */
async function keydown(
  init: { key: string; shiftKey?: boolean; isComposing?: boolean; keyCode?: number },
): Promise<{ defaultPrevented: boolean }> {
  const el = composer();
  const ev = new KeyboardEvent('keydown', {
    key: init.key,
    shiftKey: init.shiftKey ?? false,
    isComposing: init.isComposing ?? false,
    bubbles: true,
    cancelable: true,
  });
  if (init.keyCode !== undefined) {
    Object.defineProperty(ev, 'keyCode', { get: () => init.keyCode });
  }
  await act(async () => {
    el.dispatchEvent(ev);
  });
  await flush();
  return { defaultPrevented: ev.defaultPrevented };
}

function wire(over: Partial<WireMessage> = {}): WireMessage {
  return {
    id: 'm1',
    topicId: TOPIC,
    userId: 'nullifier-other',
    nickname: 'alice',
    type: 'message',
    createdAt: new Date(Date.UTC(2026, 0, 1)).toISOString(),
    message: null,
    sealed: { ciphertext: 'ct-m1', epoch: 0 },
    ...over,
  };
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  sealed = [];
  sendEncryptedChatMedia.mockClear();
  requests = [];
  historyPage = [];
  FakeEventSource.instances = [];
  Element.prototype.scrollIntoView = function scrollIntoView() {};
  Element.prototype.scrollTo = function scrollTo() {};
  vi.stubGlobal('EventSource', FakeEventSource as unknown as typeof EventSource);
  installFetch();
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
});

describe('ChatPanel composer — the element', () => {
  it('is a textarea, the only element that can hold a newline', async () => {
    await mount();
    const el = composer();
    expect(el.tagName).toBe('TEXTAREA');
    // The old element, gone: a stray text input in the composer row would mean
    // the swap was reverted or half-applied.
    expect(container.querySelectorAll('input[type="text"]')).toHaveLength(0);
  });

  it('keeps the 1000-character cap the input had', async () => {
    await mount();
    expect(composer().maxLength).toBe(1000);
  });

  it('rests at one row', async () => {
    await mount();
    expect(composer().rows).toBe(1);
  });
});

describe('ChatPanel composer — Enter semantics', () => {
  it('Shift+Enter does not send, and lets the browser insert the newline', async () => {
    await mount();
    await type('line one');
    const { defaultPrevented } = await keydown({ key: 'Enter', shiftKey: true });
    // NOT prevented: preventing it is exactly how a newline gets swallowed.
    expect(defaultPrevented).toBe(false);
    expect(sealed).toEqual([]);
    expect(requests.filter((u) => u === `/api/topics/${TOPIC}/chat`)).toHaveLength(0);
  });

  it('Enter alone still sends (unchanged by this fix)', async () => {
    await mount();
    await type('hello');
    const { defaultPrevented } = await keydown({ key: 'Enter' });
    expect(defaultPrevented).toBe(true);
    expect(sealed).toEqual(['hello']);
  });

  it('Enter that is committing an IME composition neither sends nor swallows', async () => {
    await mount();
    await type('하하');
    const { defaultPrevented } = await keydown({ key: 'Enter', isComposing: true });
    expect(defaultPrevented).toBe(false);
    expect(sealed).toEqual([]);
  });

  it('the keyCode-229 IME signal is honoured the same way', async () => {
    await mount();
    await type('하하');
    const { defaultPrevented } = await keydown({ key: 'Enter', keyCode: 229 });
    expect(defaultPrevented).toBe(false);
    expect(sealed).toEqual([]);
  });

  it('Shift+Enter mid-composition is also left alone', async () => {
    await mount();
    await type('하하');
    const { defaultPrevented } = await keydown({ key: 'Enter', shiftKey: true, isComposing: true });
    expect(defaultPrevented).toBe(false);
    expect(sealed).toEqual([]);
  });

  it('an empty composer sends nothing on Enter', async () => {
    await mount();
    const { defaultPrevented } = await keydown({ key: 'Enter' });
    // The default is still prevented — Enter is the send key whether or not
    // there is anything to send, and a newline must not appear in a composer
    // whose Enter means "send".
    expect(defaultPrevented).toBe(true);
    expect(sealed).toEqual([]);
  });

  it('a whitespace-only composer sends nothing on Enter', async () => {
    await mount();
    await type('   \n  ');
    await keydown({ key: 'Enter' });
    expect(sealed).toEqual([]);
  });

  it('a multi-line message sends with its newlines intact', async () => {
    await mount();
    await type('first\nsecond');
    await keydown({ key: 'Enter' });
    expect(sealed).toEqual(['first\nsecond']);
  });
});

/**
 * Dispatch a paste carrying `items`.
 *
 * jsdom implements neither `ClipboardEvent` nor `DataTransfer`, so the payload
 * is attached to a plain event — React reads `clipboardData` straight off the
 * native event, which is the same property the browser sets.
 */
async function paste(items: Array<{ type: string; file?: File }>): Promise<{ defaultPrevented: boolean }> {
  const el = composer();
  const ev = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'clipboardData', {
    value: {
      items: items.map((i) => ({ type: i.type, getAsFile: () => i.file ?? null })),
    },
  });
  await act(async () => {
    el.dispatchEvent(ev);
  });
  await flush();
  return { defaultPrevented: ev.defaultPrevented };
}

describe('ChatPanel composer — what the swap must not break', () => {
  it('a pasted image still uploads', async () => {
    await mount();
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'shot.png', { type: 'image/png' });
    const { defaultPrevented } = await paste([{ type: 'image/png', file }]);

    // Prevented, because the alternative is the browser ALSO pasting the
    // image's filename into the composer as text.
    expect(defaultPrevented).toBe(true);
    expect(sendEncryptedChatMedia).toHaveBeenCalledTimes(1);
  });

  it('a pasted TEXT clipboard is left to the browser', async () => {
    await mount();
    const { defaultPrevented } = await paste([{ type: 'text/plain' }]);

    // The regression this pins: an unconditional `preventDefault` in the paste
    // handler stops ordinary text pasting into the composer, which is a worse
    // bug than the one being fixed and would not fail any other test here.
    expect(defaultPrevented).toBe(false);
    expect(sendEncryptedChatMedia).not.toHaveBeenCalled();
  });

  it('the resting composer is still one 44pt touch target, so mount does not shift the layout', async () => {
    await mount();
    const el = composer();
    // Same three the `<input>` carried (chatE2eeBanner.test.tsx pins them too):
    // a textarea that mounts taller than the input did would push the message
    // list up on first paint.
    expect(el.style.minHeight).toBe('var(--touch-target-min)');
    expect(el.style.boxSizing).toBe('border-box');
    expect(el.style.fontSize).toBe('var(--text-body)');
    // …plus the two only a textarea needs: no drag handle, and a ceiling.
    expect(el.style.resize).toBe('none');
    expect(el.style.maxHeight).toBe('120px');
  });
});

describe('ChatPanel — a newline survives rendering', () => {
  it('renders bubble text with pre-wrap so the break is not collapsed', async () => {
    historyPage = [wire()];
    await mount();
    await flush();
    const bubble = Array.from(container.querySelectorAll('span')).find((s) =>
      (s.textContent ?? '').includes('plain(ct-m1)'),
    );
    expect(bubble).toBeTruthy();
    // `pre-line` would also keep the break but would additionally collapse
    // runs of spaces; `pre` would stop long lines wrapping. Pin the one that
    // is correct for a chat bubble.
    expect(bubble!.style.whiteSpace).toBe('pre-wrap');
  });
});
