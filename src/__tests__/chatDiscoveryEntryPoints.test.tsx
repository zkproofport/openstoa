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
import { I18nProvider } from '@/lib/i18n/I18nProvider';

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
  await act(async () => { root.render(<I18nProvider initialLocale="en">{ui}</I18nProvider>); });
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

describe('CommunityLayout — left-nav "Chat" entry (list)', () => {
  it('CONTRACT: clicking it opens the rail with a room: null request (the list)', async () => {
    await render(<CommunityLayout isGuest={false} sessionChecked={true}><div /></CommunityLayout>);

    // Not open yet — no rail mounted.
    expect(byTestId('chat-rail')).toHaveLength(0);

    const chatBtn = byTestId('left-nav-chat')[0] as HTMLButtonElement;
    expect(chatBtn).toBeDefined();
    await act(async () => { chatBtn.click(); });

    expect(byTestId('chat-rail')).toHaveLength(1);
    expect(railProps.current).toMatchObject({ openRequest: { room: null, nonce: 1 } });
  });

  it('AUTHZ: a guest sees no "Chat" entry at all (not a disabled one)', async () => {
    await render(<CommunityLayout isGuest={true} sessionChecked={true}><div /></CommunityLayout>);

    expect(byTestId('left-nav-chat')).toHaveLength(0);
  });

  it('MOUNT-UNIQUE: exactly one ChatRail is ever mounted, however the rail was opened', async () => {
    await render(<CommunityLayout isGuest={false} sessionChecked={true}><div /></CommunityLayout>);
    await act(async () => { (byTestId('left-nav-chat')[0] as HTMLButtonElement).click(); });

    expect(byTestId('chat-rail')).toHaveLength(1);
  });

  it('REPEAT: clicking the SAME entry point twice advances the request nonce both times', async () => {
    await render(<CommunityLayout isGuest={false} sessionChecked={true}><div /></CommunityLayout>);
    const chatBtn = byTestId('left-nav-chat')[0] as HTMLButtonElement;

    await act(async () => { chatBtn.click(); });
    expect(railProps.current).toMatchObject({ openRequest: { room: null, nonce: 1 } });

    await act(async () => { chatBtn.click(); });
    expect(railProps.current).toMatchObject({ openRequest: { room: null, nonce: 2 } });
  });
});

describe('CommunityLayout — RightSidebar "Open topic chat" entry (topic-specific)', () => {
  it('CONTRACT: clicking it opens the rail requesting THAT exact topic room', async () => {
    await render(
      <CommunityLayout
        isGuest={false}
        sessionChecked={true}
        topicId="t1"
        topicTitle="Zoning Law"
        topicDescription="desc"
        topicMemberCount={4}
      >
        <div />
      </CommunityLayout>,
    );

    const btn = byTestId('topic-open-chat')[0] as HTMLButtonElement;
    expect(btn).toBeDefined();
    await act(async () => { btn.click(); });

    expect(byTestId('chat-rail')).toHaveLength(1);
    expect(railProps.current).toMatchObject({
      openRequest: { room: { kind: 'topic', topicId: 't1', title: 'Zoning Law' }, nonce: 1 },
    });
  });

  it('UTF-8: a Korean + emoji topic title survives into the request unmodified', async () => {
    const title = '법률 상담 🏛️ zk';
    await render(
      <CommunityLayout isGuest={false} sessionChecked={true} topicId="t1" topicTitle={title}>
        <div />
      </CommunityLayout>,
    );

    await act(async () => { (byTestId('topic-open-chat')[0] as HTMLButtonElement).click(); });

    expect(railProps.current).toMatchObject({ openRequest: { room: { topicId: 't1', title } } });
  });

  it('EMPTY: on a non-topic page (no topicId/topicTitle) the entry is simply absent', async () => {
    await render(<CommunityLayout isGuest={false} sessionChecked={true}><div /></CommunityLayout>);

    expect(byTestId('topic-open-chat')).toHaveLength(0);
  });

  it('AUTHZ: a guest sees no "Open topic chat" entry even on a topic page', async () => {
    await render(
      <CommunityLayout isGuest={true} sessionChecked={true} topicId="t1" topicTitle="Zoning Law">
        <div />
      </CommunityLayout>,
    );

    expect(byTestId('topic-open-chat')).toHaveLength(0);
  });
});

describe('LeftSidebar — in isolation', () => {
  it('renders the Chat entry only when onOpenChat is passed, and invokes it on click', async () => {
    const onOpenChat = vi.fn();
    await render(
      <LeftSidebar isGuest={false} sessionChecked={true} onOpenChat={onOpenChat} />,
    );

    const btn = byTestId('left-nav-chat')[0] as HTMLButtonElement;
    expect(btn).toBeDefined();
    await act(async () => { btn.click(); });
    expect(onOpenChat).toHaveBeenCalledTimes(1);
  });

  it('EMPTY: renders nothing for the Chat entry when onOpenChat is omitted', async () => {
    await render(<LeftSidebar isGuest={false} sessionChecked={true} />);

    expect(byTestId('left-nav-chat')).toHaveLength(0);
  });
});

describe('RightSidebar — in isolation', () => {
  it('renders "Open topic chat" only with a topic in view AND onOpenChat passed, and invokes it on click', async () => {
    const onOpenChat = vi.fn();
    await render(
      <RightSidebar topicId="t1" topicTitle="Zoning Law" onOpenChat={onOpenChat} />,
    );

    const btn = byTestId('topic-open-chat')[0] as HTMLButtonElement;
    expect(btn).toBeDefined();
    await act(async () => { btn.click(); });
    expect(onOpenChat).toHaveBeenCalledTimes(1);
  });

  it('EMPTY: no topic in view -> no "Open topic chat" entry even if onOpenChat is passed', async () => {
    const onOpenChat = vi.fn();
    await render(<RightSidebar onOpenChat={onOpenChat} />);

    expect(byTestId('topic-open-chat')).toHaveLength(0);
  });

  it('renders nothing for the entry when onOpenChat is omitted, even with a topic in view', async () => {
    await render(<RightSidebar topicId="t1" topicTitle="Zoning Law" />);

    expect(byTestId('topic-open-chat')).toHaveLength(0);
  });
});
