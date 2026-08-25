// @vitest-environment jsdom
/**
 * Discoverable chat entry points (user feedback: "채팅 아이콘은 처음에 좀 찾기
 * 힘든데 좌우 패널이나 토픽 진입 시 채팅 관련 다이렉트 링크도 만들어줘").
 *
 * Two new affordances, both routed through `CommunityLayout`'s single rail
 * state (`openRail`) rather than owning any state of their own:
 *   - `LeftSidebar.tsx` — a "Chat" nav entry that opens the rail to the room
 *     LIST, available from anywhere in the app.
 *   - `RightSidebar.tsx` — an "Open topic chat" affordance on a topic page
 *     that jumps the rail straight to THAT topic's room.
 *
 * Edge-case matrix rows covered here:
 *   authz        — guest never sees either entry point (no chat for a guest
 *                  to open); RightSidebar's entry additionally requires a
 *                  resolved topicId + topicTitle (no dead button before the
 *                  topic has loaded)
 *   contract     — LeftSidebar's entry always requests room: null (the
 *                  list); RightSidebar's entry always requests the exact
 *                  topic room it is rendered for; both go through the SAME
 *                  `openRail` — no second rail-state mechanism
 *   mount-unique — CommunityLayout renders exactly one ChatRail (desktop
 *                  column XOR mobile full-screen sheet) regardless of which
 *                  entry point opened it
 *   race/repeat  — clicking the same entry point twice in a row (rail
 *                  already open on that exact target) still re-issues a
 *                  request the rail can act on (nonce advances) — pinned at
 *                  the `ChatRail` layer by the "REPEAT" case in
 *                  `chatRail.test.tsx`; here we only assert CommunityLayout
 *                  advances the nonce on every `openRail` call
 *   UTF-8        — a Korean + emoji topic title survives into the request
 *   empty        — RightSidebar's entry is simply absent (not disabled) when
 *                  topicId/topicTitle are not passed at all (non-topic pages)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const routerMock = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
const pathnameMock = vi.hoisted(() => ({ current: '/topics' }));
vi.mock('next/navigation', () => ({
  usePathname: () => pathnameMock.current,
  useRouter: () => routerMock,
}));

// Force the desktop rail column branch — this suite is about wiring, not
// the responsive presentation split (already covered elsewhere).
vi.mock('@/hooks/useMediaQuery', () => ({
  useMediaQuery: () => true,
  DESKTOP_CHAT_QUERY: '(min-width: 1024px)',
  // BottomTabBar (mounted unconditionally by CommunityLayout) imports this
  // named export; a mock factory that omits it throws on import, not just
  // on use, because vitest validates against the real module's exports.
  MOBILE_QUERY: '(max-width: 767px)',
}));

vi.mock('@/components/Header', () => ({
  default: () => React.createElement('div', { 'data-testid': 'header' }),
}));

const railProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null, mountCount: 0 }));
vi.mock('@/components/ChatRail', () => ({
  default: (props: Record<string, unknown>) => {
    railProps.current = props;
    railProps.mountCount += 1;
    return React.createElement('div', { 'data-testid': 'chat-rail' });
  },
}));

import CommunityLayout from '@/components/CommunityLayout';
import LeftSidebar from '@/components/LeftSidebar';
import RightSidebar from '@/components/RightSidebar';
import { TestProviders } from './harness/providers';

let container: HTMLDivElement;
let root: Root;

function routeFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/categories')) return Promise.resolve({ ok: true, json: async () => ({ categories: [] }) });
      if (url.startsWith('/api/topics')) return Promise.resolve({ ok: true, json: async () => ({ topics: [] }) });
      if (url.startsWith('/api/stats')) return Promise.resolve({ ok: true, json: async () => ({}) });
      if (url.startsWith('/api/tags')) return Promise.resolve({ ok: true, json: async () => ({ tags: [] }) });
      if (url.startsWith('/api/feed')) return Promise.resolve({ ok: true, json: async () => ({ posts: [] }) });
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    }),
  );
}

async function render(ui: React.ReactElement) {
  // `LeftSidebar` (rendered directly here, and indirectly via
  // `CommunityLayout`) now reads copy through `useTranslation()` — see
  // src/lib/i18n/I18nProvider.tsx. Every render in this suite needs the
  // provider in the tree, same as the app root (src/app/layout.tsx).
  await act(async () => { root.render(<TestProviders initialLocale="en">{ui}</TestProviders>); });
  await act(async () => { await Promise.resolve(); });
}

function byTestId(id: string): HTMLElement[] {
  return Array.from(container.querySelectorAll(`[data-testid="${id}"]`));
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  routeFetch();
  railProps.current = null;
  railProps.mountCount = 0;
  pathnameMock.current = '/topics';
  try { window.localStorage.clear(); } catch {}
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

/*
 * THE WEB HAS NO CHAT ENTRY POINTS. This file used to enumerate them and prove
 * each opened the rail correctly; it now proves each is GONE, which is the
 * contract that has to hold.
 *
 * There were FOUR, and the fourth is why this file keeps its shape rather than
 * being deleted: the left-nav group, the header toggle, the bottom tab bar —
 * and "Open topic chat" in the RightSidebar, which only appears on a topic page
 * and was still shipping after the other three were removed. An enumeration is
 * what caught it. A deleted file would not have.
 *
 * WHY THEY WENT. A browser cannot read a room — the keys are on the phone and
 * never leave it. What it could do was join the group, advance an epoch and post
 * ciphertext nobody would ever open. And signing out cleared the session while
 * leaving the MLS state in IndexedDB, the leaf identity in `localStorage` and
 * the decrypted-picture cache on disk, so the next person at a shared machine
 * could read the previous person's conversation.
 */
describe('the web has no chat entry point, on any surface', () => {
  it('CONTRACT: the left-nav "Chat" entry is gone for a member', async () => {
    await render(<CommunityLayout isGuest={false} sessionChecked><div /></CommunityLayout>);
    expect(byTestId('left-nav-chat')[0]).toBeUndefined();
  });

  it('CONTRACT: the RightSidebar "Open topic chat" entry is gone on a topic page', async () => {
    // The one that survived the first three removals.
    await render(
      <CommunityLayout isGuest={false} sessionChecked topicId="t1" topicTitle="A topic">
        <div />
      </CommunityLayout>,
    );
    expect(byTestId('topic-open-chat')[0]).toBeUndefined();
  });

  it('MOUNT-UNIQUE: no ChatRail is mounted at all', async () => {
    await render(
      <CommunityLayout isGuest={false} sessionChecked topicId="t1" topicTitle="A topic">
        <div />
      </CommunityLayout>,
    );
    expect(byTestId('chat-rail')).toHaveLength(0);
  });

  it('AUTHZ: a guest sees none of them either', async () => {
    // Guest and member now agree about chat, which they did not before.
    await render(
      <CommunityLayout isGuest sessionChecked topicId="t1" topicTitle="A topic">
        <div />
      </CommunityLayout>,
    );
    expect(byTestId('left-nav-chat')[0]).toBeUndefined();
    expect(byTestId('topic-open-chat')[0]).toBeUndefined();
  });
});
