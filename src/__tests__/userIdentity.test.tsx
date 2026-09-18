// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { TestProviders, makeTestQueryClient, flushQueries } from './harness/providers';
import { sessionKeys } from '@/lib/queryKeys';
import { fetchSession, useSession, writeStoredSession, SESSION_STORAGE_KEY } from '@/lib/useSession';
import { recordPublicBadgeMutation, resetPublicBadgeMutation, type PublicBadge } from '@/lib/publicBadgeState';
import UserIdentity from '@/components/UserIdentity';
import BadgeVisibilitySettings from '@/components/BadgeVisibilitySettings';
import PostCard from '@/components/PostCard';
import PostDetailClient from '@/app/topics/[topicId]/posts/[postId]/PostDetailClient';

vi.mock('next/navigation', () => ({
  useParams: () => ({ topicId: 'topic', postId: 'post' }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/topics/topic/posts/post',
}));
vi.mock('@/components/CommunityLayout', () => ({ default: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/SNSEditor', () => ({ default: () => null }));
vi.mock('@/components/SNSContent', () => ({ default: ({ html }: { html: string }) => <div>{html}</div> }));
vi.mock('@/components/TagInput', () => ({ default: () => null }));
vi.mock('@/components/PollEditor', () => ({ default: () => null }));
vi.mock('@/components/PollRenderer', () => ({ default: () => null }));
vi.mock('@/components/post/PostActionBar', () => ({ default: () => null }));
vi.mock('@/components/post/ReactionRow', () => ({ default: () => null }));
vi.mock('@/components/post/MediaGallery', () => ({ default: () => null }));
vi.mock('@/components/ImageLightbox', () => ({ default: () => <div data-testid="lightbox" /> }));
vi.mock('@/components/PostRecordsSection', () => ({ PostRecordsSection: () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const ALL: PublicBadge[] = [
  { type: 'kyc', label: 'KYC' }, { type: 'country', label: 'Country' },
  { type: 'workspace', label: 'org.example', domain: 'org.example' }, { type: 'oidc', label: 'OIDC' },
];
let root: Root;
let container: HTMLDivElement;
let queryClient: ReturnType<typeof makeTestQueryClient>;
let calls: string[];
let session: { userId: string; nickname: string; badges: PublicBadge[] };
const post = { id: 'post', authorId: 'peer', authorNickname: '동료', authorProfileImage: '/photo.png',
  title: 'Post', content: 'Body', topicId: 'topic', createdAt: '2026-09-18T00:00:00Z',
  upvoteCount: 0, viewCount: 0, commentCount: 2, badges: ALL, isAI: true };
let ownerInventory = [
  { type: 'kyc', visible: true }, { type: 'country', visible: true },
  { type: 'oidc_domain', visible: true }, { type: 'oidc_login', visible: true },
];

beforeEach(() => {
  resetPublicBadgeMutation();
  localStorage.clear();
  session = { userId: 'self', nickname: '나', badges: [...ALL] };
  ownerInventory = ownerInventory.map(b => ({ ...b, visible: true }));
  calls = [];
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  queryClient = makeTestQueryClient();
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    calls.push(String(input));
    if (input === '/api/auth/session') return Response.json(session);
    if (input === '/api/profile/badges') {
      if (init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body));
        ownerInventory = ownerInventory.map(b => b.type === body.type ? { ...b, visible: body.visible } : b);
        const visible = new Set(ownerInventory.filter(b => b.visible).map(b => ({ oidc_login: 'oidc', oidc_domain: 'workspace' }[b.type] ?? b.type)));
        session = { ...session, badges: ALL.filter(b => visible.has(b.type)) };
        return Response.json({ success: true, ...body, userId: session.userId, publicBadges: session.badges });
      }
      return Response.json({ badges: ownerInventory, userId: session.userId, publicBadges: session.badges });
    }
    if (input === '/api/posts/post') return Response.json({ post, comments: [
      { id: 'comment', authorId: 'commenter', authorNickname: '댓글 작성자', content: 'Hello', createdAt: post.createdAt, badges: ALL },
      { id: 'deleted', authorId: null, authorNickname: null, content: '', createdAt: post.createdAt, isDeleted: true, deletedBy: 'admin', badges: [] },
    ] });
    if (String(input).startsWith('/api/topics/topic')) return Response.json({ topic: { id: 'topic', creatorId: 'peer', title: 'Topic', proofType: 'country' }, members: [], currentUserRole: 'member' });
    if (input === '/api/posts/post/vote') return Response.json({ userVoted: null });
    if (input === '/api/posts/post/reactions') return Response.json({ reactions: [] });
    if (input === '/api/posts/post/bookmark') return Response.json({ bookmarked: false });
    if (input === '/api/posts/post/records') return Response.json({ recordCount: 0 });
    return new Response('{}', { status: 404 });
  }));
});
afterEach(async () => {
  await act(async () => root.unmount());
  queryClient.clear();
  container.remove();
  resetPublicBadgeMutation();
  vi.unstubAllGlobals();
});
async function render(children: React.ReactNode) {
  await act(async () => root.render(<TestProviders initialLocale="ko" queryClient={queryClient}>{children}</TestProviders>));
  await flushQueries();
}
function types(userId: string) {
  return [...container.querySelectorAll(`[data-user-identity="${userId}"] [data-badge-type]`)].map(n => n.getAttribute('data-badge-type'));
}

function OwnIdentities({ count = 2 }: { count?: number }) {
  const { session: current } = useSession();
  return <>{Array.from({ length: count }, (_, i) => <UserIdentity key={i}
    userId={current?.userId} nickname={current?.nickname ?? ''} badges={current?.badges} interactive={false} />)}</>;
}

describe('shared public user identity', () => {
  it('feed shows every enabled peer proof including login/OIDC and preserves AI attribution without opening a card', async () => {
    await render(<PostCard post={post} href="/topics/topic/posts/post" showAuthor />);
    expect(types('peer')).toEqual(['ai', 'kyc', 'country', 'workspace', 'oidc']);
    expect(container.textContent).toContain('로그인 인증');
    expect(container.querySelector('a')?.getAttribute('href')).toBe('/topics/topic/posts/post');
    expect(container.querySelector('[data-testid="user-card-no-badges"]')).toBeNull();
  });

  it('post detail and comments show the same peer badge set regardless of topic requirement and redact deleted authors', async () => {
    await render(<PostDetailClient />);
    expect(types('peer')).toEqual(['ai', 'kyc', 'country', 'workspace', 'oidc']);
    expect(types('commenter')).toEqual(['kyc', 'country', 'workspace', 'oidc']);
    expect(container.querySelectorAll('[data-user-identity]')).toHaveLength(2);
    expect(container.textContent).toContain('관리자가 삭제한 댓글');
    await act(async () => container.querySelector<HTMLElement>('[data-user-identity="peer"] [role="button"]')!.click());
    expect(container.querySelector('[data-testid="lightbox"]')).not.toBeNull();
    await act(async () => container.querySelector<HTMLElement>('[data-user-identity="peer"] [aria-haspopup="dialog"]')!.click());
    expect(container.querySelector('[data-testid="user-card-popover"]')).not.toBeNull();
  });

  it.each([[0, 'kyc'], [1, 'country'], [2, 'workspace'], [3, 'oidc']] as const)('individual OFF %s/%s updates own identities and shared session cache without touching peer badges', async (index, disabledType) => {
    queryClient.setQueryData(sessionKeys.current(), session);
    await render(<>
      <BadgeVisibilitySettings />
      <OwnIdentities />
      <UserIdentity userId="peer" nickname="동료" badges={ALL} interactive={false} />
    </>);
    const toggle = container.querySelectorAll<HTMLButtonElement>('[role="switch"]')[index];
    await act(async () => toggle.click());
    await flushQueries();
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    const expected = ALL.filter(b => b.type !== disabledType).map(b => b.type);
    expect(types('self')).toEqual([...expected, ...expected]);
    expect(types('peer')).toEqual(['kyc', 'country', 'workspace', 'oidc']);
    expect(queryClient.getQueryData<{ badges: PublicBadge[] }>(sessionKeys.current())?.badges.map(b => b.type)).toEqual(expected);
    expect(JSON.parse(localStorage.getItem(SESSION_STORAGE_KEY)!).badges).toHaveLength(3);
    expect(calls.filter(url => url === '/api/profile/badges')).toHaveLength(2);
    expect(calls.some(url => url.includes('/profile/') && url !== '/api/profile/badges')).toBe(false);
  });

  it('fresh supplied [] wins even when an older own-session or mutation snapshot says ON', async () => {
    queryClient.setQueryData(sessionKeys.current(), session);
    recordPublicBadgeMutation('self', ALL);
    await render(<UserIdentity userId="self" nickname="나" badges={ALL} interactive={false} />);
    expect(types('self')).toHaveLength(4);
    await render(<UserIdentity userId="self" nickname="나" badges={[]} interactive={false} />);
    expect(types('self')).toEqual([]);
  });

  it('a session read begun before OFF cannot resurrect stale public badges', async () => {
    queryClient.setQueryData(sessionKeys.current(), session);
    await render(<><BadgeVisibilitySettings /><OwnIdentities count={1} /></>);
    const stale = { ...session, badges: [...ALL] };
    let finishRead!: (response: Response) => void;
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn((input: string, init?: RequestInit) => {
      if (input === '/api/auth/session') return new Promise<Response>(resolve => { finishRead = resolve; });
      return originalFetch(input, init);
    }));
    const inFlight = fetchSession();
    await act(async () => container.querySelectorAll<HTMLButtonElement>('[role="switch"]')[3].click());
    await flushQueries();
    let answer: Awaited<ReturnType<typeof fetchSession>>;
    await act(async () => { finishRead(Response.json(stale)); answer = await inFlight; });
    expect(answer!.badges?.some(b => b.type === 'oidc')).toBe(false);
    expect(types('self')).toEqual(['kyc', 'country', 'workspace']);
    expect(JSON.parse(localStorage.getItem(SESSION_STORAGE_KEY)!).badges.some((b: PublicBadge) => b.type === 'oidc')).toBe(false);
  });

  it.each([null, { userId: 'another', nickname: 'Another account', badges: [] }])('late owner PATCH after logout/switch cannot revive an older session (%j)', async (next) => {
    queryClient.setQueryData(sessionKeys.current(), session);
    await render(<BadgeVisibilitySettings />);
    const staleSession = { ...session };
    let finishSession!: (response: Response) => void;
    let finishPatch!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn((input: string, init?: RequestInit) => {
      if (input === '/api/auth/session') return new Promise<Response>(resolve => { finishSession = resolve; });
      if (input === '/api/profile/badges' && init?.method === 'PATCH') return new Promise<Response>(resolve => { finishPatch = resolve; });
      return Promise.resolve(new Response('{}', { status: 404 }));
    }));
    const pendingSession = fetchSession();
    await act(async () => container.querySelector<HTMLButtonElement>('[role="switch"]')!.click());
    queryClient.setQueryData(sessionKeys.current(), next);
    writeStoredSession(next);
    resetPublicBadgeMutation();
    await act(async () => finishPatch(Response.json({ success: true, userId: 'self', type: 'kyc', visible: false, publicBadges: ALL.slice(1) })));
    finishSession(Response.json(staleSession));
    expect(await pendingSession).toEqual(next);
    expect(queryClient.getQueryData(sessionKeys.current())).toEqual(next);
    expect(JSON.parse(localStorage.getItem(SESSION_STORAGE_KEY) ?? 'null')).toEqual(next);
    expect(container.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('true');
  });

  it.each([null, { userId: 'another', nickname: 'Another account', badges: [] }])('logout/account reset beats an older in-flight session response (%j)', async (next) => {
    const stale = { ...session };
    let resolve!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(done => { resolve = done; })));
    const pending = fetchSession();
    writeStoredSession(next);
    resetPublicBadgeMutation();
    resolve(Response.json(stale));
    expect(await pending).toEqual(next);
    expect(JSON.parse(localStorage.getItem(SESSION_STORAGE_KEY) ?? 'null')).toEqual(next);
  });

  it('unknown/deleted identities do not expose supplied claims, and heading markup never nests headings in spans', async () => {
    await render(<><UserIdentity userId={null} nickname="익명" badges={ALL} isAI /><UserIdentity userId="withdrawn:old" nickname="탈퇴" badges={ALL} isAI />
      <UserIdentity userId="self" nickname="나" badges={ALL} nameAs="h1" layout="column" interactive={false} /></>);
    expect(types('')).toEqual([]);
    expect(container.querySelector('h1')?.textContent).toBe('나');
    expect(container.querySelector('span h1')).toBeNull();
  });

  it('twenty profile rows share one session read and perform no per-person requests', async () => {
    queryClient.setDefaultOptions({ queries: { staleTime: 30_000, retry: false } });
    await render(<>{Array.from({ length: 20 }, (_, i) => <UserIdentity key={i} userId={`peer-${i}`} nickname={`Member ${i}`} badges={ALL} />)}</>);
    expect(calls).toEqual(['/api/auth/session']);
    expect(container.querySelectorAll('[data-badge-type="oidc"]')).toHaveLength(20);
  });
});
