/**
 * The half of the unread badge that `chatListUnreadBadge.test.tsx` does not
 * reach: the READ CURSOR.
 *
 * That file pins what the badge says for a topic the viewer has never opened.
 * This one pins what happens once they have — the branches inside `countUnread`
 * that stop the walk at the cursor. It was written after a mutation check found
 * that deleting that line entirely left the whole suite green: every case over
 * there starts from an empty marker map, so the marker was never the thing being
 * measured, and a fix that silently stopped honouring it would have shipped (the
 * badge would simply never clear).
 *
 * THE "OPENED IT" STEP CHANGED, and the reason is the defect this lane fixed.
 * It used to be "press the row", because pressing the row was what wrote the
 * marker — and that was the bug: a marker written by the LIST records tapping a
 * row, not being in a room, so a push-notification tap (which navigates without
 * touching the list) recorded nothing and re-badged everything on the way back
 * out. The writer is now `ChatRoomScreen`, so the step here is the call the room
 * makes, `markChatRead`. That `ChatRoomScreen` really makes it is a separate
 * question with its own file — `chatRoomMarksRead.test.tsx` mounts the room and
 * reads the cursor back — and the two together are the whole chain, with a real
 * end on each side.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage here
 *   contract   — opening a room clears its badge: the count walks back to the
 *                cursor and finds nothing newer
 *   contract   — a room reached WITHOUT pressing its row (the push-notification
 *                route) clears the same way, which is the reported defect
 *   contract   — the badge clears while the list stays MOUNTED, which is the
 *                real sequence (the list sits underneath the open room) and the
 *                only case that needs the screen to watch the cursor store
 *   contract   — a PARTIAL read counts only what arrived after the cursor (3
 *                newer messages behind a cursor set at the oldest → "3", not
 *                the whole window) — the case that distinguishes "stops at the
 *                marker" from "ignores the marker"
 *   integrity  — a join/leave row between two unread messages is not counted
 *                AND does not end the walk, so the message beneath it still
 *                shows up
 *   boundary/authz/hostile/UTF-8/very large/race — N/A for the same reasons
 *                the sibling file gives: this is a client-side count over data
 *                whose fetch path is covered elsewhere, and it introduces no
 *                new input surface.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { act } from 'react-test-renderer';
import { renderScreen } from './harness/screen';
import { useOpenStoaSession } from '../stores/sessionStore';
import { markChatRead, resetChatReadCursors } from '../lib/chatReadCursor';
import { ChatListScreen } from '../screens/chat/ChatListScreen';
import type { ChatMessage, Topic } from '@openstoa/api-types';

/** See the sibling file: react-query's notifyManager batches through a real
 *  `setTimeout(0)` here, and this screen makes two dependent query hops. */
async function settleTimers(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

const ME = 'nullifier-me';
const OTHER = 'nullifier-other';

/** Fresh id per test as well as the reset in `beforeEach` — the topics query
 *  is cached per id, and reusing one would answer from a neighbour's window. */
let topicSeq = 0;
function freshTopicId(): string {
  topicSeq += 1;
  return `22222222-3333-4444-8555-${String(topicSeq).padStart(12, '0')}`;
}

function topic(id: string): Topic {
  return {
    id,
    title: `Room ${id.slice(-4)}`,
    creatorId: OTHER,
    requiresCountryProof: false,
    inviteCode: 'x',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastChatAt: new Date().toISOString(),
  } as unknown as Topic;
}

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

/** Every URL the screen asked for, so a test can assert what it REQUESTED and
 *  not only what it did with the answer. */
const requestedUrls: string[] = [];

/**
 * A mutable fetch double: the chat body is read at REQUEST time, so a test can
 * hand out one window, let the screen render it, then swap in a wider window
 * for the next mount — which is how "three more messages arrived while you were
 * away" is expressed without any timing games.
 *
 * It HONOURS `?limit=`, slicing the window the way the real route does
 * (`route.ts` applies the limit in the SQL). That is not tidiness: the sibling
 * file's double ignores the parameter, and because of that, reverting the
 * screen to the original `?limit=1` left its entire suite green — the fixture
 * kept handing back three messages the server would never have sent. A mock
 * that does not model the real thing's bounds certifies the broken thing as
 * working, which is exactly the failure mode this repo keeps hitting.
 */
function fetchMock(topics: Topic[], chat: { current: { messages: ChatMessage[]; total: number } }) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    requestedUrls.push(url);
    // Specific branch first: `/api/topics/{id}/chat` also contains `/api/topics`.
    if (/\/api\/topics\/[^/?]+\/chat/.test(url)) {
      const limit = Number(new URL(url, 'https://openstoa.test').searchParams.get('limit') ?? '50');
      const body = {
        total: chat.current.total,
        messages: chat.current.messages.slice(0, limit),
      };
      return { ok: true, status: 200, json: async () => body, text: async () => '' } as unknown as Response;
    }
    if (url.includes('/api/topics')) {
      return { ok: true, status: 200, json: async () => ({ topics }), text: async () => '' } as unknown as Response;
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => '' } as unknown as Response;
  });
}

/** Text nodes whose whole content is a bare badge shape. Same rationale as the
 *  sibling file: structural, not style-identity, because `makeStyles(colors)`
 *  rebuilds every style object on every render. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function badgeTexts(root: any): string[] {
  return root
    .findAll((n: any) => typeof n.type === 'string' && n.type === 'Text')
    .map((n: any) => n.children.filter((c: unknown) => typeof c === 'string').join(''))
    .filter((t: string) => /^\d+$/.test(t) || t === '99+');
}

beforeEach(() => {
  requestedUrls.length = 0;
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

/**
 * The user entered the room and read it.
 *
 * This is literally what `ChatRoomScreen` does on mount — `markChatRead` with
 * the newest row it rendered — so the fixture and the shipped writer cannot
 * drift into disagreeing about the cursor's shape.
 */
function readRoom(topicId: string, newest: ChatMessage): void {
  expect(markChatRead(topicId, newest), 'the fixture did not actually mark anything read').toBe(true);
}

/** Mount the list, wait for both query hops, and hand back the tree. */
async function mountList() {
  const { rendered, nav } = await renderScreen(<ChatListScreen />);
  await settleTimers();
  return { rendered, nav };
}

describe('ChatListScreen — the last-seen marker bounds the unread count', () => {
  it('CONTRACT: opening a room clears its badge', async () => {
    const t = freshTopicId();
    const chat = {
      current: {
        total: 3,
        messages: [
          message({ id: 'm3', userId: OTHER }),
          message({ id: 'm2', userId: OTHER }),
          message({ id: 'm1', userId: OTHER }),
        ],
      },
    };
    vi.stubGlobal('fetch', fetchMock([topic(t)], chat));

    const first = await mountList();
    expect(badgeTexts(first.rendered.root)).toEqual(['3']);

    // Pressing the row navigates and NOTHING ELSE — the list is no longer a
    // writer, which is what makes every route into the room behave the same.
    await first.rendered.press(first.rendered.pressableWith(`Room ${t.slice(-4)}`)!);
    expect(first.nav.navigate.calls.length, 'pressing the row should have navigated').toBe(1);
    // ...and then the room the press opened records what it rendered.
    readRoom(t, chat.current.messages[0]);
    first.rendered.unmount();

    // Come back to a list whose server data has NOT changed: everything in the
    // window is now at or behind the marker, so there is nothing to report.
    const second = await mountList();
    expect(
      badgeTexts(second.rendered.root),
      'the badge did not clear after the room was opened — the marker is being ignored',
    ).toEqual([]);
    second.rendered.unmount();
  });

  it('CONTRACT: a partial read counts only what arrived after the marker', async () => {
    const t = freshTopicId();
    const chat = {
      current: { total: 1, messages: [message({ id: 'old', userId: OTHER })] },
    };
    vi.stubGlobal('fetch', fetchMock([topic(t)], chat));

    // Read the room at 'old' — the cursor lands there.
    const first = await mountList();
    expect(badgeTexts(first.rendered.root)).toEqual(['1']);
    readRoom(t, chat.current.messages[0]);
    first.rendered.unmount();

    // Three more arrive on top of it while the user is elsewhere.
    chat.current = {
      total: 4,
      messages: [
        message({ id: 'new3', userId: OTHER }),
        message({ id: 'new2', userId: OTHER }),
        message({ id: 'new1', userId: OTHER }),
        message({ id: 'old', userId: OTHER }),
      ],
    };

    const second = await mountList();
    expect(
      badgeTexts(second.rendered.root),
      'expected only the messages newer than the marker to count',
    ).toEqual(['3']);
    second.rendered.unmount();
  });

  it('CONTRACT: the fetch window is wide enough to count past a small badge', async () => {
    // Five unread, against a fixture that OBEYS `?limit=`. Reverting the screen
    // to `?limit=1` makes this read "1" — the original bug — where the sibling
    // file's limit-blind double would keep reporting "5" and stay green.
    const t = freshTopicId();
    const chat = {
      current: {
        total: 5,
        messages: Array.from({ length: 5 }, (_, i) =>
          message({ id: `m${5 - i}`, userId: OTHER }),
        ),
      },
    };
    vi.stubGlobal('fetch', fetchMock([topic(t)], chat));

    const { rendered } = await mountList();
    expect(
      badgeTexts(rendered.root),
      'the badge under-counted — the screen did not fetch enough messages to count',
    ).toEqual(['5']);
    rendered.unmount();
  });

  it('CONTRACT: the requested limit reaches the badge cap, so "99+" is attainable', async () => {
    // The badge renders anything over 99 as "99+". A window narrower than 100
    // makes that arm unreachable no matter how busy the room is — which is what
    // made it dead code in the shipped app. Asserted on the REQUEST, because
    // the count alone cannot distinguish "asked for little" from "little there".
    const t = freshTopicId();
    const chat = { current: { total: 0, messages: [] as ChatMessage[] } };
    vi.stubGlobal('fetch', fetchMock([topic(t)], chat));

    const { rendered } = await mountList();

    const chatUrl = requestedUrls.find((u) => /\/api\/topics\/[^/?]+\/chat/.test(u));
    expect(chatUrl, 'the screen never requested chat history').toBeDefined();
    const limit = Number(new URL(chatUrl!, 'https://openstoa.test').searchParams.get('limit'));
    expect(
      limit,
      `chat history was requested with limit=${limit}; below 100 the "99+" badge can never render`,
    ).toBeGreaterThanOrEqual(100);

    rendered.unmount();
  });

  it('CONTRACT: a badge clears without the list being remounted or refocused', async () => {
    // The real sequence has no remount in it. The list stays mounted underneath
    // the open room the whole time, and the cursor lives in a module-level map
    // rather than in React state — so unless the screen SUBSCRIBES to it, the
    // badge is whatever it was when the row last happened to render. Every other
    // case in this file mounts a second time and would pass either way; this one
    // is the reason the subscription exists.
    const t = freshTopicId();
    const chat = {
      current: {
        total: 2,
        messages: [message({ id: 'm2', userId: OTHER }), message({ id: 'm1', userId: OTHER })],
      },
    };
    vi.stubGlobal('fetch', fetchMock([topic(t)], chat));

    const { rendered } = await mountList();
    expect(badgeTexts(rendered.root)).toEqual(['2']);

    // The room, opened on top of this list, records what it rendered.
    await act(async () => {
      readRoom(t, chat.current.messages[0]);
    });

    expect(
      badgeTexts(rendered.root),
      'the badge did not clear until the list was remounted — it is not watching the cursor',
    ).toEqual([]);
    rendered.unmount();
  });

  it('INTEGRITY: a system row is not counted and does not end the walk', async () => {
    const t = freshTopicId();
    const chat = {
      current: {
        total: 3,
        messages: [
          message({ id: 'm2', userId: OTHER }),
          // A join notice sitting between two unread messages. Counting it
          // would inflate the badge; stopping at it would hide `m1`.
          message({ id: 'sys', userId: OTHER, type: 'join', message: 'other joined' } as never),
          message({ id: 'm1', userId: OTHER }),
        ],
      },
    };
    vi.stubGlobal('fetch', fetchMock([topic(t)], chat));

    const { rendered } = await mountList();
    expect(badgeTexts(rendered.root)).toEqual(['2']);
    rendered.unmount();
  });
});
