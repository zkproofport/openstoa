// @vitest-environment jsdom
/**
 * A message this device cannot decrypt must never surface as raw internals.
 *
 * The reported bug: opening the site in a second browser showed a column of
 * "[unable to decrypt]" bubbles. That string was an internal sentinel doing
 * double duty as user-facing copy, so the user saw neither a cause nor a
 * remedy — and concluded chat was broken.
 *
 * The rules these tests hold:
 *   1. "[unable to decrypt]" NEVER reaches the DOM, in any locale.
 *   2. A locked message renders as locked, in the user's language.
 *   3. Exactly one notice explains WHY and offers the actual next step, and
 *      which step it offers depends on whether recovery is possible.
 *   4. Recovery runs from a real click — Safari required a user gesture for
 *      `navigator.credentials.get()` through iOS 17.3, so it must not fire
 *      from an effect on mount.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '@/lib/i18n/I18nProvider';
import en from '@/lib/i18n/locales/en.json';
import ko from '@/lib/i18n/locales/ko.json';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const keyState = vi.hoisted(() => ({
  state: 'recoverable' as 'ready' | 'recoverable' | 'no-backup',
  recoverCalls: 0,
  recoverResult: true as boolean | Error,
}));

vi.mock('@/lib/mls/webTransport', () => ({
  getMlsSessionStore: () => ({
    open: async () => null,
    openCached: async () => null,
    sync: async () => {},
  }),
  getTakSessionStore: () => ({
    backfill: async () => [],
    myDeviceId: async () => 'web-test',
    distributePublicRoot: async () => 0,
    grantPrivateHistory: async () => 0,
  }),
  getDeviceKeyState: async () => keyState.state,
  recoverDeviceWithPasskey: async () => {
    keyState.recoverCalls += 1;
    if (keyState.recoverResult instanceof Error) throw keyState.recoverResult;
    return keyState.recoverResult;
  },
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/topics',
}));

vi.mock('@/components/TopicMuteToggle', () => ({
  default: () => React.createElement('div'),
}));
vi.mock('@/components/LinkPreview', () => ({ default: () => null }));

import ChatPanel from '@/components/ChatPanel';

const SEALED = { ciphertext: 'c2VhbGVk', epoch: 3 };

/** Two sealed rows the panel can never open, plus one system row. */
const ROWS = [
  { id: 'm1', topicId: 't1', userId: '0xaaa', nickname: 'alice', type: 'message', sealed: SEALED, createdAt: '2026-07-29T00:00:00.000Z' },
  { id: 'm2', topicId: 't1', userId: '0xbbb', nickname: 'bob', type: 'message', sealed: SEALED, createdAt: '2026-07-29T00:01:00.000Z' },
  { id: 's1', topicId: 't1', userId: '0xbbb', nickname: 'bob', type: 'join', message: '', createdAt: '2026-07-29T00:02:00.000Z' },
];

let container: HTMLDivElement;
let root: Root;

function mockFetch() {
  return vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/chat')) {
      return Promise.resolve(new Response(JSON.stringify({ messages: ROWS, hasMore: false }), { status: 200 }));
    }
    return Promise.resolve(new Response('{}', { status: 200 }));
  });
}

async function mount(locale: 'en' | 'ko' = 'en') {
  await act(async () => {
    root.render(
      <I18nProvider initialLocale={locale}>
        <ChatPanel topicId="t1" isGuest={false} isMember fullHeight />
      </I18nProvider>,
    );
  });
  for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
}

const text = () => container.textContent ?? '';
const buttons = () => Array.from(container.querySelectorAll('button'));

beforeEach(() => {
  keyState.state = 'recoverable';
  keyState.recoverCalls = 0;
  keyState.recoverResult = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.stubGlobal('fetch', mockFetch());
  vi.stubGlobal('EventSource', class {
    onmessage: unknown = null;
    onerror: unknown = null;
    close() {}
    addEventListener() {}
    removeEventListener() {}
  });
  vi.stubGlobal('IntersectionObserver', class {
    observe() {} disconnect() {} unobserve() {}
  });
  Element.prototype.scrollTo = Element.prototype.scrollTo ?? (() => {});
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('a locked message never leaks internals', () => {
  it('CONTRACT: "[unable to decrypt]" is never rendered — English', async () => {
    await mount('en');
    expect(text()).not.toContain('unable to decrypt');
    expect(text()).toContain(en.chat.lockedMessage);
  });

  it('CONTRACT: "[unable to decrypt]" is never rendered — Korean', async () => {
    await mount('ko');
    expect(text()).not.toContain('unable to decrypt');
    expect(text()).toContain(ko.chat.lockedMessage);
    // The whole notice is translated too — no English leaking into a ko screen.
    expect(text()).not.toContain('Unlock history');
  });
});

describe('the notice explains the cause and offers the right next step', () => {
  it('recoverable → offers the passkey unlock, and reports how many are locked', async () => {
    keyState.state = 'recoverable';
    await mount('en');
    expect(container.querySelector('[role="status"]')).toBeTruthy();
    expect(text()).toContain('2'); // two sealed rows; the join row is not locked
    expect(buttons().some((b) => (b.textContent ?? '').includes(en.chat.lockedHistory.unlock))).toBe(true);
  });

  it('no-backup → does NOT offer an unlock that cannot work; points at setting recovery up', async () => {
    keyState.state = 'no-backup';
    await mount('en');
    expect(buttons().some((b) => (b.textContent ?? '').includes(en.chat.lockedHistory.unlock))).toBe(false);
    const link = Array.from(container.querySelectorAll('a')).find((a) =>
      (a.textContent ?? '').includes(en.chat.lockedHistory.setUp),
    );
    expect(link?.getAttribute('href')).toBe('/my');
  });

  it("REGRESSION: 'ready' does NOT suppress the notice when messages are locked", async () => {
    // This asserted the opposite, and that is precisely how the feature shipped
    // dead: a second device reported 'ready' (its key opens the account
    // archive) while still holding nothing for the messages on screen, so the
    // only route out was hidden behind an inference. What is on screen —
    // locked messages — is the fact that decides.
    keyState.state = 'ready';
    await mount('en');
    expect(container.querySelector('[role="status"]')).not.toBeNull();
    // 'ready' is not 'recoverable', so it must not offer an unlock that has
    // nothing behind it.
    expect(buttons().some((b) => (b.textContent ?? '').includes(en.chat.lockedHistory.unlock))).toBe(false);
  });

  it('the notice appears even before the probe resolves, and never blocks on it', async () => {
    // A slow or failing probe must not hide the remedy. `mount` flushes only a
    // few microtask generations, so a never-resolving probe leaves state null.
    keyState.state = 'no-backup';
    await mount('en');
    expect(container.querySelector('[role="status"]')).not.toBeNull();
  });
});

describe('recovery is gesture-driven, not automatic', () => {
  it('does NOT call recovery on mount — Safari needs a user gesture', async () => {
    keyState.state = 'recoverable';
    await mount('en');
    expect(keyState.recoverCalls).toBe(0);
  });

  it('calls recovery exactly once when the button is clicked', async () => {
    keyState.state = 'recoverable';
    await mount('en');
    const btn = buttons().find((b) => (b.textContent ?? '').includes(en.chat.lockedHistory.unlock))!;
    await act(async () => {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => { await Promise.resolve(); });
    expect(keyState.recoverCalls).toBe(1);
  });

  it('a failed unlock says so instead of silently doing nothing', async () => {
    keyState.state = 'recoverable';
    keyState.recoverResult = false; // no passkey wrap to recover from
    await mount('en');
    const btn = buttons().find((b) => (b.textContent ?? '').includes(en.chat.lockedHistory.unlock))!;
    await act(async () => {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    for (let i = 0; i < 3; i++) await act(async () => { await Promise.resolve(); });
    expect(text()).toContain(en.chat.lockedHistory.failed);
  });

  it('a thrown recovery (user dismissed the passkey sheet) is reported, not swallowed', async () => {
    keyState.state = 'recoverable';
    keyState.recoverResult = new Error('NotAllowedError');
    await mount('en');
    const btn = buttons().find((b) => (b.textContent ?? '').includes(en.chat.lockedHistory.unlock))!;
    await act(async () => {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    for (let i = 0; i < 3; i++) await act(async () => { await Promise.resolve(); });
    expect(text()).toContain(en.chat.lockedHistory.failed);
    // and the raw exception is not shown to the user
    expect(text()).not.toContain('NotAllowedError');
  });
});

describe('chat.lockedHistory i18n', () => {
  const shape = (o: unknown, p = ''): string[] =>
    typeof o === 'object' && o !== null
      ? Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => shape(v, `${p}${k}.`))
      : [p];

  it('en and ko carry the same keys, and no ko value was left in English', () => {
    expect(shape(ko.chat.lockedHistory).sort()).toEqual(shape(en.chat.lockedHistory).sort());
    const koV = Object.values(ko.chat.lockedHistory);
    const enV = Object.values(en.chat.lockedHistory);
    expect(koV.filter((v, i) => v === enV[i])).toEqual([]);
    expect(ko.chat.lockedMessage).not.toBe(en.chat.lockedMessage);
  });
});
