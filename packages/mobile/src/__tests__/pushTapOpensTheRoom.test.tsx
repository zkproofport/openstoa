/*
 * WHY THIS EXISTS. "Tapping the notification opens THAT ROOM, not the list."
 *
 * `pushTapRouting.test.ts` covers the latch thoroughly — 30 cases across
 * payload flattening, uuid validation, hostile ids, double delivery, cold-start
 * survival and guest clearing. Every one of them passes without the room ever
 * opening, because that module says so itself: it owns "turning a raw host tap
 * into a validated topic id", and explicitly NOT navigation. The two places
 * that act on the latch — `OpenStoaTabNavigator` focusing the Chat tab, and
 * `ChatListScreen` pushing the room — had no test at all.
 *
 * So deleting `takePendingChatTopicId()` from `ChatListScreen` left all 30
 * latch cases green while a tapped notification dropped the reader on the LIST:
 * the exact symptom the checklist item names, invisible to the suite that looks
 * like it covers it. Verified by mutation before this file was written.
 *
 * Written 2026-08-26. The device path could not be exercised end-to-end — the
 * local stack has no Expo/FCM credentials, so no real push can be delivered to
 * it — which is precisely why the behaviour needs a guard that does not depend
 * on one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { act } from 'react-test-renderer';

import { renderScreen, navDouble } from './harness/screen';
import { useOpenStoaSession } from '../stores/sessionStore';
import { ChatListScreen } from '../screens/chat/ChatListScreen';
import { routePushTap, clearPendingChatTopic } from '../hooks/pushTapRouting';
import type { Topic } from '@openstoa/api-types';

const ME = 'nullifier-me';

/*
 * A UNIQUE notification id per tap. `routePushTap` remembers the ids it has
 * already routed — that is its `DOUBLE-DELIVERY` contract, and the memo is a
 * module singleton that outlives any one test. Reusing `'n1'` made the second
 * and later taps in this file silent no-ops, which read as "the room did not
 * open" until the dedup test in `pushTapRouting.test.ts` explained it.
 */
let tapSeq = 0;
const nextTapId = () => `n-${(tapSeq += 1)}`;
const ROOM = '11111111-2222-4333-8444-aaaaaaaaaaaa';
const OTHER_ROOM = '11111111-2222-4333-8444-bbbbbbbbbbbb';

function topic(id: string, title: string): Topic {
  return {
    id,
    title,
    description: '',
    visibility: 'public',
    memberCount: 2,
    createdAt: new Date().toISOString(),
  } as unknown as Topic;
}

function fetchMock(topics: Topic[]) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    // Specific branch first: `/api/topics/{id}/chat` also contains `/api/topics`.
    if (/\/api\/topics\/[^/?]+\/chat/.test(url)) {
      return { ok: true, status: 200, json: async () => ({ messages: [], total: 0 }), text: async () => '' } as unknown as Response;
    }
    if (url.includes('/api/topics')) {
      return { ok: true, status: 200, json: async () => ({ topics }), text: async () => '' } as unknown as Response;
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => '' } as unknown as Response;
  });
}

/*
 * Screens rendered by `renderScreen` stay mounted until something unmounts
 * them, and `ChatListScreen` consumes the latch the moment one appears. A
 * screen left over from an earlier case therefore ate the NEXT case's tap
 * before its own screen had mounted — which read as "the room did not open"
 * for every case after the first. Each case now tears its own screen down.
 */
const mounted: Array<{ unmount: () => void }> = [];
function track<T extends { rendered: { unmount: () => void } }>(h: T): T {
  mounted.push(h.rendered);
  return h;
}

async function settle(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** Every `navigate('ChatRoom', …)` the screen made, in order. */
function roomsOpened(nav: ReturnType<typeof navDouble>): string[] {
  return nav.navigate.calls
    .filter((args) => args[0] === 'ChatRoom')
    .map((args) => (args[1] as { topicId?: string } | undefined)?.topicId ?? '(no topicId)');
}

beforeEach(() => {
  clearPendingChatTopic();
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
  while (mounted.length) {
    try {
      mounted.pop()?.unmount();
    } catch {
      // A screen that is already gone is not a failure of this cleanup.
    }
  }
  vi.unstubAllGlobals();
  clearPendingChatTopic();
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

describe('a tapped notification opens the room, not the list', () => {
  it('CONTRACT: the latched topic is navigated to, with its title', async () => {
    vi.stubGlobal('fetch', fetchMock([topic(ROOM, 'The tapped room')]));
    routePushTap({ id: nextTapId(), data: { topicId: ROOM } });

    const nav = navDouble();
    track(await renderScreen(<ChatListScreen />, { nav }));
    await settle();

    expect(roomsOpened(nav)).toEqual([ROOM]);
    const call = nav.navigate.calls.find((a) => a[0] === 'ChatRoom');
    expect(call?.[1]).toMatchObject({ topicId: ROOM, kind: 'topic' });
  });

  it('INTEGRITY: consuming the latch means a remount does not reopen the room', async () => {
    /*
     * The failure this catches is not "nothing opens" but "it opens again" —
     * a reader who backed out of the room would be dragged straight back in,
     * every time this screen remounted.
     */
    vi.stubGlobal('fetch', fetchMock([topic(ROOM, 'The tapped room')]));
    routePushTap({ id: nextTapId(), data: { topicId: ROOM } });

    const first = navDouble();
    track(await renderScreen(<ChatListScreen />, { nav: first }));
    await settle();
    expect(roomsOpened(first)).toEqual([ROOM]);

    const second = navDouble();
    track(await renderScreen(<ChatListScreen />, { nav: second }));
    await settle();
    expect(roomsOpened(second)).toEqual([]);
  });

  it('BOUNDARY: with no tap latched, the list stays a list', async () => {
    // The control. Without it, a test that navigates unconditionally passes.
    vi.stubGlobal('fetch', fetchMock([topic(ROOM, 'Untapped')]));

    const nav = navDouble();
    track(await renderScreen(<ChatListScreen />, { nav }));
    await settle();

    expect(roomsOpened(nav)).toEqual([]);
  });

  it('HOSTILE: a junk topic id never reaches navigation', async () => {
    vi.stubGlobal('fetch', fetchMock([topic(ROOM, 'Untouched')]));
    routePushTap({ id: nextTapId(), data: { topicId: '../../etc/passwd' } });

    const nav = navDouble();
    track(await renderScreen(<ChatListScreen />, { nav }));
    await settle();

    expect(roomsOpened(nav)).toEqual([]);
  });

  it('BOUNDARY: the room opens even when it is not in the loaded topic list', async () => {
    /*
     * A push can name a room this list has never fetched — a topic joined on
     * another device, or a list that has not landed yet. The screen passes the
     * title as a nicety; refusing to navigate without one would strand the tap.
     */
    vi.stubGlobal('fetch', fetchMock([topic(OTHER_ROOM, 'Some other room')]));
    routePushTap({ id: nextTapId(), data: { topicId: ROOM } });

    const nav = navDouble();
    track(await renderScreen(<ChatListScreen />, { nav }));
    await settle();

    expect(roomsOpened(nav)).toEqual([ROOM]);
  });

  it('AUTHZ: a guest is not navigated into a room', async () => {
    useOpenStoaSession.setState({
      mode: 'guest',
      token: null,
      userId: null,
      nickname: null,
      needsNickname: false,
      expiresAt: null,
      role: 'member',
    });
    vi.stubGlobal('fetch', fetchMock([topic(ROOM, 'Members only')]));
    routePushTap({ id: nextTapId(), data: { topicId: ROOM } });

    const nav = navDouble();
    track(await renderScreen(<ChatListScreen />, { nav }));
    await settle();

    expect(roomsOpened(nav)).toEqual([]);
  });
});
