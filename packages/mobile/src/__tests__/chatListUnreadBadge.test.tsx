/**
 * DEFECT 3b (confirmed, MOST IMPORTANT) — the chat-list unread badge is fake.
 *
 * `ChatListScreen.tsx:294` is literally:
 *
 *   const unreadCount = hasUnread ? 1 : 0;
 *
 * It never counts anything. `hasUnread` itself is computed correctly (a
 * boolean: is the topic's newest fetched message unseen and not mine?), but
 * the moment that boolean is turned into a NUMBER it collapses to 1-or-0 —
 * so a room with one new message and a room with fifty both show "1". The
 * `unreadCount > 99 ? '99+' : String(unreadCount)` branch right below it
 * (line ~365) is DEAD CODE: `unreadCount` can only ever be 0 or 1, so the
 * `> 99` arm can never fire in the shipped app, however many messages pile
 * up.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage here
 *   contract    — CONTRACT (fails today, THE bug): 3 unread messages must
 *                 read "3", not "1"
 *   boundary    — 0 unread → no badge at all (not a "0" badge)
 *   boundary    — CONTRACT (fails today): more than 99 unread reads "99+",
 *                 not the raw count and not "1" — proves the dead branch is
 *                 dead under the CURRENT implementation, not just under this
 *                 file's particular fixture
 *   integrity   — a topic whose newest messages are the viewer's OWN never
 *                 counts as unread, even when there are several of them
 *   contract    — exactly one message, from someone else → "1" (the one
 *                 case the current fake counter happens to get right; kept
 *                 so a fix cannot accidentally break the trivial case while
 *                 fixing the interesting one)
 *   authz/hostile/UTF-8/very large/race — N/A: this is a client-side COUNT
 *                 over server data already covered by other topic/message
 *                 fetch tests; no new input surface is introduced here.
 *
 * Render setup follows `topicMembersKick.test.tsx`'s pattern (real
 * `useOpenStoaSession` store, `vi.stubGlobal('fetch', ...)`) since
 * `ChatListScreen` has no dedicated test file yet to inherit conventions
 * from directly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { act } from 'react-test-renderer';
import { renderScreen } from './harness/screen';
import { useOpenStoaSession } from '../stores/sessionStore';
import { ChatListScreen } from '../screens/chat/ChatListScreen';
import type { ChatMessage, Topic } from '@openstoa/api-types';

/**
 * Advance a REAL timer tick, inside `act` — same helper and same reason as
 * `topicMembersKick.test.tsx`: `flush()` (harness/render.tsx) only drains the
 * MICROTASK queue, but @tanstack/react-query's `notifyManager` batches the
 * post-fetch state update via `setTimeout(0)` in this Node test environment.
 * `ChatListScreen` fires TWO queries (`my-topics` then, once topics resolve,
 * one `chat-last` per topic) so the settle has to survive both hops, not just
 * one.
 */
async function settleTimers(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

const ME = 'nullifier-me';
const OTHER = 'nullifier-other';

/**
 * `seenMessageIds` in `ChatListScreen.tsx` is a MODULE-LEVEL `Map`, a
 * singleton that outlives any one `renderScreen()` call (same class of
 * hazard as `sessionExpiry.ts`'s listener set, see `signInSheet.test.tsx`).
 * A fresh, never-before-seen topic id per test sidesteps it instead of
 * fighting it — there is no exported reset hook to clear the map directly.
 */
let topicSeq = 0;
function freshTopicId(): string {
  topicSeq += 1;
  return `11111111-2222-4333-8444-${String(topicSeq).padStart(12, '0')}`;
}

function topic(id: string, title: string): Topic {
  return {
    id,
    title,
    creatorId: OTHER,
    requiresCountryProof: false,
    inviteCode: 'x',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastChatAt: new Date().toISOString(),
  } as unknown as Topic;
}

/** Newest-first, matching what `/chat?limit=1` (or a wider future fetch)
 *  returns — `ChatListScreen` reads `messages[0]` as "the latest". */
function message(over: Partial<ChatMessage> & { id: string; userId: string }): ChatMessage {
  return {
    topicId: 'unused',
    nickname: over.userId === ME ? 'me' : 'other',
    type: 'message',
    createdAt: new Date().toISOString(),
    sealed: { ciphertext: 'x', epoch: 0 },
    ...over,
  } as ChatMessage;
}

function fetchMock(topics: Topic[], chatByTopic: Record<string, { messages: ChatMessage[]; total: number }>) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    // Specific branch FIRST — `/api/topics/{id}/chat` also contains the
    // substring `/api/topics`, so checking the plain list URL first would
    // misroute every chat-history request into the topics-list branch.
    const chatMatch = url.match(/\/api\/topics\/([^/?]+)\/chat/);
    if (chatMatch) {
      const body = chatByTopic[chatMatch[1]] ?? { messages: [], total: 0 };
      return { ok: true, status: 200, json: async () => body, text: async () => '' } as unknown as Response;
    }
    if (url.includes('/api/topics')) {
      return { ok: true, status: 200, json: async () => ({ topics }), text: async () => '' } as unknown as Response;
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => '' } as unknown as Response;
  });
}

/** Text nodes whose ENTIRE content is a bare unread-badge shape: digits, or
 *  `'99+'`. Deliberately structural rather than style-object matching — the
 *  stand-in style objects are rebuilt every render (`makeStyles(colors)` is
 *  called fresh in the component body), so identity comparison would be
 *  fragile. Nothing else on this row renders bare digits: `formatRelativeTime`
 *  falls back to the untranslated i18next KEY in this harness (no i18n
 *  instance — see `signInSheet.test.tsx`'s precedent), which is never a bare
 *  number. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function badgeTexts(root: any): string[] {
  return root
    .findAll((n: any) => typeof n.type === 'string' && n.type === 'Text')
    .map((n: any) => n.children.filter((c: unknown) => typeof c === 'string').join(''))
    .filter((t: string) => /^\d+$/.test(t) || t === '99+');
}

beforeEach(() => {
  useOpenStoaSession.setState({
    mode: 'authenticated',
    token: 'test-token',
    userId: ME,
    nickname: 'me',
    needsNickname: false,
    expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    role: 'member',
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  useOpenStoaSession.setState({
    mode: 'unknown',
    token: null,
    userId: null,
    nickname: null,
    needsNickname: false,
    expiresAt: null,
    role: 'member',
  });
});

describe('ChatListScreen — unread badge', () => {
  it('CONTRACT (fails today, THE bug): 3 unread messages read "3", not "1"', async () => {
    const t = freshTopicId();
    const topics = [topic(t, 'Three unread')];
    vi.stubGlobal(
      'fetch',
      fetchMock(topics, {
        [t]: {
          total: 3,
          messages: [
            message({ id: 'm3', userId: OTHER }),
            message({ id: 'm2', userId: OTHER }),
            message({ id: 'm1', userId: OTHER }),
          ],
        },
      }),
    );

    const { rendered } = await renderScreen(<ChatListScreen />);
    await settleTimers();

    expect(
      badgeTexts(rendered.root),
      `expected the unread badge to read "3"; the fake counter renders every unread room as "1"`,
    ).toEqual(['3']);

    rendered.unmount();
  });

  it('CONTRACT (fails today): more than 99 unread reads "99+", not "1"', async () => {
    const t = freshTopicId();
    const topics = [topic(t, 'A very chatty room')];
    const messages = Array.from({ length: 150 }, (_, i) =>
      message({ id: `m${150 - i}`, userId: OTHER }),
    ); // newest (m150) first
    vi.stubGlobal('fetch', fetchMock(topics, { [t]: { total: 150, messages } }));

    const { rendered } = await renderScreen(<ChatListScreen />);
    await settleTimers();

    expect(badgeTexts(rendered.root)).toEqual(['99+']);

    rendered.unmount();
  });

  it('BOUNDARY: zero unread renders no badge at all (not a "0")', async () => {
    const t = freshTopicId();
    const topics = [topic(t, 'All caught up')];
    vi.stubGlobal('fetch', fetchMock(topics, { [t]: { total: 0, messages: [] } }));

    const { rendered } = await renderScreen(<ChatListScreen />);
    await settleTimers();

    expect(badgeTexts(rendered.root)).toEqual([]);

    rendered.unmount();
  });

  it('INTEGRITY: the viewer\'s OWN latest messages never count as unread', async () => {
    const t = freshTopicId();
    const topics = [topic(t, 'I sent the last few')];
    vi.stubGlobal(
      'fetch',
      fetchMock(topics, {
        [t]: {
          total: 3,
          messages: [
            message({ id: 'm3', userId: ME }),
            message({ id: 'm2', userId: ME }),
            message({ id: 'm1', userId: OTHER }),
          ],
        },
      }),
    );

    const { rendered } = await renderScreen(<ChatListScreen />);
    await settleTimers();

    expect(badgeTexts(rendered.root)).toEqual([]);

    rendered.unmount();
  });

  it('CONTRACT: exactly one unread message from someone else reads "1"', async () => {
    // The one shape the current fake counter happens to get right — kept so
    // a fix for the "3" case cannot silently regress the trivial one.
    const t = freshTopicId();
    const topics = [topic(t, 'One new message')];
    vi.stubGlobal(
      'fetch',
      fetchMock(topics, { [t]: { total: 1, messages: [message({ id: 'm1', userId: OTHER })] } }),
    );

    const { rendered } = await renderScreen(<ChatListScreen />);
    await settleTimers();

    expect(badgeTexts(rendered.root)).toEqual(['1']);

    rendered.unmount();
  });
});
