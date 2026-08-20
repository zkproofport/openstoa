/**
 * Acting on a `key-needed` push that nobody tapped.
 *
 * The account event stream only reaches a device that has the app open, which
 * is not the device this matters for: the one holding a scoped topic's keys is
 * usually closed and in a pocket. The push is what reaches it — and until now
 * the mini-app only listened for TAPS, so handing the keys over depended on
 * somebody noticing a banner and pressing it. This module is the delivery path.
 *
 * Everything it does is filtering, and filtering is where this goes wrong
 * quietly: acting on a chat-message push, passing a junk id into a REST URL, or
 * letting a thrown callback escape into an OS listener.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage here
 *   contract   → a key-needed delivery yields its topic, in both the flat and
 *                the Expo `body`-nested payload shapes
 *   boundary   → any other `kind` — including a chat message, the common case —
 *                yields nothing
 *   hostile    → non-string, path-shaped, and non-uuid topic ids are refused;
 *                so is a `kind` that merely looks like the real one
 *   empty      → no data, no kind, empty strings
 *   very large → a 100k-character id is refused by shape, not by length
 *   UTF-8      → a Cyrillic homoglyph in `kind` is a different string
 *   external   → a host with no support, a host that throws on subscribe, and a
 *                callback that throws are all clean no-ops
 *   contract   → unsubscribing reaches the host's own teardown
 *   race / authz → N/A: the in-flight guard and the guest check live in
 *                `useAccountEvents`, which owns the grant.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  KEY_NEEDED_KIND,
  extractPushKind,
  keyNeededTopicId,
  subscribeKeyNeededPushes,
  type PushReceivedHost,
} from '../hooks/pushReceived';
import type { PushNotificationTap } from '../hooks/pushTapRouting';

const TOPIC = '11111111-2222-4333-8444-555555555555';

const tap = (data: unknown): PushNotificationTap => ({ data } as PushNotificationTap);

describe('keyNeededTopicId', () => {
  it('CONTRACT: a key-needed delivery names its topic', () => {
    expect(keyNeededTopicId(tap({ kind: KEY_NEEDED_KIND, topicId: TOPIC, epoch: 4 }))).toBe(TOPIC);
  });

  it('CONTRACT: the Expo `body`-nested shape works too', () => {
    // Expo nests the message `data` under `body`, and expo-notifications
    // unwraps that on most but not all transports — so both shapes occur.
    expect(keyNeededTopicId(tap({ body: { kind: KEY_NEEDED_KIND, topicId: TOPIC } }))).toBe(TOPIC);
    expect(
      keyNeededTopicId(tap({ body: JSON.stringify({ kind: KEY_NEEDED_KIND, topicId: TOPIC }) })),
    ).toBe(TOPIC);
  });

  it('BOUNDARY: a chat-message push is not this module’s business', () => {
    // The common delivery by far. Granting on every message would be a pass
    // over every leaf in the room for every line typed.
    expect(keyNeededTopicId(tap({ kind: 'chat-message', topicId: TOPIC, messageId: 'm1' }))).toBeNull();
  });

  it.each([
    ['no kind at all', { topicId: TOPIC }],
    ['an empty kind', { kind: '', topicId: TOPIC }],
    ['a non-string kind', { kind: 7, topicId: TOPIC }],
    ['a kind with trailing space', { kind: 'key-needed ', topicId: TOPIC }],
    ['a Cyrillic homoglyph kind', { kind: 'kеy-needed', topicId: TOPIC }],
    ['an underscored variant', { kind: 'key_needed', topicId: TOPIC }],
  ])('BOUNDARY/UTF-8: %s grants nothing', (_label, data) => {
    expect(keyNeededTopicId(tap(data))).toBeNull();
  });

  it.each([
    ['no topicId', { kind: KEY_NEEDED_KIND }],
    ['an empty topicId', { kind: KEY_NEEDED_KIND, topicId: '' }],
    ['a null topicId', { kind: KEY_NEEDED_KIND, topicId: null }],
    ['a numeric topicId', { kind: KEY_NEEDED_KIND, topicId: 42 }],
    ['a path-shaped topicId', { kind: KEY_NEEDED_KIND, topicId: '../../admin' }],
    ['a topicId with a query string', { kind: KEY_NEEDED_KIND, topicId: `${TOPIC}?x=1` }],
    ['a non-uuid string', { kind: KEY_NEEDED_KIND, topicId: 'not-a-uuid' }],
  ])('HOSTILE/EMPTY: %s grants nothing', (_label, data) => {
    // A junk id would be interpolated straight into the chat REST URLs.
    expect(keyNeededTopicId(tap(data))).toBeNull();
  });

  it('VERY LARGE: a 100k-character id is refused by shape', () => {
    expect(keyNeededTopicId(tap({ kind: KEY_NEEDED_KIND, topicId: 'a'.repeat(100_000) }))).toBeNull();
  });

  it.each([
    ['empty data', {}],
    ['an array', [1, 2, 3]],
    ['a bare string', 'nonsense'],
    ['null', null],
    ['undefined', undefined],
  ])('EMPTY/HOSTILE: %s is a silent null', (_label, data) => {
    expect(keyNeededTopicId(tap(data))).toBeNull();
  });

  it('EMPTY: a missing tap is a null, not a throw', () => {
    expect(keyNeededTopicId(undefined as unknown as PushNotificationTap)).toBeNull();
  });
});

describe('extractPushKind', () => {
  it('CONTRACT: it reads the kind through the Expo envelope', () => {
    expect(extractPushKind(tap({ kind: 'chat-message' }))).toBe('chat-message');
    expect(extractPushKind(tap({ body: { kind: 'chat-message' } }))).toBe('chat-message');
    expect(extractPushKind(tap({}))).toBeNull();
  });
});

describe('subscribeKeyNeededPushes', () => {
  function hostWith(): { host: PushReceivedHost; emit(data: unknown): void; removed: boolean[] } {
    let listener: ((t: PushNotificationTap) => void) | null = null;
    const removed: boolean[] = [];
    return {
      removed,
      emit: (data) => listener?.(tap(data)),
      host: {
        onPushNotificationReceived(l) {
          listener = l;
          return () => removed.push(true);
        },
      },
    };
  }

  it('CONTRACT: a delivery reaches the callback with its topic', () => {
    const { host, emit } = hostWith();
    const onKeyNeeded = vi.fn();
    subscribeKeyNeededPushes(host, onKeyNeeded);

    emit({ kind: KEY_NEEDED_KIND, topicId: TOPIC });

    expect(onKeyNeeded).toHaveBeenCalledWith(TOPIC);
  });

  it('CONTRACT: unsubscribing reaches the host teardown', () => {
    const { host, removed } = hostWith();
    subscribeKeyNeededPushes(host, vi.fn())();

    expect(removed).toEqual([true]);
  });

  it('EXTERNAL: a host without support is a clean no-op', () => {
    // An older host binary, or the standalone shell. Losing the fallback costs
    // a delay the account stream and room entry both still cover.
    const unsubscribe = subscribeKeyNeededPushes({}, vi.fn());
    expect(() => unsubscribe()).not.toThrow();
  });

  it('EXTERNAL: a host that throws on subscribe is a clean no-op', () => {
    const host: PushReceivedHost = {
      onPushNotificationReceived() {
        throw new Error('native module missing');
      },
    };

    let unsubscribe: () => void = () => {};
    expect(() => {
      unsubscribe = subscribeKeyNeededPushes(host, vi.fn());
    }).not.toThrow();
    expect(() => unsubscribe()).not.toThrow();
  });

  it('EXTERNAL: a host that throws on teardown does not break unmount', () => {
    const host: PushReceivedHost = {
      onPushNotificationReceived() {
        return () => {
          throw new Error('already gone');
        };
      },
    };

    expect(() => subscribeKeyNeededPushes(host, vi.fn())()).not.toThrow();
  });

  it('EXTERNAL: a callback that throws does not escape into the OS listener', () => {
    // This runs from an expo-notifications callback; an exception there is an
    // unhandled rejection in the host app, for a payload we chose to act on.
    const { host, emit } = hostWith();
    subscribeKeyNeededPushes(host, () => {
      throw new Error('grant blew up');
    });

    expect(() => emit({ kind: KEY_NEEDED_KIND, topicId: TOPIC })).not.toThrow();
  });

  it('BOUNDARY: other deliveries never reach the callback', () => {
    const { host, emit } = hostWith();
    const onKeyNeeded = vi.fn();
    subscribeKeyNeededPushes(host, onKeyNeeded);

    emit({ kind: 'chat-message', topicId: TOPIC });
    emit({ kind: KEY_NEEDED_KIND, topicId: 'junk' });
    emit(null);

    expect(onKeyNeeded).not.toHaveBeenCalled();
  });
});
