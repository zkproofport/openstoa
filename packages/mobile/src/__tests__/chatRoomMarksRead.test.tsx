/**
 * BEING IN THE ROOM IS READING IT — mounted for real.
 *
 * THE DEFECT: "tap the push notification, land in the room, read it, come back
 * out, and the chat list still badges every one of those messages as unread."
 * The marker was owned by `ChatListScreen` and written from a row's `onPress`,
 * so it recorded TAPPING A ROW, not being in a room. The push route
 * (`ChatListScreen`'s pending-tap effect) calls `navigation.navigate` and
 * nothing else, so it wrote nothing — and so did a deep link, the DM list, and
 * a `push` from one room into another.
 *
 * The fix moves the writer into `ChatRoomScreen`, which every one of those
 * routes has in common. That is exactly what this file has to prove, and it
 * cannot be proved by spying on a call: what matters is that the cursor ends up
 * holding the newest message the room actually rendered. So these mount the
 * whole screen against a real query client and read the cursor back.
 *
 * `chatReadCursor.test.ts` pins the store's rules; `chatListUnreadSeenMarker`
 * pins that a written cursor clears the badge. This is the join between them —
 * the piece that was missing, and the piece that a mock of either end would
 * have certified as working while the shipped app did nothing.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage here
 *   contract     — mounting the room records its newest message
 *   contract     — no fixture press, no navigation: the room is reached the way
 *                  a push tap reaches it (mounted directly on its route), which
 *                  is the case that was broken
 *   integrity    — a row this device cannot decrypt still counts as read (every
 *                  fixture row is sealed and unopenable here); it was on
 *                  screen, and refusing would strand the badge forever
 *   integrity    — the cursor takes the NEWEST row, not the first or last one
 *                  the fetch happened to hand over
 *   empty        — a room with no history records nothing rather than a null
 *                  cursor
 *   hostile      — a history row with no id or no timestamp is stepped over
 *   race/authz/UTF-8/very large/boundary — N/A or covered in
 *                  `chatReadCursor.test.ts`, which exercises the same store
 *                  directly without paying for a mount per case.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { act } from 'react-test-renderer';
import { renderScreen } from './harness/screen';
import { getChatReadCursor, resetChatReadCursors } from '../lib/chatReadCursor';

/**
 * PARTIAL mock: only the two session STORES are doubled. `toDisplayMessageMls`
 * — the thing that turns a wire row into a row on screen — stays REAL, so the
 * rows this file counts as read are rows the shipped decode produced.
 *
 * The doubles REFUSE rather than succeed: `openCached` resolves to `null`,
 * which is what the real store does on a device that cannot open a message,
 * and which the real `toDisplayMessageMls` turns into the "[unable to decrypt]"
 * placeholder. That is the point of the fixture, not a shortcut around it —
 * being in the room is reading it whether or not this device holds the key.
 *
 * Un-doubled without them, the real stores try to bootstrap an MLS group: the
 * mount fires `/mls/group-info` in a retry loop and the history decode never
 * settles, so every assertion here reads "not yet" and the file would fail for
 * a reason that has nothing to do with the cursor.
 *
 * Anything the screen reaches for that is NOT listed is recorded in
 * `missingStoreMethods` and asserted empty, so a future dependency shows up as
 * a named gap instead of an `undefined is not a function` swallowed by one of
 * the mount effects' `.catch(() => {})`.
 */
const missingStoreMethods: string[] = [];

function storeDouble(methods: Record<string, (...args: never[]) => unknown>) {
  return new Proxy(methods, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      return (...args: never[]) => {
        missingStoreMethods.push(prop);
        void args;
        return Promise.resolve(null);
      };
    },
  });
}

const mlsDouble = storeDouble({
  openCached: async () => null,
  open: async () => null,
  seal: async () => ({ ciphertext: 'ct', epoch: 0 }),
  cachePlaintext: async () => {},
  reconcileMembership: async () => {},
});

const takDouble = storeDouble({
  backfill: async () => [],
  myDeviceId: async () => 'device-1',
  publicRootFingerprint: async () => null,
  archiveRootState: async () => null,
  distributeRootWhenGroupChanged: async () => {},
  grantPrivateHistory: async () => {},
  backfillMissingArchive: async () => {},
  takForPush: async () => null,
  forgetUnsettledRoot: () => {},
  sealForPush: async () => null,
  archiveOnSend: async () => {},
});

vi.mock('../crypto/mobileTransport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../crypto/mobileTransport')>();
  return { ...actual, getMlsSessionStore: () => mlsDouble, getTakSessionStore: () => takDouble };
});

const { ChatRoomScreen } = await import('../screens/chat/ChatRoomScreen');

const TOPIC = '11111111-2222-4333-8444-555555555555';
const OTHER = 'nullifier-other';

interface WireMessage {
  id?: string;
  topicId: string;
  userId: string;
  nickname: string;
  type: string;
  createdAt?: string;
  message?: string | null;
  sealed?: { ciphertext: string; epoch: number } | null;
}

function at(seconds: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString();
}

/** A sealed row exactly as the wire carries it — no plaintext, which is what
 *  this device will fail to open. That is the normal case, not an edge one. */
function sealedRow(id: string, seconds: number): WireMessage {
  return {
    id,
    topicId: TOPIC,
    userId: OTHER,
    nickname: 'other',
    type: 'message',
    createdAt: at(seconds),
    message: null,
    sealed: { ciphertext: `ct-${id}`, epoch: 0 },
  };
}

/**
 * `renderScreen` drains MICROTASKS; react-query's notifyManager hands its
 * results back through a real `setTimeout(0)`, so a mount alone leaves the
 * history fetch un-delivered and every cursor assertion reads "not yet". Same
 * helper, same reason, as the chat-list render tests next door.
 */
async function settle(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** Mount the room on its route and let its history land. */
async function enterRoom() {
  const { rendered } = await renderScreen(<ChatRoomScreen />);
  await settle();
  return rendered;
}

/** History the room will fetch, swapped per test before mounting. */
let history: WireMessage[] = [];

beforeEach(() => {
  resetChatReadCursors();
  missingStoreMethods.length = 0;
  history = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.includes('/chat/media')
        ? { ciphertext: '' }
        : url.includes('/chat')
          ? { messages: history, total: history.length }
          : { messages: [], total: 0, topic: { visibility: 'public' }, members: [] };
      return { ok: true, status: 200, json: async () => body, text: async () => '' } as unknown as Response;
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ChatRoomScreen — entering a room records how far it has been read', () => {
  it('CONTRACT: mounting the room marks its newest message read', async () => {
    // The room is mounted straight onto its route with no list underneath and
    // nothing pressed — which is precisely how a push-notification tap arrives.
    // Every row is sealed and unopenable on this device, which is deliberate
    // and is the INTEGRITY case as well as the contract one: a locked row was
    // still on screen, and refusing to record it would leave the badge stuck on
    // a message the user has no way to clear.
    history = [sealedRow('m3', 30), sealedRow('m2', 20), sealedRow('m1', 10)];

    const rendered = await enterRoom();

    const cursor = getChatReadCursor(TOPIC);
    expect(
      cursor,
      'entering the room recorded nothing — the chat list will re-badge every message just read',
    ).toBeDefined();
    expect(cursor).toEqual({ messageId: 'm3', createdAt: at(30) });
    expect(
      missingStoreMethods,
      'the screen reached for a store method this fixture does not model',
    ).toEqual([]);
    rendered.unmount();
  });

  it('EMPTY: a room with no history records nothing at all', async () => {
    history = [];
    const rendered = await enterRoom();
    expect(
      getChatReadCursor(TOPIC),
      'an empty room must not fabricate a cursor — the next message would be swallowed',
    ).toBeUndefined();
    rendered.unmount();
  });

  it('HOSTILE: a history row with no id or no timestamp is stepped over', async () => {
    // Neither can come from the real route, which is the point: if one ever
    // does, the cursor must fall back to the newest row it CAN record rather
    // than parking on a `NaN` date or an undefined id.
    history = [
      { topicId: TOPIC, userId: OTHER, nickname: 'other', type: 'message', createdAt: at(40) },
      { ...sealedRow('m2', 20), createdAt: undefined },
      sealedRow('m1', 10),
    ];

    const rendered = await enterRoom();
    expect(getChatReadCursor(TOPIC)).toEqual({ messageId: 'm1', createdAt: at(10) });
    rendered.unmount();
  });
});
