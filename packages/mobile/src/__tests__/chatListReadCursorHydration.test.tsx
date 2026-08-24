/**
 * A COLD START must not re-badge a room the account has already read.
 *
 * The defect: the read cursor was an in-process `Map`, so every fresh launch
 * had no cursor for any room not yet opened in THAT process and counted the
 * room's whole recent window as unread. Reading on the phone also left the
 * badge lit on the web, because the two processes' maps never met.
 *
 * `GET /api/topics` now carries the account's cursor per room
 * (`lastReadAt` / `lastReadMessageId`, from `chat_reads`), and `ChatListScreen`
 * seeds the local cache from it on the first list fetch. This file renders the
 * real screen against a fetch stub, so a hydration effect that stopped running
 * — or was never wired — shows up as a wrong badge rather than as nothing.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) -> coverage here
 *   contract    -> a server cursor mid-window badges only what is NEWER
 *   boundary    -> a cursor at the NEWEST message badges nothing; a room with
 *                  no cursor at all badges its whole window (the never-read
 *                  case, which must not be broken by the seeding)
 *   empty/null  -> `lastReadAt: null` with a non-null id, and the reverse, are
 *                  each ignored rather than half-applied
 *   race        -> a LOCAL cursor already further along is not dragged back by
 *                  a server response that predates it
 *   hostile     -> an unparsable `lastReadAt` seeds nothing instead of parking
 *                  the cursor at an invalid instant
 *   authz / UTF-8 / very large -> N/A: this is a client-side seeding of two
 *                  server-supplied strings; the route's own input surface is
 *                  covered in `src/__tests__/e2e/chat-read.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderScreen } from './harness/screen';
import { useOpenStoaSession } from '../stores/sessionStore';
import { ChatListScreen } from '../screens/chat/ChatListScreen';
import { markChatRead, resetChatReadCursors } from '../lib/chatReadCursor';
import type { ChatMessage, Topic } from '@openstoa/api-types';

async function settleTimers(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

const ME = 'nullifier-me';
const OTHER = 'nullifier-other';

let topicSeq = 0;
function freshTopicId(): string {
  topicSeq += 1;
  return `33333333-4444-4555-8666-${String(topicSeq).padStart(12, '0')}`;
}

/** Fixed instants, so "newer than the cursor" is a fact and not a race. */
const at = (n: number) => new Date(Date.UTC(2026, 7, 24, 0, 0, n)).toISOString();

function topic(
  id: string,
  over: { lastReadAt?: string | null; lastReadMessageId?: string | null } = {},
): Topic {
  return {
    id,
    title: `Room ${id.slice(-4)}`,
    creatorId: OTHER,
    requiresCountryProof: false,
    inviteCode: 'x',
    createdAt: at(0),
    updatedAt: at(0),
    lastChatAt: at(30),
    ...over,
  } as unknown as Topic;
}

function message(id: string, n: number, userId = OTHER): ChatMessage {
  return {
    id,
    userId,
    topicId: 'unused',
    nickname: userId === ME ? 'me' : 'other',
    type: 'message',
    createdAt: at(n),
    sealed: { ciphertext: 'x', epoch: 0 },
  } as unknown as ChatMessage;
}

function fetchMock(topics: Topic[], chatByTopic: Record<string, ChatMessage[]>) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    // Specific branch FIRST: `/api/topics/{id}/chat` also contains `/api/topics`.
    const chatMatch = url.match(/\/api\/topics\/([^/?]+)\/chat/);
    if (chatMatch) {
      const messages = chatByTopic[chatMatch[1]] ?? [];
      return {
        ok: true,
        status: 200,
        json: async () => ({ messages, total: messages.length }),
        text: async () => '',
      } as unknown as Response;
    }
    if (url.includes('/api/topics')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ topics }),
        text: async () => '',
      } as unknown as Response;
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => '' } as unknown as Response;
  });
}

/** Text nodes whose entire content is a bare badge shape. Same rule as
 *  `chatListUnreadBadge.test.tsx` — see the note there. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function badgeTexts(root: any): string[] {
  return root
    .findAll((n: any) => typeof n.type === 'string' && n.type === 'Text')
    .map((n: any) => n.children.filter((c: unknown) => typeof c === 'string').join(''))
    .filter((t: string) => /^\d+$/.test(t) || t === '99+');
}

/** Render the list against one topic + its window, and return the badges. */
async function badgesFor(t: Topic, messages: ChatMessage[]): Promise<string[]> {
  vi.stubGlobal('fetch', fetchMock([t], { [(t as unknown as { id: string }).id]: messages }));
  const { rendered } = await renderScreen(<ChatListScreen />);
  await settleTimers();
  const badges = badgeTexts(rendered.root);
  rendered.unmount();
  return badges;
}

beforeEach(() => {
  resetChatReadCursors();
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
  resetChatReadCursors();
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

describe('ChatListScreen — seeding the read cursor from the server', () => {
  it('CONTRACT: a cursor mid-window badges only the messages NEWER than it', async () => {
    // The room was read up to m1 on another device. This process has never
    // opened it, so without seeding all three would badge.
    const id = freshTopicId();
    const badges = await badgesFor(topic(id, { lastReadMessageId: 'm1', lastReadAt: at(10) }), [
      message('m3', 30),
      message('m2', 20),
      message('m1', 10),
    ]);
    expect(badges).toEqual(['2']);
  });

  it('BOUNDARY: a cursor AT the newest message badges nothing', async () => {
    const id = freshTopicId();
    const badges = await badgesFor(topic(id, { lastReadMessageId: 'm3', lastReadAt: at(30) }), [
      message('m3', 30),
      message('m2', 20),
      message('m1', 10),
    ]);
    expect(badges, 'the cursor is inclusive').toEqual([]);
  });

  it('BOUNDARY: a room with NO server cursor still badges its whole window', async () => {
    // The never-read case must survive the seeding, not be swallowed by it.
    const id = freshTopicId();
    const badges = await badgesFor(topic(id, { lastReadMessageId: null, lastReadAt: null }), [
      message('m3', 30),
      message('m2', 20),
      message('m1', 10),
    ]);
    expect(badges).toEqual(['3']);
  });

  it('EMPTY: a half-populated cursor is ignored rather than half-applied', async () => {
    const idA = freshTopicId();
    expect(
      await badgesFor(topic(idA, { lastReadMessageId: 'm2', lastReadAt: null }), [
        message('m2', 20),
        message('m1', 10),
      ]),
      'an id with no instant cannot be ordered against anything',
    ).toEqual(['2']);

    vi.unstubAllGlobals();
    resetChatReadCursors();

    const idB = freshTopicId();
    expect(
      await badgesFor(topic(idB, { lastReadMessageId: null, lastReadAt: at(20) }), [
        message('m2', 20),
        message('m1', 10),
      ]),
      'an instant with no id names no row',
    ).toEqual(['2']);
  });

  it('HOSTILE: an unparsable lastReadAt seeds nothing', async () => {
    const id = freshTopicId();
    const badges = await badgesFor(
      topic(id, { lastReadMessageId: 'm2', lastReadAt: 'not-a-date' }),
      [message('m2', 20), message('m1', 10)],
    );
    expect(badges).toEqual(['2']);
  });

  it('RACE: a local cursor already FURTHER along is not dragged back', async () => {
    /*
     * The user read this room a second ago on this device; the debounced PUT
     * has not landed, so the list response still carries the OLD cursor. Seeding
     * through the monotonic `markChatRead` is what stops that response from
     * resurrecting a badge the user just cleared.
     */
    const id = freshTopicId();
    expect(markChatRead(id, { id: 'm3', createdAt: at(30) })).toBe(true);
    const badges = await badgesFor(topic(id, { lastReadMessageId: 'm1', lastReadAt: at(10) }), [
      message('m3', 30),
      message('m2', 20),
      message('m1', 10),
    ]);
    expect(badges, 'a stale server cursor must not rewind a local advance').toEqual([]);
  });
});
