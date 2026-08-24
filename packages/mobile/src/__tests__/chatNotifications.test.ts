/**
 * Per-conversation notification clearing (see ../lib/chatNotifications).
 *
 * Every case is written so that the plausible wrong answers fail it: clearing
 * the whole tray, clearing on entry only, and forgetting the room that was
 * just opened when the previous one blurs afterwards.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  clearActiveChatNotifications,
  clearTopicNotifications,
  enterChatRoom,
  getActiveChatTopicId,
  leaveChatRoom,
  resetChatNotifications,
} from '../lib/chatNotifications';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

function hostWithSpy() {
  const cleared: string[] = [];
  return {
    cleared,
    host: {
      clearTopicNotifications: async (topicId: string) => {
        cleared.push(topicId);
      },
    },
  };
}

beforeEach(() => {
  resetChatNotifications();
});

describe('clearTopicNotifications', () => {
  it('asks the host for exactly the conversation named', () => {
    const h = hostWithSpy();
    expect(clearTopicNotifications(h.host, A)).toBe(true);
    expect(h.cleared).toEqual([A]);
  });

  it('trims a padded id before handing it over', () => {
    const h = hostWithSpy();
    expect(clearTopicNotifications(h.host, `  ${A}  `)).toBe(true);
    expect(h.cleared).toEqual([A]);
  });

  it('refuses anything that is not a topic id — never a wildcard clear', () => {
    for (const bad of [undefined, null, '', '   ', 'all', '*', '%', 42, {}, [], `${A}/../x`]) {
      const h = hostWithSpy();
      expect(clearTopicNotifications(h.host, bad)).toBe(false);
      expect(h.cleared).toEqual([]);
    }
  });

  it('degrades to a no-op on a host without the capability', () => {
    expect(clearTopicNotifications(null, A)).toBe(false);
    expect(clearTopicNotifications(undefined, A)).toBe(false);
    expect(clearTopicNotifications({}, A)).toBe(false);
  });

  it('swallows a host that throws synchronously', () => {
    const host = {
      clearTopicNotifications: () => {
        throw new Error('native module missing');
      },
    };
    expect(() => clearTopicNotifications(host as never, A)).not.toThrow();
  });

  it('swallows a host that rejects', async () => {
    const rejection = vi.fn();
    process.on('unhandledRejection', rejection);
    const host = { clearTopicNotifications: async () => { throw new Error('no permission'); } };
    expect(clearTopicNotifications(host, A)).toBe(true);
    await new Promise((resolve) => setImmediate(resolve));
    process.off('unhandledRejection', rejection);
    expect(rejection).not.toHaveBeenCalled();
  });
});

describe('enterChatRoom / leaveChatRoom', () => {
  it('clears on entry and remembers the room', () => {
    const h = hostWithSpy();
    enterChatRoom(h.host, A);
    expect(h.cleared).toEqual([A]);
    expect(getActiveChatTopicId()).toBe(A);
  });

  it('forgets the room on leaving it', () => {
    const h = hostWithSpy();
    enterChatRoom(h.host, A);
    leaveChatRoom(A);
    expect(getActiveChatTopicId()).toBeNull();
  });

  it('keeps the NEW room when the old one blurs after it focused', () => {
    // Pushing B on top of A can deliver B's focus before A's blur. An
    // unconditional blur handler would forget B the moment it opened, and the
    // foreground re-clear would then do nothing for the room on screen.
    const h = hostWithSpy();
    enterChatRoom(h.host, A);
    enterChatRoom(h.host, B);
    leaveChatRoom(A);
    expect(getActiveChatTopicId()).toBe(B);
  });

  it('drops the stale room when entered with an unusable id', () => {
    const h = hostWithSpy();
    enterChatRoom(h.host, A);
    enterChatRoom(h.host, undefined);
    expect(getActiveChatTopicId()).toBeNull();
    expect(h.cleared).toEqual([A]);
  });

  it('ignores a leave for an id that is not a topic id', () => {
    const h = hostWithSpy();
    enterChatRoom(h.host, A);
    leaveChatRoom('');
    leaveChatRoom(null);
    expect(getActiveChatTopicId()).toBe(A);
  });

  it('never touches another conversation', () => {
    const h = hostWithSpy();
    enterChatRoom(h.host, A);
    expect(h.cleared).not.toContain(B);
  });
});

describe('clearActiveChatNotifications', () => {
  it('re-clears the room on screen — the app-foreground path', () => {
    const h = hostWithSpy();
    enterChatRoom(h.host, A);
    expect(clearActiveChatNotifications(h.host)).toBe(true);
    expect(h.cleared).toEqual([A, A]);
  });

  it('does nothing when no room is open', () => {
    const h = hostWithSpy();
    expect(clearActiveChatNotifications(h.host)).toBe(false);
    expect(h.cleared).toEqual([]);
  });

  it('does nothing after the room was left', () => {
    const h = hostWithSpy();
    enterChatRoom(h.host, A);
    leaveChatRoom(A);
    h.cleared.length = 0;
    expect(clearActiveChatNotifications(h.host)).toBe(false);
    expect(h.cleared).toEqual([]);
  });

  it('clears the room on screen and not the one before it', () => {
    const h = hostWithSpy();
    enterChatRoom(h.host, A);
    enterChatRoom(h.host, B);
    h.cleared.length = 0;
    clearActiveChatNotifications(h.host);
    expect(h.cleared).toEqual([B]);
  });
});
