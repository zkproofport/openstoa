// @vitest-environment jsdom
/**
 * Topic page + post detail page — the two screens the redesign restructured.
 *
 * What these guard is HIERARCHY, not pixels: which affordance each role sees,
 * that the content sits on the page ground instead of inside a card, that a
 * claim is spoken with one chip treatment, and that the typography contract
 * (12px floor, `.os-label` for the uppercase idiom, prose capped at the
 * reading measure) holds in both files. A future "just tidy the styles" pass
 * that reintroduces a container card or a hand-rolled uppercase label fails
 * here rather than shipping.
 *
 * Edge-case matrix rows covered:
 *   boundary  — 0 posts + 0 members; exactly 1 member (singular vs plural)
 *   empty     — a topic with no description renders no prose block
 *   hostile   — a title carrying `<script>` / `%` / `_` renders as text
 *   UTF-8     — Korean + emoji titles survive intact, unclipped
 *   large     — a 600-char title is not truncated by nowrap/ellipsis
 *   authz     — guest / non-member / member / owner each see their own actions
 *   contract  — the sort chips still request the same API sort as before
 *   integrity — posts and comments sit on the ground, separated by rules
 *   ui        — one evidence-chip treatment; 12px floor; `.os-label` only
 *   a11y      — every restructured control carries a class that ships a
 *               `:focus-visible` ring (inline styles cannot express one)
 *   width     — the facts row wraps; prose carries the `--read-max` measure
 *
 * Rendering follows this repo's convention (`react-dom/client` + `act`), not
 * Testing Library — that package is not a dependency here.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '@/lib/i18n/I18nProvider';
import en from '@/lib/i18n/locales/en.json';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const paramsMock = vi.hoisted(() => ({ current: {} as Record<string, string> }));
const routerMock = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));
vi.mock('next/navigation', () => ({
  useParams: () => paramsMock.current,
  useRouter: () => routerMock,
  usePathname: () => '/topics',
}));

// The shell, the editors and the shared post chrome are not under test.
vi.mock('@/components/CommunityLayout', () => ({
  default: ({ children }: { children: React.ReactNode }) => React.createElement('div', null, children),
}));
vi.mock('@/components/PostCard', () => ({
  default: ({ post }: { post: { id: string } }) =>
    React.createElement('article', { 'data-testid': 'post' }, post.id),
}));
vi.mock('@/components/Spinner', () => ({ default: () => React.createElement('div', { 'data-testid': 'spinner' }) }));
vi.mock('@/components/SNSEditor', () => ({ default: () => React.createElement('div', { 'data-testid': 'editor' }) }));
vi.mock('@/components/SNSContent', () => ({
  default: ({ html }: { html?: string }) => React.createElement('div', { 'data-testid': 'body' }, html ?? ''),
}));
vi.mock('@/components/TagInput', () => ({ default: () => React.createElement('div') }));
vi.mock('@/components/PollEditor', () => ({ default: () => React.createElement('div') }));
vi.mock('@/components/PollRenderer', () => ({ default: () => React.createElement('div') }));
vi.mock('@/components/ImageLightbox', () => ({ default: () => React.createElement('div') }));
vi.mock('@/components/PostRecordsSection', () => ({ PostRecordsSection: () => React.createElement('div') }));
vi.mock('@/components/post/MediaGallery', () => ({ default: () => React.createElement('div') }));
vi.mock('@/components/post/PostActionBar', () => ({ default: () => React.createElement('div', { 'data-testid': 'actionbar' }) }));
vi.mock('@/components/post/ReactionRow', () => ({ default: () => React.createElement('div') }));

import TopicPage from '@/app/topics/[topicId]/page';
import PostPage from '@/app/topics/[topicId]/posts/[postId]/page';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const TOPIC = {
  id: 't1',
  title: 'Privacy',
  description: 'A public topic for zero-knowledge proofs.',
  memberCount: 1204,
  requiresCountryProof: false,
  isMember: true,
  creatorId: 'u-owner',
  createdAt: '2026-01-01T00:00:00.000Z',
};

const POST = {
  id: 'p1',
  title: 'Proving your country without revealing identity',
  content: 'A Coinbase attestation proves KYC without exposing a name.',
  authorNickname: 'anon_6fd8b04f',
  authorId: '0xdeadbeefcafebabe',
  createdAt: '2026-01-02T00:00:00.000Z',
  topicId: 't1',
  topicTitle: 'Privacy',
  upvoteCount: 42,
  viewCount: 100,
  commentCount: 0,
  tags: [] as Array<{ name: string; slug: string }>,
  isJoinedTopic: true,
};

type Overrides = {
  session?: Record<string, unknown> | null;
  topic?: Partial<typeof TOPIC>;
  role?: string | null;
  posts?: Array<Record<string, unknown>>;
  post?: Partial<typeof POST>;
  comments?: Array<Record<string, unknown>>;
};

const calls: string[] = [];

function mockFetch(o: Overrides = {}) {
  return vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const json = (body: unknown, status = 200) =>
      Promise.resolve(new Response(JSON.stringify(body), { status }));

    if (url.startsWith('/api/auth/session')) return json(o.session === null ? {} : (o.session ?? { userId: 'u-me' }));
    if (url.startsWith('/api/tags')) return json({ tags: [] });
    if (/^\/api\/topics\/[^/]+\/posts/.test(url)) return json({ posts: o.posts ?? [] });
    if (/^\/api\/topics\/[^/]+$/.test(url)) {
      return json({ topic: { ...TOPIC, ...o.topic }, ...(o.role ? { currentUserRole: o.role } : {}) });
    }
    if (/^\/api\/posts\/[^/]+$/.test(url)) {
      return json({ post: { ...POST, ...o.post }, comments: o.comments ?? [] });
    }
    return json({});
  });
}

let container: HTMLDivElement;
let root: Root;

async function mount(node: React.ReactElement) {
  await act(async () => {
    root.render(<I18nProvider initialLocale="en">{node}</I18nProvider>);
  });
  // Session resolve → dependent effects → their resolves.
  for (let i = 0; i < 4; i++) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => { await Promise.resolve(); });
  }
}

const mountTopic = (o: Overrides = {}) => {
  paramsMock.current = { topicId: 't1' };
  vi.stubGlobal('fetch', mockFetch(o));
  return mount(<TopicPage />);
};

const mountPost = (o: Overrides = {}) => {
  paramsMock.current = { topicId: 't1', postId: 'p1' };
  vi.stubGlobal('fetch', mockFetch(o));
  return mount(<PostPage />);
};

const text = () => container.textContent ?? '';
const q = <T extends Element>(sel: string) => container.querySelector<T>(sel);
const qa = <T extends Element>(sel: string) => Array.from(container.querySelectorAll<T>(sel));
const buttonNamed = (name: string) =>
  qa<HTMLButtonElement>('button').find((b) => (b.textContent ?? '').includes(name));
const linkTo = (href: string) => qa<HTMLAnchorElement>('a').find((a) => a.getAttribute('href') === href);

async function click(el: Element | undefined) {
  expect(el, 'element to click was not found').toBeTruthy();
  await act(async () => { el!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await act(async () => { await Promise.resolve(); });
}

beforeEach(() => {
  calls.length = 0;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.stubGlobal('IntersectionObserver', class {
    observe() {}
    disconnect() {}
    unobserve() {}
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// ─── Topic header: who sees which action ─────────────────────────────────────

describe('topic header — the action is the one this viewer can actually take', () => {
  it('a guest sees the sign-in banner and NEITHER join nor invite', async () => {
    await mountTopic({ session: null, topic: { isMember: false } });

    expect(text()).toContain(en.topicPage.guestBanner);
    expect(linkTo('/topics/t1/join')).toBeUndefined();
    expect(buttonNamed(en.membersPage.invite)).toBeUndefined();
    // …and no composer entry point.
    expect(buttonNamed(en.topicPage.composer.writePost)).toBeUndefined();
  });

  it('an authenticated non-member gets Join as the one primary button', async () => {
    await mountTopic({ topic: { isMember: false } });

    const join = linkTo('/topics/t1/join');
    expect(join).toBeTruthy();
    expect(join!.className).toContain('os-button');
    expect(join!.className).toContain('os-button-primary');
    expect(buttonNamed(en.membersPage.invite)).toBeUndefined();
    // Exactly one primary control on the screen — a second one would mean two
    // "the" actions.
    expect(qa('.os-button-primary')).toHaveLength(1);
  });

  it('a member gets Invite as a plain `.os-button`, and no Join', async () => {
    await mountTopic({ role: 'member' });

    const invite = buttonNamed(en.membersPage.invite);
    expect(invite).toBeTruthy();
    expect(invite!.className).toBe('os-button');
    expect(linkTo('/topics/t1/join')).toBeUndefined();
    expect(linkTo('/topics/t1/edit')).toBeUndefined();
  });

  it('an owner gets Edit + Manage + Invite, all in the same control vocabulary', async () => {
    await mountTopic({ role: 'owner' });

    const edit = linkTo('/topics/t1/edit');
    expect(edit?.className).toContain('os-button');
    // Two links point at /members (the member count and Manage); the button
    // one is what this asserts.
    const manage = qa<HTMLAnchorElement>('a[href="/topics/t1/members"]')
      .find((a) => a.className.includes('os-button'));
    expect(manage).toBeTruthy();
    expect(buttonNamed(en.membersPage.invite)?.className).toContain('os-button');
  });

  it('an admin gets Manage but NOT Edit', async () => {
    await mountTopic({ role: 'admin' });

    expect(linkTo('/topics/t1/edit')).toBeUndefined();
    expect(
      qa<HTMLAnchorElement>('a[href="/topics/t1/members"]').some((a) => a.className.includes('os-button')),
    ).toBe(true);
  });
});

// ─── Topic header: facts, measure, empty ─────────────────────────────────────

describe('topic header — facts, measure and the empty topic', () => {
  it('a brand-new topic (0 posts, 0 members) says so instead of rendering nothing', async () => {
    await mountTopic({ topic: { memberCount: 0 }, posts: [] });

    expect(text()).toContain('0');
    expect(text()).toContain(en.rightSidebar.members);
    expect(text()).toContain(en.topicPage.empty.member);
    expect(qa('[data-testid="post"]')).toHaveLength(0);
  });

  it('one member is singular, two are plural', async () => {
    await mountTopic({ topic: { memberCount: 1 } });
    expect(text()).toContain(`1 ${en.rightSidebar.member}`);

    await act(async () => { root.unmount(); });
    container.remove();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await mountTopic({ topic: { memberCount: 2 } });
    expect(text()).toContain(`2 ${en.rightSidebar.members}`);
  });

  it('the description is prose: capped at the reading measure, present only when there is one', async () => {
    await mountTopic();
    const prose = qa<HTMLElement>('p').find((p) => p.textContent === TOPIC.description);
    expect(prose).toBeTruthy();
    expect(prose!.style.maxWidth).toBe('var(--read-max)');

    await act(async () => { root.unmount(); });
    container.remove();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await mountTopic({ topic: { description: undefined } });
    expect(qa<HTMLElement>('p').some((p) => p.style.maxWidth === 'var(--read-max)')).toBe(false);
  });

  it('the facts row wraps, so 320px never pushes an action off screen', async () => {
    await mountTopic({ role: 'owner' });
    const h1 = q<HTMLElement>('h1')!;
    const facts = h1.parentElement!.parentElement!.querySelector<HTMLElement>('div[style*="flex-wrap"]');
    expect(facts).toBeTruthy();
    expect(facts!.style.flexWrap).toBe('wrap');
  });

  it('a long / Korean / emoji title renders in full and is never clipped', async () => {
    const title = `영지식 증명으로 신원을 밝히지 않고 거주국만 증명하기 🎉 ${'가'.repeat(300)}`;
    await mountTopic({ topic: { title } });

    const h1 = q<HTMLElement>('h1')!;
    expect(h1.textContent).toBe(title);
    expect(h1.style.whiteSpace).not.toBe('nowrap');
    expect(h1.style.textOverflow).toBe('');
    // Shrinks inside the avatar row rather than pushing it out of the viewport.
    expect(h1.style.minWidth).toBe('0px');
  });

  it('a hostile title is text, not markup', async () => {
    const title = '<script>alert(1)</script> 100% _wild_ \\';
    await mountTopic({ topic: { title } });

    expect(q<HTMLElement>('h1')!.textContent).toBe(title);
    expect(container.querySelector('script')).toBeNull();
  });
});

// ─── Evidence chips ──────────────────────────────────────────────────────────

describe('evidence chips — one treatment, on-chain stays the quietest', () => {
  it('the proof requirement renders through Badge (verified tone), not a bespoke pill', async () => {
    await mountTopic({ topic: { requiresCountryProof: true } });

    const chip = q<HTMLElement>('[data-badge-type="country"]');
    expect(chip).toBeTruthy();
    expect(chip!.getAttribute('data-badge-tone')).toBe('verified');
    expect(chip!.textContent).toContain(en.joinPage.proofBadge.country);
  });

  it('no proof requirement means no chip at all', async () => {
    await mountTopic({ topic: { requiresCountryProof: false } });
    expect(q('[data-badge-type="country"]')).toBeNull();
  });

  it('the Joined pill is an outline on transparent — the same tone Badge uses', async () => {
    await mountTopic({ role: 'member' });

    const pill = qa<HTMLElement>('span.os-label')
      .find((s) => (s.getAttribute('aria-label') ?? '') === en.topicPage.joinedTopicAriaLabel);
    expect(pill).toBeTruthy();
    expect(pill!.style.background).toBe('transparent');
    expect(pill!.style.border).toContain('var(--color-brand-accent)');
  });
});

// ─── Sort + tag chips ────────────────────────────────────────────────────────

describe('sort and tag chips — one chip vocabulary, unchanged behavior', () => {
  it('all four sorts are `.os-chip`, with exactly one pressed', async () => {
    await mountTopic();

    const chips = qa<HTMLButtonElement>('button.os-chip');
    expect(chips.length).toBeGreaterThanOrEqual(4);
    const pressed = chips.filter((c) => c.getAttribute('aria-pressed') === 'true');
    expect(pressed).toHaveLength(1);
    expect(pressed[0].textContent).toContain(en.topicPage.sort.new);
  });

  it('CONTRACT: picking Popular still requests sort=hot, and moves the pressed state', async () => {
    await mountTopic();
    calls.length = 0;

    await click(buttonNamed(en.topicPage.sort.popular));

    expect(calls.some((u) => u.includes('/api/topics/t1/posts') && u.includes('sort=hot'))).toBe(true);
    const pressed = qa<HTMLButtonElement>('button.os-chip').filter((c) => c.getAttribute('aria-pressed') === 'true');
    expect(pressed).toHaveLength(1);
    expect(pressed[0].textContent).toContain(en.topicPage.sort.popular);
  });

  it('CONTRACT: Pinned still requests sort=new and filters client-side', async () => {
    await mountTopic({ posts: [{ ...POST, id: 'a', isPinned: true }, { ...POST, id: 'b' }] });
    calls.length = 0;

    await click(buttonNamed(en.topicPage.sort.pinned));

    expect(calls.some((u) => u.includes('/api/topics/t1/posts') && u.includes('sort=new'))).toBe(true);
    expect(qa('[data-testid="post"]')).toHaveLength(1);
  });

  it('the tag search field carries the 16px/44px input contract', async () => {
    await mountTopic();
    const input = q<HTMLInputElement>('input[type="text"]');
    expect(input?.className).toBe('os-input');
  });
});

// ─── The feed is the page, not a widget ──────────────────────────────────────

describe('post list — on the page ground, separated by rules', () => {
  it('the list wrapper is a rule, not a rounded bordered container', async () => {
    await mountTopic({ posts: [{ ...POST, id: 'a' }, { ...POST, id: 'b' }] });

    const posts = qa<HTMLElement>('[data-testid="post"]');
    expect(posts).toHaveLength(2);
    const wrapper = posts[0].parentElement as HTMLElement;
    expect(wrapper.style.borderTop).toContain('var(--color-border-default)');
    expect(wrapper.style.borderRadius).toBe('');
    expect(wrapper.style.overflow).toBe('');
    expect(wrapper.style.background).toBe('');
  });
});

// ─── Post detail ─────────────────────────────────────────────────────────────

describe('post detail — the body is the page, not a card', () => {
  it('the article carries no fill, no radius — just a closing rule', async () => {
    await mountPost();

    const article = q<HTMLElement>('article')!;
    expect(article.style.background).toBe('');
    expect(article.style.borderRadius).toBe('');
    expect(article.style.borderBottom).toContain('var(--border)');
  });

  it('the title is the page heading, unclipped, in Korean and emoji too', async () => {
    const title = '영지식 증명 🎉 ' + 'ㄱ'.repeat(400);
    await mountPost({ post: { title } });

    const h1 = q<HTMLElement>('h1')!;
    expect(h1.textContent).toBe(title);
    expect(h1.style.fontSize).toBe('var(--text-heading-lg)');
    expect(h1.style.whiteSpace).not.toBe('nowrap');
  });

  it('the topic chip uses `.os-label`, never a hand-rolled uppercase style', async () => {
    await mountPost();

    const chip = qa<HTMLAnchorElement>('a.os-label').find((a) => a.getAttribute('href') === '/topics/t1');
    expect(chip).toBeTruthy();
    expect(chip!.style.textTransform).toBe('');
    expect(chip!.style.letterSpacing).toBe('');
  });

  it('the Joined pill matches the topic page: outline on transparent', async () => {
    await mountPost({ post: { isJoinedTopic: true } });

    const pill = qa<HTMLElement>('span.os-label').find((s) => (s.textContent ?? '').includes('Joined'));
    expect(pill).toBeTruthy();
    expect(pill!.style.background).toBe('transparent');
    expect(pill!.style.border).toContain('var(--color-brand-accent)');

    await act(async () => { root.unmount(); });
    container.remove();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await mountPost({ post: { isJoinedTopic: false } });
    expect(qa<HTMLElement>('span.os-label').some((s) => (s.textContent ?? '').includes('Joined'))).toBe(false);
  });

  it('no tags means no tag row; many tags all render and the row wraps', async () => {
    await mountPost({ post: { tags: [] } });
    expect(container.textContent).not.toContain('#');

    await act(async () => { root.unmount(); });
    container.remove();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const tags = Array.from({ length: 12 }, (_, i) => ({ name: `태그${i}`, slug: `t${i}` }));
    await mountPost({ post: { tags } });
    const rendered = qa<HTMLElement>('span').filter((s) => /^#태그\d+$/.test(s.textContent ?? ''));
    expect(rendered).toHaveLength(12);
    expect((rendered[0].parentElement as HTMLElement).style.flexWrap).toBe('wrap');
  });

  it('a guest sees the sign-in prompt as a real button, and no comment form', async () => {
    await mountPost({ session: null });

    expect(q('textarea')).toBeNull();
    const cta = qa<HTMLAnchorElement>('a.os-button').find((a) => a.getAttribute('href') === '/');
    expect(cta?.className).toContain('os-button-primary');
  });

  it('a member gets the comment form, at the 16px input floor', async () => {
    await mountPost();

    const ta = q<HTMLTextAreaElement>('textarea');
    expect(ta).toBeTruthy();
    expect(ta!.style.fontSize).toBe('var(--text-body)');
    expect(buttonNamed('Post Comment')?.className).toContain('os-button');
  });

  it('comments are rows on the ground, closed by a rule — deleted ones included', async () => {
    await mountPost({
      comments: [
        { id: 'c1', content: 'hello 🎉', authorNickname: 'anon_a', authorId: '0xaa', createdAt: POST.createdAt },
        { id: 'c2', content: '', authorNickname: null, authorId: null, createdAt: POST.createdAt, isDeleted: true, deletedBy: 'admin' },
      ],
    });

    const rows = qa<HTMLElement>('div').filter((d) => d.style.borderTop.includes('var(--color-border-default)') && d.style.padding === 'var(--space-4) 0');
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.style.borderRadius).toBe('');
      expect(row.style.background).toBe('');
    }
    expect(text()).toContain('Deleted by admin');
  });

  it('the kebab is only there for someone who can act, and it is focusable chrome', async () => {
    await mountPost({ session: { userId: POST.authorId } });
    const kebab = qa<HTMLButtonElement>('button').find((b) => b.getAttribute('aria-label') === 'Post actions');
    expect(kebab?.className).toContain('os-chip');

    await act(async () => { root.unmount(); });
    container.remove();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await mountPost({ session: { userId: 'someone-else' } });
    expect(qa<HTMLButtonElement>('button').some((b) => b.getAttribute('aria-label') === 'Post actions')).toBe(false);
  });
});

// ─── Source contracts — what a render assertion cannot see ───────────────────

const FILES = [
  'src/app/topics/[topicId]/page.tsx',
  'src/app/topics/[topicId]/posts/[postId]/page.tsx',
] as const;

const source = (f: string) => readFileSync(join(process.cwd(), f), 'utf-8');

describe('typography contract in the two redesigned files', () => {
  it.each(FILES)('%s has no numeric fontSize below the 12px floor', (file) => {
    const hits = [...source(file).matchAll(/fontSize:\s*(\d+)\b/g)].filter((m) => Number(m[1]) < 12);
    expect(hits.map((m) => m[0])).toEqual([]);
  });

  it.each(FILES)('%s uses the type scale, not raw pixel font sizes', (file) => {
    // Both files had 10-28px literals scattered through them; every size is
    // now a `--text-*` step, which is what makes the two screens share a
    // scale with the rest of the app.
    expect([...source(file).matchAll(/fontSize:\s*\d+\b/g)].map((m) => m[0])).toEqual([]);
  });

  it.each(FILES)('%s never hand-rolls the uppercase+tracking label idiom', (file) => {
    // Uppercase is a no-op on Hangul and tracking reads as broken kerning —
    // `.os-label` gates both to :lang(en). An inline copy cannot.
    const src = source(file);
    expect(src).not.toMatch(/textTransform:\s*'uppercase'/);
    expect(src).not.toMatch(/letterSpacing:\s*'0\.0[468]em'/);
  });

  it('the post detail page carries `.os-label` where it used to inline the idiom', () => {
    expect(source(FILES[1])).toContain('className="os-label"');
  });

  it.each(FILES)('%s spaces itself from the scale, not from ad-hoc pixels', (file) => {
    // A margin/padding literal is how the vertical rhythm drifted in the
    // first place. Sub-4px chip internals (1-3px) are below the scale's
    // smallest step and stay literal.
    const src = source(file);
    const hits = [
      ...[...src.matchAll(/margin(?:Top|Bottom|Left|Right)?:\s*(\d+)\b/g)],
      ...[...src.matchAll(/padding(?:Top|Bottom|Left|Right)?:\s*(\d+)\b/g)],
      ...[...src.matchAll(/gap:\s*(\d+)\b/g)],
    ].filter((m) => Number(m[1]) >= 4);
    expect(hits.map((m) => m[0])).toEqual([]);
  });
});
