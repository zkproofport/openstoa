// @vitest-environment jsdom
/**
 * A kick that removes the ACCOUNT but not all of its DEVICES must say so.
 *
 * `reconcileMembership` returns `unattributable` precisely so a caller can
 * report "N devices could not be removed". The members page discarded the whole
 * result — `.catch(() => {})`, return value unused — so an admin was told the
 * member was removed while their devices were still in the MLS group, still
 * deriving every future epoch key, and still able to read anything sent from
 * then on.
 *
 * Incomplete-and-reported is a known limitation somebody can act on.
 * Incomplete-and-silent is a false assurance in a security control, which is
 * worse than the incomplete removal itself. That is what these tests pin.
 *
 * Why only the web members page here: `ChatPanel.tsx` and the mini-app's
 * `ChatRoomScreen.tsx` also call `reconcileMembership`, but on room entry as
 * silent background repair — nobody is being given an assurance there, so
 * silence is correct. The mini-app's OWN kick surface (`TopicMembersScreen.tsx`,
 * A-3) mirrors this page's contract instead and is pinned separately in
 * `packages/mobile/src/__tests__/topicMembersKick.test.tsx`.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage here
 *   contract   → 'a partial removal warns, and names the count'
 *   integrity  → 'a CLEAN removal stays silent' (a warning that always fires is
 *                noise, and noise is how a real warning gets ignored)
 *   external   → 'a FAILED reconcile stays silent' — the next member repairs it;
 *                only the successful-but-partial case is a false assurance
 *   boundary   → 'the notice is dismissible' + 'nothing shows before a kick'
 *   hostile/UTF-8/large/race → N/A: the input is a non-negative integer counted
 *                by the MLS layer, not user text.
 *   authz      → N/A: the kick's authorization is the DELETE route's job and is
 *                unchanged here; this is presentation of its aftermath.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const routerMock = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/topics/t1/members',
  useRouter: () => routerMock,
  useParams: () => ({ topicId: 't1' }),
}));

vi.mock('@/hooks/useMediaQuery', () => ({
  useMediaQuery: () => true,
  DESKTOP_CHAT_QUERY: '(min-width: 1024px)',
  MOBILE_QUERY: '(max-width: 767px)',
}));
vi.mock('@/components/Header', () => ({ default: () => React.createElement('div') }));
vi.mock('@/components/LeftSidebar', () => ({ default: () => React.createElement('div') }));
vi.mock('@/components/RightSidebar', () => ({ default: () => React.createElement('div') }));
vi.mock('@/components/ChatRail', () => ({ default: () => React.createElement('div') }));

/*
 * The MLS store. `reconcileMembership` returns the FULL real shape
 * `{ epoch, removed, unattributable }` — a mock that returned only the field
 * under test would let the page read a missing one as undefined and still pass,
 * which is the looser-than-the-server failure this codebase keeps hitting.
 */
const reconcileMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/mls/webTransport', async (importOriginal) => {
  /*
   * Spread the REAL module and override one function. A factory that returns
   * only `getMlsSessionStore` deletes every other export — `RecoveryNudge`
   * calls `ensureTakKeychainBackup` from here and would explode on an
   * unrelated surface, which says nothing about the code under test.
   */
  const actual = await importOriginal<typeof import('@/lib/mls/webTransport')>();
  return {
    ...actual,
    getMlsSessionStore: () => ({ reconcileMembership: reconcileMock }),
  };
});

import MembersPage from '@/app/topics/[topicId]/members/page';
import { TestProviders, flushQueries } from './harness/providers';
import en from '@/lib/i18n/locales/en.json';

let container: HTMLDivElement;
let root: Root;

function json(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as unknown as Response;
}

/** Members after the kick — `me` (owner) plus one bystander. */
function routeFetch() {
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/auth/session') return Promise.resolve(json({ userId: 'me' }));
    if (url === '/api/topics/t1') return Promise.resolve(json({ topic: { id: 't1', title: 'Zoning Law' } }));
    if (url === '/api/topics/t1/members') {
      if (init?.method === 'DELETE') return Promise.resolve(json({ success: true }));
      return Promise.resolve(
        json({
          members: [
            { userId: 'me', nickname: 'me', role: 'owner' },
            { userId: 'u1', nickname: 'bob', role: 'member' },
          ],
          currentUserRole: 'owner',
        }),
      );
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

/*
 * A macrotask drain, not a microtask one.
 *
 * TanStack Query delivers results through `notifyManager`, which schedules on a
 * real `setTimeout(0)` — so draining microtasks alone leaves every query result
 * undelivered and every assertion reading "not yet". Same helper, same reason,
 * as the mini-app harness's `settle`.
 */
const flush = flushQueries;

/**
 * The Kick button needs two clicks: the first arms the confirm, which RELABELS
 * the button to "Confirm?".
 *
 * Each step asserts the button it is about to click actually exists. An
 * optional-chained `?.click()` here silently did nothing when the label
 * changed, the kick never ran, and the two "stays silent" tests passed while
 * asserting nothing at all.
 */
async function clickButton(pattern: RegExp) {
  const btn = Array.from(container.querySelectorAll('button')).find((b) =>
    pattern.test(b.textContent ?? ''),
  );
  expect(btn, `no button matching ${pattern}`).toBeTruthy();
  await act(async () => {
    btn!.click();
  });
}

async function kickBob() {
  await clickButton(/^kick$/i);
  await flush(2);
  await clickButton(/confirm/i);
  await flush();
}

function noticeText(): string | null {
  const el = container.querySelector('[role="status"]');
  return el ? (el.textContent ?? '') : null;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  routerMock.push.mockClear();
  reconcileMock.mockReset();
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
});

async function mount() {
  await act(async () => {
    root.render(
      <TestProviders initialLocale="en">
        <MembersPage />
      </TestProviders>,
    );
  });
  await flush();
}

describe('a kick that could not remove every device says so', () => {
  it('CONTRACT: a partial removal warns, and names how many devices are still in', async () => {
    routeFetch();
    reconcileMock.mockResolvedValue({ epoch: 4, removed: 1, unattributable: 2 });
    await mount();

    expect(noticeText(), 'nothing should be shown before a kick').toBeNull();
    await kickBob();

    const text = noticeText();
    expect(text, 'a partial removal must not be silent').not.toBeNull();
    expect(text).toContain('2');
    /*
     * The rendered string must be the real one, not a raw key: a missing i18n
     * entry renders the key itself and would otherwise pass `toContain('2')`
     * never — and pass a laxer assertion silently.
     */
    expect(text).not.toContain('membersPage.kickPartial');
    expect(en.membersPage.kickPartial).toContain('{{count}}');
  });

  it('INTEGRITY: a CLEAN removal stays silent', async () => {
    // A warning that fires every time is noise, and noise is how a real warning
    // gets ignored. Zero unattributable leaves is a complete removal.
    routeFetch();
    reconcileMock.mockResolvedValue({ epoch: 4, removed: 1, unattributable: 0 });
    await mount();
    await kickBob();

    expect(noticeText()).toBeNull();
  });

  it('EXTERNAL FAILURE: a reconcile that REJECTS stays silent', async () => {
    /*
     * A failed sweep is not a false assurance — the tree is untouched and the
     * next member to open the room reconciles. Warning here would tell the
     * admin devices were left behind when nothing has been determined yet.
     */
    routeFetch();
    reconcileMock.mockRejectedValue(new Error('epoch-CAS lost'));
    await mount();
    await kickBob();

    expect(noticeText()).toBeNull();
  });

  it('BOUNDARY: the notice is dismissible', async () => {
    routeFetch();
    reconcileMock.mockResolvedValue({ epoch: 4, removed: 0, unattributable: 1 });
    await mount();
    await kickBob();
    expect(noticeText()).not.toBeNull();

    const dismiss = container.querySelector('[role="status"] button') as HTMLButtonElement | null;
    expect(dismiss, 'the warning must be dismissible').not.toBeNull();
    await act(async () => {
      dismiss?.click();
    });
    await flush(2);

    expect(noticeText()).toBeNull();
  });

  it('CONTRACT: the reconcile is still called with the REMAINING members only', async () => {
    // The count is new; the call it comes from must not have changed shape.
    // Passing the kicked member would make the sweep a no-op.
    routeFetch();
    reconcileMock.mockResolvedValue({ epoch: 4, removed: 1, unattributable: 0 });
    await mount();
    await kickBob();

    expect(reconcileMock).toHaveBeenCalledTimes(1);
    const [topicId, ids] = reconcileMock.mock.calls[0];
    expect(topicId).toBe('t1');
    expect(Array.isArray(ids)).toBe(true);
  });
});
