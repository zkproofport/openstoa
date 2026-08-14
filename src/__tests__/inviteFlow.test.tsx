// @vitest-environment jsdom
/**
 * The invite flow end to end on the web: minting a token, deciding what the
 * link carries, landing on it, and getting the keys into the recipient's
 * keychain — without any of them reaching the server.
 *
 * That last clause is the whole design, so it is asserted directly rather than
 * inferred: every request either surface makes is captured, and no key material
 * may appear in a URL or a body.
 *
 * Edge-case matrix rows (test names carry the row):
 *   contract-invocation — the button MINTS a token (it used to copy a link that
 *                         mints nothing, which 403s on the invite-only tiers);
 *                         the join page POSTs the code and imports AFTER 201
 *   integrity           — keys travel only in the fragment; never in a URL, a
 *                         body, or the link shown on screen
 *   authz               — guest sees sign-in and keeps the fragment across it;
 *                         an expired token imports NOTHING; an existing member
 *                         does not double-join
 *   boundary            — 0 epochs shared, 1, the ceiling; 0 imported vs many
 *   empty               — no fragment at all; an inviter holding no history
 *   hostile             — a fragment tagged for another topic is refused
 *   race                — a double-clicked button issues exactly ONE request
 *   ui                  — public/DM are offered no history control at all
 *   integrity           — the hash is cleared from the address bar after import
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import enLocale from '@/lib/i18n/locales/en.json';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TOPIC = '11111111-2222-4333-8444-555555555555';
const OTHER_TOPIC = '99999999-8888-4777-8666-555555555555';
const KEY = (n: number) => Buffer.alloc(32, n).toString('base64');

// ─── Doubles ─────────────────────────────────────────────────────────────────

const takMock = vi.hoisted(() => ({
  exportInviteHistory: vi.fn(async () => ({ 7: 'K1', 6: 'K2', 5: 'K3' }) as Record<number, string>),
  importInviteHistory: vi.fn(async () => 0),
}));
const archiveMock = vi.hoisted(() => ({
  getArchive: vi.fn(async () => [] as Array<{ takVersion: number; createdAt: string }>),
}));

vi.mock('@/lib/mls/webTransport', () => ({
  getTakSessionStore: () => takMock,
  getTakTransport: () => archiveMock,
}));

const routerMock = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
const paramsMock = vi.hoisted(() => ({ current: {} as Record<string, string> }));

vi.mock('next/navigation', () => ({
  useRouter: () => routerMock,
  useParams: () => paramsMock.current,
  usePathname: () => '/topics/join/tok123',
  useSearchParams: () => new URLSearchParams(),
}));

// The app shell pulls categories/tags/stats and its own chat panel; none of
// that is what this file is about.
vi.mock('@/components/CommunityLayout', () => ({
  default: ({ children }: { children: React.ReactNode }) => React.createElement('div', null, children),
}));

const { default: InviteDialog } = await import('@/components/InviteDialog');
const { default: InviteJoinPage } = await import('@/app/topics/join/[inviteCode]/page');
const { I18nProvider } = await import('@/lib/i18n/I18nProvider');

// ─── Harness ─────────────────────────────────────────────────────────────────

let container: HTMLDivElement;
let root: Root;
/** Every request either surface made, so "the keys never went out" is checkable. */
let requests: Array<{ url: string; body: string }>;
let clipboard: string[];

function render(node: React.ReactElement) {
  act(() => {
    root.render(React.createElement(I18nProvider, { initialLocale: 'en', children: node }));
  });
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  });
}

function click(el: Element | null) {
  expect(el).not.toBeNull();
  act(() => {
    el!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function byText(text: string): Element | null {
  return [...container.querySelectorAll('button, a')].find((el) => el.textContent?.includes(text)) ?? null;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  requests = [];
  clipboard = [];
  takMock.exportInviteHistory.mockClear();
  takMock.importInviteHistory.mockClear();
  takMock.importInviteHistory.mockResolvedValue(0);
  archiveMock.getArchive.mockClear();
  archiveMock.getArchive.mockResolvedValue([]);
  routerMock.push.mockClear();
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async (t: string) => void clipboard.push(t) },
  });
  window.history.replaceState(null, '', '/topics/join/tok123');
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

/** A fetch double that records every call and answers from a route table. */
function stubFetch(routes: Record<string, { status: number; body: unknown }>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({ url, body: typeof init?.body === 'string' ? init.body : '' });
      const match = Object.keys(routes).find((k) => url.includes(k));
      const r = match ? routes[match] : { status: 404, body: { error: 'not found' } };
      return {
        ok: r.status >= 200 && r.status < 300,
        status: r.status,
        json: async () => r.body,
      } as Response;
    }),
  );
}

/** No key material anywhere the server can see it. */
function expectNoKeysOnTheWire(keys: string[]) {
  for (const req of requests) {
    for (const k of keys) {
      expect(req.url, `key in URL: ${req.url}`).not.toContain(k);
      expect(req.body, `key in body: ${req.body}`).not.toContain(k);
    }
  }
}

// ─── The dialog: minting and deciding ────────────────────────────────────────

describe('InviteDialog', () => {
  it('CONTRACT-INVOCATION: copying MINTS a token and links to /topics/join/{token}', async () => {
    /*
     * The regression this exists for: the button used to copy
     * `/topics/{id}/join` without calling the invite API at all. That route is
     * 403 for private and secret — exactly the tiers whose members reach for
     * an invite — so the link could not work for anyone it was meant for.
     */
    stubFetch({ '/invite': { status: 201, body: { token: 'tok123', expiresAt: '2026-08-20T00:00:00.000Z' } } });
    render(<InviteDialog topicId={TOPIC} visibility="private" open onClose={() => {}} />);
    await flush();

    click(byText(enLocale.invite.copyLink));
    await flush();

    expect(requests.map((r) => r.url)).toContain(`/api/topics/${TOPIC}/invite`);
    expect(clipboard[0]).toContain(`/topics/join/tok123`);
  });

  it('INTEGRITY: the keys go in the FRAGMENT and never on the wire', async () => {
    takMock.exportInviteHistory.mockResolvedValue({ 7: KEY(1), 6: KEY(2) });
    stubFetch({ '/invite': { status: 201, body: { token: 'tok123', expiresAt: null } } });
    render(<InviteDialog topicId={TOPIC} visibility="secret" open onClose={() => {}} />);
    await flush();

    click(byText(enLocale.invite.copyLink));
    await flush();

    const [before, fragment] = clipboard[0].split('#');
    expect(before).toContain('/topics/join/tok123');
    expect(before).not.toContain(KEY(1));
    expect(fragment).toContain(KEY(1));
    expectNoKeysOnTheWire([KEY(1), KEY(2)]);
  });

  it('INTEGRITY: the link SHOWN on screen is stripped of its keys', async () => {
    // An invite ends up in a screenshot or a support ticket. The token can be
    // revoked; the keys cannot.
    takMock.exportInviteHistory.mockResolvedValue({ 7: KEY(1) });
    stubFetch({ '/invite': { status: 201, body: { token: 'tok123', expiresAt: null } } });
    render(<InviteDialog topicId={TOPIC} visibility="private" open onClose={() => {}} />);
    await flush();
    click(byText(enLocale.invite.copyLink));
    await flush();

    const shown = container.querySelector('[data-testid="invite-link"]')!.textContent!;
    expect(shown).toContain('/topics/join/tok123');
    expect(shown).not.toContain('#');
    expect(shown).not.toContain(KEY(1));
  });

  it('UI: a PUBLIC topic is offered no history control and its link carries none', async () => {
    // `inviteHistoryEpochs` returns 0 for public, so a control here would do
    // nothing. Not offering it beats offering a dead one.
    stubFetch({ '/invite': { status: 201, body: { token: 'tok123', expiresAt: null } } });
    render(<InviteDialog topicId={TOPIC} visibility="public" open onClose={() => {}} />);
    await flush();

    expect(container.querySelector('#invite-history-epochs')).toBeNull();
    expect(takMock.exportInviteHistory).not.toHaveBeenCalled();
    expect(container.textContent).toContain(enLocale.invite.historyPublic);

    click(byText(enLocale.invite.copyLink));
    await flush();
    expect(clipboard[0]).not.toContain('#');
  });

  it('EMPTY: an inviter who holds no history is told so, not shown a dead control', async () => {
    takMock.exportInviteHistory.mockResolvedValue({});
    render(<InviteDialog topicId={TOPIC} visibility="private" open onClose={() => {}} />);
    await flush();

    expect(container.querySelector('#invite-history-epochs')).toBeNull();
    expect(container.textContent).toContain(enLocale.invite.historyUnavailable);
  });

  it('BOUNDARY: the default is the DEFAULT epoch count, described in messages', async () => {
    takMock.exportInviteHistory.mockResolvedValue({ 7: KEY(1), 6: KEY(2), 5: KEY(3), 4: KEY(4) });
    archiveMock.getArchive.mockResolvedValue([
      { takVersion: 7, createdAt: '2026-08-13T00:00:00.000Z' },
      { takVersion: 6, createdAt: '2026-08-12T00:00:00.000Z' },
      { takVersion: 5, createdAt: '2026-08-11T00:00:00.000Z' },
      // Epoch 4 is held but outside the default window of 3.
      { takVersion: 4, createdAt: '2026-08-01T00:00:00.000Z' },
    ]);
    render(<InviteDialog topicId={TOPIC} visibility="private" open onClose={() => {}} />);
    await flush();

    const select = container.querySelector('#invite-history-epochs') as HTMLSelectElement;
    expect(select.value).toBe('3');
    // Three epochs, one message each — and the window starts at the OLDEST of
    // those three, not at the oldest row in the archive.
    expect(container.textContent).toContain('the last 3 messages');
    expect(container.textContent).toContain('August 11');
  });

  it('BOUNDARY: choosing to share NOTHING is a real choice and drops the fragment', async () => {
    takMock.exportInviteHistory.mockResolvedValue({ 7: KEY(1) });
    stubFetch({ '/invite': { status: 201, body: { token: 'tok123', expiresAt: null } } });
    render(<InviteDialog topicId={TOPIC} visibility="private" open onClose={() => {}} />);
    await flush();

    const select = container.querySelector('#invite-history-epochs') as HTMLSelectElement;
    act(() => {
      select.value = '0';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();
    expect(container.textContent).toContain(enLocale.invite.historyNoneSummary);

    click(byText(enLocale.invite.copyLink));
    await flush();
    expect(clipboard[0]).not.toContain('#');
    expect(clipboard[0]).not.toContain(KEY(1));
  });

  it('RACE: a double-clicked copy mints exactly ONE token', async () => {
    stubFetch({ '/invite': { status: 201, body: { token: 'tok123', expiresAt: null } } });
    render(<InviteDialog topicId={TOPIC} visibility="private" open onClose={() => {}} />);
    await flush();

    const btn = byText(enLocale.invite.copyLink)!;
    act(() => {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    expect(requests.filter((r) => r.url.endsWith('/invite'))).toHaveLength(1);
  });

  it('EXT-FAILURE: a 403 from the invite route is shown, not swallowed', async () => {
    stubFetch({ '/invite': { status: 403, body: { error: 'Only the topic owner or an admin can invite to this topic' } } });
    render(<InviteDialog topicId={TOPIC} visibility="secret" open onClose={() => {}} />);
    await flush();
    click(byText(enLocale.invite.copyLink));
    await flush();

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('owner or an admin');
    expect(clipboard).toHaveLength(0);
  });
});

// ─── Where the button lives ──────────────────────────────────────────────────

describe('the pages that offer an invite', () => {
  const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8');
  // `page.tsx` is now a thin server wrapper (`generateMetadata` for the
  // dynamic-OG split) — the actual JSX these source-text scans check for
  // lives in `TopicPageClient.tsx`.
  const TOPIC_PAGE = 'src/app/topics/[topicId]/TopicPageClient.tsx';
  const MEMBERS_PAGE = 'src/app/topics/[topicId]/members/page.tsx';

  it('CONTRACT-INVOCATION: neither page copies a link of its own any more', () => {
    /*
     * The defect: both pages copied `${origin}/topics/${topicId}/join` without
     * calling the invite API, so the link minted no token — and that route is
     * 403 for private and secret. Minting belongs to one component now.
     */
    for (const page of [TOPIC_PAGE, MEMBERS_PAGE]) {
      const src = read(page);
      expect(src, page).toContain('<InviteDialog');
      expect(src, page).not.toContain('clipboard.writeText');
      expect(src, page).not.toContain('/topics/${topicId}/join`;');
    }
  });

  it('AUTHZ: a plain member is not offered an invite on a non-public topic', () => {
    // The route refuses them (owner/admin only outside `public`), and a control
    // that always fails is worse than an absent one — the same rule the missing
    // Leave button follows.
    for (const page of [TOPIC_PAGE, MEMBERS_PAGE]) {
      const src = read(page);
      expect(src, page).toMatch(
        /topic\.visibility === 'public' \|\| currentUserRole === 'owner' \|\| currentUserRole === 'admin'/,
      );
    }
  });
});

// ─── The join page: landing and importing ────────────────────────────────────

describe('the invite landing page', () => {
  beforeEach(() => {
    paramsMock.current = { inviteCode: 'tok123' };
  });

  function setHash(fragment: string) {
    window.history.replaceState(null, '', `/topics/join/tok123#${fragment}`);
  }

  const goodFragment = `h1=7.${KEY(1)}~6.${KEY(2)}&t=${TOPIC}`;

  it('CONTRACT: joins, then imports the keys, and never sends them', async () => {
    setHash(goodFragment);
    takMock.importInviteHistory.mockResolvedValue(2);
    stubFetch({
      '/api/topics/join/tok123': { status: 200, body: { topic: { id: TOPIC, title: 'Room' }, isMember: false } },
    });
    render(<InviteJoinPage />);
    await flush();

    // The POST answers 201 from the same route entry.
    stubFetch({ '/api/topics/join/tok123': { status: 201, body: { success: true, topicId: TOPIC } } });
    click(byText(enLocale.inviteJoin.join));
    await flush();

    expect(takMock.importInviteHistory).toHaveBeenCalledWith(TOPIC, { 7: KEY(1), 6: KEY(2) });
    expect(container.querySelector('[data-testid="invite-history-line"]')?.textContent).toContain('2 sessions');
    expectNoKeysOnTheWire([KEY(1), KEY(2)]);
    for (const req of requests) expect(req.url).not.toContain('h1=');
  });

  it('INTEGRITY: the hash is cleared from the address bar after import', async () => {
    // Otherwise it sits in history, and in the URL the next person copies when
    // they share "the link I used".
    setHash(goodFragment);
    takMock.importInviteHistory.mockResolvedValue(2);
    stubFetch({ '/api/topics/join/tok123': { status: 200, body: { topic: { id: TOPIC, title: 'Room' }, isMember: false } } });
    render(<InviteJoinPage />);
    await flush();
    stubFetch({ '/api/topics/join/tok123': { status: 201, body: { success: true, topicId: TOPIC } } });
    click(byText(enLocale.inviteJoin.join));
    await flush();

    expect(window.location.hash).toBe('');
    expect(window.location.pathname).toBe('/topics/join/tok123');
  });

  it('BOUNDARY: re-opening the same link says "already have it", not "2 more"', async () => {
    setHash(goodFragment);
    takMock.importInviteHistory.mockResolvedValue(0);
    stubFetch({ '/api/topics/join/tok123': { status: 200, body: { topic: { id: TOPIC, title: 'Room' }, isMember: true } } });
    render(<InviteJoinPage />);
    await flush();

    expect(container.querySelector('[data-testid="invite-history-line"]')?.textContent).toBe(
      enLocale.inviteJoin.historyAlready,
    );
  });

  it('AUTHZ: an existing member is not re-joined, and no POST is made', async () => {
    setHash(goodFragment);
    stubFetch({ '/api/topics/join/tok123': { status: 200, body: { topic: { id: TOPIC, title: 'Room' }, isMember: true } } });
    render(<InviteJoinPage />);
    await flush();

    expect(byText(enLocale.inviteJoin.join)).toBeNull();
    expect(requests.filter((r) => r.body !== '')).toHaveLength(0);
    expect(container.textContent).toContain(enLocale.inviteJoin.memberLabel);
  });

  it('AUTHZ: an EXPIRED token with a valid fragment imports NOTHING', async () => {
    /*
     * The keys would otherwise be written into the keychain for a topic this
     * device is not a member of and cannot leave.
     */
    setHash(goodFragment);
    stubFetch({ '/api/topics/join/tok123': { status: 404, body: { error: 'Invalid invite code' } } });
    render(<InviteJoinPage />);
    await flush();

    expect(takMock.importInviteHistory).not.toHaveBeenCalled();
    expect(container.textContent).toContain(enLocale.inviteJoin.invalidTitle);
  });

  it('HOSTILE: a fragment tagged for ANOTHER topic is refused and explained', async () => {
    setHash(`h1=7.${KEY(1)}&t=${OTHER_TOPIC}`);
    stubFetch({ '/api/topics/join/tok123': { status: 200, body: { topic: { id: TOPIC, title: 'Room' }, isMember: false } } });
    render(<InviteJoinPage />);
    await flush();
    stubFetch({ '/api/topics/join/tok123': { status: 201, body: { success: true, topicId: TOPIC } } });
    click(byText(enLocale.inviteJoin.join));
    await flush();

    expect(takMock.importInviteHistory).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="invite-history-line"]')?.textContent).toBe(
      enLocale.inviteJoin.historyWrongTopic,
    );
  });

  it('EMPTY: a link with no fragment joins fine and says history was not shared', async () => {
    stubFetch({ '/api/topics/join/tok123': { status: 200, body: { topic: { id: TOPIC, title: 'Room' }, isMember: false } } });
    render(<InviteJoinPage />);
    await flush();
    stubFetch({ '/api/topics/join/tok123': { status: 201, body: { success: true, topicId: TOPIC } } });
    click(byText(enLocale.inviteJoin.join));
    await flush();

    expect(takMock.importInviteHistory).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="invite-history-line"]')?.textContent).toBe(
      enLocale.inviteJoin.historyNone,
    );
  });

  it('AUTHZ + GUEST: a signed-out visitor is offered sign-in that KEEPS the fragment', async () => {
    /*
     * The failure this pins: `/topics` is guest-accessible, so the visitor
     * lands here with the keys still on the URL — and a plain href to the
     * sign-in page drops them. They would then join and find an empty room
     * with nothing said about it.
     */
    setHash(goodFragment);
    stubFetch({ '/api/topics/join/tok123': { status: 401, body: { error: 'Not authenticated' } } });
    render(<InviteJoinPage />);
    await flush();

    const link = container.querySelector('[data-testid="invite-signin"]') as HTMLAnchorElement;
    expect(link).not.toBeNull();
    expect(link.getAttribute('href')).toContain(encodeURIComponent('/topics/join/tok123'));

    // Clicking navigates by hand, WITH the fragment attached.
    const assigned: string[] = [];
    const original = Object.getOwnPropertyDescriptor(window, 'location')!;
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, hash: `#${goodFragment}`, set href(v: string) { assigned.push(v); } },
    });
    click(link);
    Object.defineProperty(window, 'location', original);

    expect(assigned).toHaveLength(1);
    expect(assigned[0]).toContain(`#${goodFragment}`);
    expect(assigned[0]).toContain(encodeURIComponent('/topics/join/tok123'));
  });

  it('RACE: a double-clicked Join posts exactly once', async () => {
    stubFetch({ '/api/topics/join/tok123': { status: 200, body: { topic: { id: TOPIC, title: 'Room' }, isMember: false } } });
    render(<InviteJoinPage />);
    await flush();
    stubFetch({ '/api/topics/join/tok123': { status: 201, body: { success: true, topicId: TOPIC } } });

    const btn = byText(enLocale.inviteJoin.join)!;
    act(() => {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    expect(requests.filter((r) => r.body === '{}')).toHaveLength(1);
  });

  it('a 409 lands on the member state rather than an error', async () => {
    // Another tab, or a second tap that beat the guard.
    setHash(goodFragment);
    takMock.importInviteHistory.mockResolvedValue(1);
    stubFetch({ '/api/topics/join/tok123': { status: 200, body: { topic: { id: TOPIC, title: 'Room' }, isMember: false } } });
    render(<InviteJoinPage />);
    await flush();
    stubFetch({ '/api/topics/join/tok123': { status: 409, body: { error: 'Already a member of this topic' } } });
    click(byText(enLocale.inviteJoin.join));
    await flush();

    expect(container.textContent).toContain(enLocale.inviteJoin.memberLabel);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('UTF-8 + HOSTILE: a Korean, emoji and script-shaped title renders as text', async () => {
    stubFetch({
      '/api/topics/join/tok123': {
        status: 200,
        body: { topic: { id: TOPIC, title: '한글 🌟 <script>alert(1)</script>' }, isMember: false },
      },
    });
    render(<InviteJoinPage />);
    await flush();

    expect(container.textContent).toContain('한글 🌟 <script>alert(1)</script>');
    expect(container.querySelector('script')).toBeNull();
  });
});
