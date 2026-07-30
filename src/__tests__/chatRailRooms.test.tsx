// @vitest-environment jsdom
/**
 * ChatRail — the shape of a conversation row.
 *
 * A row used to be an avatar plus one ellipsised line, so the list said only
 * "these rooms exist": no sense of which one just moved, which one is waiting
 * for you, or which one you have never opened. This file pins the row's
 * informational contract, and — more importantly — pins the ONE thing that
 * contract must never do.
 *
 * SI-1, the load-bearing rule: the server holds ciphertext and nothing else,
 * so a message PREVIEW can only ever come from plaintext this device already
 * holds. A server-supplied preview field would mean the server had read the
 * message. The negative test below feeds exactly such a field into the list
 * payload and asserts it never reaches the DOM — that assertion is the reason
 * this file exists, not the row's cosmetics.
 *
 * Edge-case matrix rows covered here:
 *   integrity  — a server-sent preview/lastMessage field is never rendered
 *   empty      — a DM that has never been used says "No messages yet"
 *   boundary   — unread absent / 0 / 1 / 999 / 1000 / 12345, plus negative,
 *                NaN, null and a numeric STRING (all → no badge)
 *   UTF-8      — Korean, emoji and mixed titles render verbatim
 *   large      — a 500-character title stays on one ellipsised line
 *   hostile    — a `<script>`-shaped title renders as text, never as markup
 *   locale     — the placeholder and the unread label translate
 *   contract   — clicking a row still opens that room (the rail's job)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import enLocale from '@/lib/i18n/locales/en.json';
import koLocale from '@/lib/i18n/locales/ko.json';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('next/navigation', () => ({
  usePathname: () => '/topics',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

// Stubbed for the same reason chatRail.test.tsx stubs it: this is a test of
// the rail's list rendering, and a real panel would drag the whole MLS
// decrypt path into it.
vi.mock('@/components/ChatPanel', () => ({
  default: () => React.createElement('div', { 'data-testid': 'chat-panel' }),
}));

vi.mock('@/components/TopicMuteToggle', () => ({
  default: () => React.createElement('div', { 'data-testid': 'mute-toggle' }),
}));

import ChatRail, { formatUnreadBadge } from '@/components/ChatRail';
import { I18nProvider } from '@/lib/i18n/I18nProvider';

let container: HTMLDivElement;
let root: Root;

function json(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as unknown as Response;
}

function routeFetch(topicsBody: unknown, dmsBody: unknown) {
  const fn = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith('/api/auth/session')) return Promise.resolve(json({ userId: 'me' }));
    if (url.startsWith('/api/topics')) return Promise.resolve(json(topicsBody));
    if (url.startsWith('/api/dm')) return Promise.resolve(json(dmsBody));
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

async function flush(times = 6) {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function mount(locale: 'en' | 'ko' = 'en') {
  await act(async () => {
    root.render(
      <I18nProvider initialLocale={locale}>
        <ChatRail onClose={() => {}} openRequest={null} />
      </I18nProvider>,
    );
  });
  await flush();
}

/** Switch the list to the Direct tab. */
async function openDmTab() {
  const dmTab = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find(
    (b) => b.textContent === enLocale.chatRail.tabs.direct || b.textContent === koLocale.chatRail.tabs.direct,
  )!;
  await act(async () => {
    dmTab.click();
  });
  await flush();
}

function byTestId(id: string): HTMLElement[] {
  return Array.from(container.querySelectorAll(`[data-testid="${id}"]`));
}

function text(): string {
  return container.textContent ?? '';
}

/** ISO string a fixed number of minutes in the past. */
function minutesAgo(n: number): string {
  return new Date(Date.now() - n * 60_000).toISOString();
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
});

// ─── The rule the whole surface hangs on ─────────────────────────────────────

describe('SI-1 — no server-side preview, ever', () => {
  it('INTEGRITY: a preview-shaped field in the list payload never reaches the DOM', async () => {
    // A server that could send any of these would be a server that had read
    // the message. If a future change starts trusting one, this fails.
    routeFetch(
      {
        topics: [
          {
            id: 't1',
            title: 'Privacy',
            lastActivityAt: minutesAgo(14),
            preview: 'SERVER-READ-THIS',
            lastMessage: 'SERVER-READ-THIS-TOO',
            lastMessagePreview: 'AND-THIS',
          },
        ],
      },
      { dms: [] },
    );
    await mount();

    expect(text()).not.toContain('SERVER-READ-THIS');
    expect(text()).not.toContain('SERVER-READ-THIS-TOO');
    expect(text()).not.toContain('AND-THIS');
    // What it renders instead: the locked placeholder.
    expect(byTestId('chat-rail-room-preview')[0].textContent).toContain(
      enLocale.chat.encryptedPreview,
    );
  });

  it('a topic row with activity shows the locked placeholder, with the lock glyph', async () => {
    routeFetch({ topics: [{ id: 't1', title: 'Privacy', lastActivityAt: minutesAgo(14) }] }, { dms: [] });
    await mount();

    expect(byTestId('chat-rail-room-preview')[0].textContent).toBe(
      `🔒 ${enLocale.chat.encryptedPreview}`,
    );
  });

  it('LOCALE ko: the placeholder is the Korean string', async () => {
    routeFetch({ topics: [{ id: 't1', title: 'Privacy', lastActivityAt: minutesAgo(14) }] }, { dms: [] });
    await mount('ko');

    expect(byTestId('chat-rail-room-preview')[0].textContent).toBe(
      `🔒 ${koLocale.chat.encryptedPreview}`,
    );
    expect(text()).not.toContain(enLocale.chat.encryptedPreview);
  });
});

// ─── Row shape ───────────────────────────────────────────────────────────────

describe('row shape', () => {
  it('CONTRACT: avatar + title + preview line + relative time, in one row', async () => {
    routeFetch({ topics: [{ id: 't1', title: 'Privacy', lastActivityAt: minutesAgo(14) }] }, { dms: [] });
    await mount();

    const row = byTestId('chat-rail-topic-row')[0];
    expect(row).toBeTruthy();
    expect(row.textContent).toContain('Privacy');
    expect(row.querySelector('[data-testid="chat-rail-room-preview"]')).not.toBeNull();
    expect(row.querySelector('[data-testid="chat-rail-room-time"]')!.textContent).toBe('14m');
  });

  it('EMPTY: a DM that has never been used says "No messages yet" and shows no time', async () => {
    routeFetch(
      { topics: [] },
      { dms: [{ topicId: 'd1', peer: { userId: 'u1', nickname: 'alice', profileImage: null }, lastActivityAt: null }] },
    );
    await mount();
    await openDmTab();

    expect(byTestId('chat-rail-room-preview')[0].textContent).toBe(enLocale.chat.noMessagesYet);
    expect(byTestId('chat-rail-room-time')).toHaveLength(0);
  });

  it('a used DM shows the locked placeholder and its time', async () => {
    routeFetch(
      { topics: [] },
      {
        dms: [
          {
            topicId: 'd1',
            peer: { userId: 'u1', nickname: 'alice', profileImage: null },
            lastActivityAt: minutesAgo(60 * 4),
          },
        ],
      },
    );
    await mount();
    await openDmTab();

    expect(byTestId('chat-rail-room-preview')[0].textContent).toContain(
      enLocale.chat.encryptedPreview,
    );
    expect(byTestId('chat-rail-room-time')[0].textContent).toBe('4h');
  });

  it('a topic row without a server timestamp renders no time rather than "Invalid Date"', async () => {
    routeFetch({ topics: [{ id: 't1', title: 'Privacy' }] }, { dms: [] });
    await mount();

    expect(byTestId('chat-rail-topic-row')).toHaveLength(1);
    expect(byTestId('chat-rail-room-time')).toHaveLength(0);
    expect(text()).not.toContain('Invalid Date');
    expect(text()).not.toContain('NaN');
  });
});

// ─── Unread badge ────────────────────────────────────────────────────────────

describe('unread badge — boundaries', () => {
  const cases: Array<[label: string, value: unknown, expected: string | null]> = [
    ['absent', undefined, null],
    ['null', null, null],
    ['zero', 0, null],
    ['negative', -3, null],
    ['NaN', Number.NaN, null],
    ['Infinity', Number.POSITIVE_INFINITY, null],
    ['numeric string', '5', null],
    ['one', 1, '1'],
    ['nine hundred ninety-nine', 999, '999'],
    ['one thousand', 1000, '999+'],
    ['twelve thousand', 12345, '999+'],
    ['fractional', 3.7, '3'],
  ];

  it.each(cases)('formatUnreadBadge(%s)', async (_label, value, expected) => {
    expect(formatUnreadBadge(value)).toBe(expected);
  });

  it('BOUNDARY 0: a room with no unread count renders no badge', async () => {
    routeFetch({ topics: [{ id: 't1', title: 'Privacy', lastActivityAt: minutesAgo(1) }] }, { dms: [] });
    await mount();

    expect(byTestId('chat-rail-unread-badge')).toHaveLength(0);
  });

  it('BOUNDARY 1: a single unread renders the literal count inline with the title', async () => {
    routeFetch(
      { topics: [{ id: 't1', title: 'Privacy', lastActivityAt: minutesAgo(1), unreadCount: 1 }] },
      { dms: [] },
    );
    await mount();

    const badge = byTestId('chat-rail-unread-badge')[0];
    expect(badge.textContent).toBe('1');
    expect(badge.getAttribute('aria-label')).toBe('1 unread messages');
  });

  it('BOUNDARY 1000+: the badge caps at 999+ but the accessible label keeps the true count', async () => {
    routeFetch(
      { topics: [{ id: 't1', title: 'Privacy', lastActivityAt: minutesAgo(1), unreadCount: 12345 }] },
      { dms: [] },
    );
    await mount();

    const badge = byTestId('chat-rail-unread-badge')[0];
    expect(badge.textContent).toBe('999+');
    expect(badge.getAttribute('aria-label')).toBe('12345 unread messages');
  });

  it('LOCALE ko: the unread label translates', async () => {
    routeFetch(
      { topics: [{ id: 't1', title: 'Privacy', lastActivityAt: minutesAgo(1), unreadCount: 3 }] },
      { dms: [] },
    );
    await mount('ko');

    expect(byTestId('chat-rail-unread-badge')[0].getAttribute('aria-label')).toBe(
      '읽지 않은 메시지 3개',
    );
  });

  it('a DM row carries the badge on the same contract', async () => {
    routeFetch(
      { topics: [] },
      {
        dms: [
          {
            topicId: 'd1',
            peer: { userId: 'u1', nickname: 'alice', profileImage: null },
            lastActivityAt: minutesAgo(2),
            unreadCount: 7,
          },
        ],
      },
    );
    await mount();
    await openDmTab();

    expect(byTestId('chat-rail-unread-badge')[0].textContent).toBe('7');
  });
});

// ─── Text that fights back ───────────────────────────────────────────────────

describe('hostile and international titles', () => {
  it('UTF-8: Korean, emoji and mixed titles render verbatim', async () => {
    routeFetch(
      {
        topics: [
          { id: 't1', title: '푸시테스트', lastActivityAt: minutesAgo(3) },
          { id: 't2', title: '🎉🔒 emoji room', lastActivityAt: minutesAgo(3) },
          { id: 't3', title: '한글 mixed 中文 テスト', lastActivityAt: minutesAgo(3) },
        ],
      },
      { dms: [] },
    );
    await mount();

    expect(byTestId('chat-rail-topic-row')).toHaveLength(3);
    expect(text()).toContain('푸시테스트');
    expect(text()).toContain('🎉🔒 emoji room');
    expect(text()).toContain('한글 mixed 中文 テスト');
  });

  it('LARGE: a 500-character title stays on one ellipsised line', async () => {
    const long = '가'.repeat(500);
    routeFetch({ topics: [{ id: 't1', title: long, lastActivityAt: minutesAgo(3) }] }, { dms: [] });
    await mount();

    const row = byTestId('chat-rail-topic-row')[0];
    const titleEl = row.querySelector('span > span > span') as HTMLElement;
    expect(titleEl.textContent).toBe(long);
    expect(titleEl.style.whiteSpace).toBe('nowrap');
    expect(titleEl.style.textOverflow).toBe('ellipsis');
    expect(titleEl.style.overflow).toBe('hidden');
  });

  it('HOSTILE: a script-shaped title renders as text, never as markup', async () => {
    routeFetch(
      {
        topics: [
          { id: 't1', title: '<script>alert(1)</script>', lastActivityAt: minutesAgo(3) },
          { id: 't2', title: "100%_of_'em", lastActivityAt: minutesAgo(3) },
        ],
      },
      { dms: [] },
    );
    await mount();

    expect(container.querySelector('script')).toBeNull();
    expect(text()).toContain('<script>alert(1)</script>');
    expect(text()).toContain("100%_of_'em");
  });

  it("HOSTILE: a peer nickname shaped like the placeholder does not masquerade as one", async () => {
    routeFetch(
      { topics: [] },
      {
        dms: [
          {
            topicId: 'd1',
            peer: { userId: 'u1', nickname: `🔒 ${enLocale.chat.encryptedPreview}`, profileImage: null },
            lastActivityAt: null,
          },
        ],
      },
    );
    await mount();
    await openDmTab();

    // The nickname is the TITLE; the preview line is still the honest
    // "never used" state, not an encrypted-message claim.
    expect(byTestId('chat-rail-room-preview')[0].textContent).toBe(enLocale.chat.noMessagesYet);
  });
});

describe('rows stay interactive', () => {
  it('CONTRACT: clicking a topic row opens that room', async () => {
    routeFetch({ topics: [{ id: 't1', title: 'Privacy', lastActivityAt: minutesAgo(3) }] }, { dms: [] });
    await mount();

    await act(async () => {
      (byTestId('chat-rail-topic-row')[0] as HTMLButtonElement).click();
    });
    await flush();

    expect(container.querySelector('[data-testid="chat-panel"]')).not.toBeNull();
  });
});
