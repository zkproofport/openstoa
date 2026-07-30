// @vitest-environment jsdom
/**
 * `UserCard.tsx` — the peer profile popover wired onto avatars (PostCard,
 * the topic member list) that previously had no profile surface at all.
 *
 * Edge-case matrix rows covered here:
 *   authz    — self never gets a Message button; guest (viewerUserId=null)
 *              never gets one either, and never even checks candidacy
 *   contract — non-candidate (no shared topic) hides the button; a candidate
 *              shows it and clicking POSTs /api/dm then navigates to
 *              /dm/{topicId}
 *   boundary — omitted viewerUserId self-resolves via a SHARED session cache
 *              (one fetch across multiple cards, not one per card)
 *   UTF-8    — Korean + emoji nickname renders intact
 *   hostile  — a script-shaped nickname renders as text, never as an element
 *   large    — a very long nickname does not break rendering (CSS clips it)
 *   ui       — outside click and Escape both close the popover
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const pushMock = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
}));

const isDmCandidateMock = vi.hoisted(() => vi.fn(async (_userId: string) => false));
const invalidateDmCandidatesMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/dmCandidatesCache', () => ({
  isDmCandidate: (userId: string) => isDmCandidateMock(userId),
  invalidateDmCandidates: () => invalidateDmCandidatesMock(),
}));

import UserCard from '@/components/UserCard';
import { publishChatRailApi, __resetChatRailStore } from '@/lib/chatRailStore';
import { I18nProvider } from '@/lib/i18n/I18nProvider';

let container: HTMLDivElement;
let root: Root;

function json(body: unknown, ok = true) {
  return { ok, json: async () => body } as unknown as Response;
}

async function flush(times = 4) {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function trigger(): HTMLElement {
  return container.querySelector('[aria-haspopup="dialog"]') as HTMLElement;
}
function popover(): HTMLElement | null {
  return container.querySelector('[data-testid="user-card-popover"]');
}
function messageBtn(): HTMLButtonElement | null {
  return container.querySelector('[data-testid="user-card-message"]');
}
function selfNote(): HTMLElement | null {
  return container.querySelector('[data-testid="user-card-self-note"]');
}
function noBadgesNote(): HTMLElement | null {
  return container.querySelector('[data-testid="user-card-no-badges"]');
}
function notDmableNote(): HTMLElement | null {
  return container.querySelector('[data-testid="user-card-not-dmable"]');
}

/** Mounts UserCard with a rail API published to the module-level store
 *  (`chatRailStore.ts`, the mechanism `useChatRail()` now reads — see
 *  `chatRailContext.tsx`) so `startDm` takes the "land in the rail" path
 *  instead of the router.push fallback. `UserCard` now reads copy through
 *  `useTranslation()` — see src/lib/i18n/I18nProvider.tsx — so every render
 *  needs the provider in the tree, same as the app root (src/app/layout.tsx). */
async function mountWithRail(
  openRail: (room: unknown) => void,
  props: Partial<React.ComponentProps<typeof UserCard>> = {},
) {
  publishChatRailApi({ openRail: openRail as never });
  const merged = { userId: 'peer-1', nickname: 'bob', viewerUserId: 'viewer-1', ...props };
  await act(async () => {
    root.render(
      <I18nProvider initialLocale="en">
        <UserCard {...merged}>
          <span data-testid="avatar-slot">B</span>
        </UserCard>
      </I18nProvider>,
    );
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  pushMock.mockClear();
  isDmCandidateMock.mockClear();
  isDmCandidateMock.mockResolvedValue(false);
  invalidateDmCandidatesMock.mockClear();
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json({ userId: 'viewer-1' }))));
  // No rail published by default — most tests exercise the router.push
  // fallback path; `mountWithRail` opts a specific test into the rail path.
  __resetChatRailStore();
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
  __resetChatRailStore();
});

async function mount(props: Partial<React.ComponentProps<typeof UserCard>> = {}) {
  const merged = { userId: 'peer-1', nickname: 'bob', viewerUserId: 'viewer-1', ...props };
  await act(async () => {
    root.render(
      <I18nProvider initialLocale="en">
        <UserCard {...merged}>
          <span data-testid="avatar-slot">B</span>
        </UserCard>
      </I18nProvider>,
    );
  });
}

describe('open/close', () => {
  it('is closed by default and opens on trigger click', async () => {
    await mount();
    expect(popover()).toBeNull();

    await act(async () => { trigger().click(); });
    expect(popover()).not.toBeNull();
    expect(popover()!.textContent).toContain('bob');
  });

  it('closes on outside click', async () => {
    await mount();
    await act(async () => { trigger().click(); });
    expect(popover()).not.toBeNull();

    await act(async () => {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(popover()).toBeNull();
  });

  it('closes on Escape', async () => {
    await mount();
    await act(async () => { trigger().click(); });

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(popover()).toBeNull();
  });
});

describe('AUTHZ — Message button gating', () => {
  it('SELF: never shown when viewerUserId equals userId, and candidacy is never even checked', async () => {
    await mount({ userId: 'viewer-1', viewerUserId: 'viewer-1' });
    await act(async () => { trigger().click(); });
    await flush();

    expect(messageBtn()).toBeNull();
    expect(isDmCandidateMock).not.toHaveBeenCalled();
  });

  it('GUEST: viewerUserId=null never shows the button and never checks candidacy', async () => {
    await mount({ viewerUserId: null });
    await act(async () => { trigger().click(); });
    await flush();

    expect(messageBtn()).toBeNull();
    expect(isDmCandidateMock).not.toHaveBeenCalled();
  });

  it('CONTRACT: a non-candidate (no shared topic) hides the button', async () => {
    isDmCandidateMock.mockResolvedValue(false);
    await mount();
    await act(async () => { trigger().click(); });
    await flush();

    expect(isDmCandidateMock).toHaveBeenCalledWith('peer-1');
    expect(messageBtn()).toBeNull();
  });

  it('CONTRACT: a candidate shows the button; clicking starts a DM and navigates', async () => {
    isDmCandidateMock.mockResolvedValue(true);
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/dm') return Promise.resolve(json({ topicId: 'dm-topic-1' }));
      return Promise.resolve(json({ userId: 'viewer-1' }));
    });
    vi.stubGlobal('fetch', fetchMock);

    await mount();
    await act(async () => { trigger().click(); });
    await flush();

    expect(messageBtn()).not.toBeNull();
    await act(async () => { messageBtn()!.click(); });
    await flush();

    expect(fetchMock).toHaveBeenCalledWith('/api/dm', expect.objectContaining({ method: 'POST' }));
    expect(pushMock).toHaveBeenCalledWith('/dm/dm-topic-1');
    // FIX9: starting a DM invalidates the candidates cache immediately.
    expect(invalidateDmCandidatesMock).toHaveBeenCalledTimes(1);
  });
});

describe('boundary — self-resolving viewer session', () => {
  it('an omitted viewerUserId is resolved lazily via ONE shared session fetch for two cards', async () => {
    const fetchMock = vi.fn((_input?: RequestInfo | URL) => Promise.resolve(json({ userId: 'viewer-1' })));
    vi.stubGlobal('fetch', fetchMock);
    isDmCandidateMock.mockResolvedValue(true);

    const containerB = document.createElement('div');
    document.body.appendChild(containerB);
    const rootB = createRoot(containerB);

    await act(async () => {
      root.render(
        <I18nProvider initialLocale="en">
          <UserCard userId="peer-1" nickname="bob">
            <span>B</span>
          </UserCard>
        </I18nProvider>,
      );
      rootB.render(
        <I18nProvider initialLocale="en">
          <UserCard userId="peer-2" nickname="carol">
            <span>C</span>
          </UserCard>
        </I18nProvider>,
      );
    });

    await act(async () => { (container.querySelector('[aria-haspopup="dialog"]') as HTMLElement).click(); });
    await act(async () => { (containerB.querySelector('[aria-haspopup="dialog"]') as HTMLElement).click(); });
    await flush();

    const sessionCalls = fetchMock.mock.calls.filter((c) => String(c[0]) === '/api/auth/session');
    expect(sessionCalls.length).toBe(1);

    await act(async () => { rootB.unmount(); });
    containerB.remove();
  });
});

describe('content safety and i18n', () => {
  it('UTF-8: a Korean + emoji nickname renders intact', async () => {
    const nickname = '김철수 🚀 zk';
    await mount({ nickname });
    await act(async () => { trigger().click(); });

    expect(popover()!.textContent).toContain(nickname);
  });

  it('HOSTILE: a script-shaped nickname renders as text, never as an element', async () => {
    const nickname = '<script>alert(1)</script>';
    await mount({ nickname });
    await act(async () => { trigger().click(); });

    expect(container.querySelector('script')).toBeNull();
    expect(popover()!.textContent).toContain(nickname);
  });

  it('LARGE: a very long nickname still renders (CSS ellipsis, not data loss)', async () => {
    const nickname = 'a'.repeat(300);
    await mount({ nickname });
    await act(async () => { trigger().click(); });

    expect(popover()!.textContent).toContain(nickname);
  });

  it('badges render inside the popover', async () => {
    await mount({ badges: [{ type: 'kyc', label: 'KYC' }, { type: 'workspace', label: 'acme.com', domain: 'acme.com' }] });
    await act(async () => { trigger().click(); });

    expect(popover()!.textContent).toContain('KYC');
    expect(popover()!.textContent).toContain('acme.com');
  });

  it('the DM button reads "DM", not "Message"', async () => {
    isDmCandidateMock.mockResolvedValue(true);
    await mount();
    await act(async () => { trigger().click(); });
    await flush();

    expect(messageBtn()!.textContent).toBe('DM');
  });
});

describe('three honest end-states — self / no badges / not DM-able', () => {
  it('SELF: shows "This is you" and never a not-DM-able note, regardless of badges', async () => {
    await mount({ userId: 'viewer-1', viewerUserId: 'viewer-1' });
    await act(async () => { trigger().click(); });
    await flush();

    expect(selfNote()).not.toBeNull();
    expect(selfNote()!.textContent).toContain('This is you');
    expect(notDmableNote()).toBeNull();
    expect(messageBtn()).toBeNull();
  });

  it('NO BADGES: an empty badges array shows the explanatory note instead of a blank area', async () => {
    isDmCandidateMock.mockResolvedValue(true);
    await mount({ badges: [] });
    await act(async () => { trigger().click(); });
    await flush();

    expect(noBadgesNote()).not.toBeNull();
    expect(noBadgesNote()!.textContent).toContain('No badges yet');
  });

  it('NO BADGES: an omitted badges prop is treated the same as an empty array', async () => {
    isDmCandidateMock.mockResolvedValue(true);
    await mount({ badges: undefined });
    await act(async () => { trigger().click(); });
    await flush();

    expect(noBadgesNote()).not.toBeNull();
  });

  it('badges present → no "no badges" note', async () => {
    await mount({ badges: [{ type: 'kyc', label: 'KYC' }] });
    await act(async () => { trigger().click(); });
    await flush();

    expect(noBadgesNote()).toBeNull();
  });

  it('NOT DM-ABLE: a non-candidate (no shared topic) explains why, instead of a blank area where the button would be', async () => {
    isDmCandidateMock.mockResolvedValue(false);
    await mount();
    await act(async () => { trigger().click(); });
    await flush();

    expect(notDmableNote()).not.toBeNull();
    expect(notDmableNote()!.textContent).toContain('bob');
    expect(messageBtn()).toBeNull();
  });

  it('RACE: the not-DM-able note does not flash on before the candidacy check resolves', async () => {
    let resolveCheck: (v: boolean) => void = () => {};
    isDmCandidateMock.mockImplementation(() => new Promise((res) => { resolveCheck = res; }));
    await mount();
    await act(async () => { trigger().click(); });

    // Check still in flight — neither the button nor the "not DM-able" note
    // should be showing yet (that would be a false negative flash).
    expect(notDmableNote()).toBeNull();
    expect(messageBtn()).toBeNull();

    await act(async () => { resolveCheck(false); });
    await flush();
    expect(notDmableNote()).not.toBeNull();
  });

  it('GUEST: an unresolved/guest viewer shows neither the not-DM-able note nor the button', async () => {
    await mount({ viewerUserId: null });
    await act(async () => { trigger().click(); });
    await flush();

    expect(notDmableNote()).toBeNull();
    expect(messageBtn()).toBeNull();
    expect(selfNote()).toBeNull();
  });

  it('self AND no badges combine — both notes render, not a collapsed blank box', async () => {
    await mount({ userId: 'viewer-1', viewerUserId: 'viewer-1', badges: [] });
    await act(async () => { trigger().click(); });
    await flush();

    expect(selfNote()).not.toBeNull();
    expect(noBadgesNote()).not.toBeNull();
  });
});

describe('DM lands in the chat rail when one is reachable (see chatRailContext.tsx)', () => {
  it('CONTRACT: with a rail published, starting a DM calls openRail with the room and does NOT navigate', async () => {
    isDmCandidateMock.mockResolvedValue(true);
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/dm') return Promise.resolve(json({ topicId: 'dm-topic-1' }));
      return Promise.resolve(json({ userId: 'viewer-1' }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const openRail = vi.fn();

    await mountWithRail(openRail, { profileImage: 'https://example.com/a.png' });
    await act(async () => { trigger().click(); });
    await flush();
    await act(async () => { messageBtn()!.click(); });
    await flush();

    expect(openRail).toHaveBeenCalledWith({
      kind: 'dm',
      topicId: 'dm-topic-1',
      title: 'bob',
      profileImage: 'https://example.com/a.png',
    });
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('a null profileImage stays null (not undefined) in the room handed to openRail', async () => {
    isDmCandidateMock.mockResolvedValue(true);
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/dm') return Promise.resolve(json({ topicId: 'dm-topic-2' }));
      return Promise.resolve(json({ userId: 'viewer-1' }));
    }));
    const openRail = vi.fn();

    await mountWithRail(openRail);
    await act(async () => { trigger().click(); });
    await flush();
    await act(async () => { messageBtn()!.click(); });
    await flush();

    expect(openRail).toHaveBeenCalledWith(expect.objectContaining({ profileImage: null }));
  });
});
