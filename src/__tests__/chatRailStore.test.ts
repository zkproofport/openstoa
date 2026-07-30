/**
 * `chatRailStore.ts` — the module-level publish/subscribe store backing
 * `useChatRail()` (`chatRailContext.tsx`).
 *
 * This is the pure-logic layer: no React, no DOM. The React-facing contract
 * (a page component calling `useChatRail()` from ABOVE `CommunityLayout` in
 * the tree resolving to the published API — the exact bug this store fixes,
 * see `src/app/topics/[topicId]/members/page.tsx`) is exercised at the
 * component layer by `memberRowDmRail.test.tsx`.
 *
 * Edge-case matrix rows covered here:
 *   boundary — no publisher (null) vs. one publisher
 *   contract — publish notifies every subscriber; unsubscribe stops delivery
 *   race     — an unmount's cleanup must NOT clear a newer instance's publish
 *              (client-side navigation mounts the next page's CommunityLayout
 *              before the old one's cleanup effect runs)
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  getChatRailApi,
  getServerChatRailApi,
  publishChatRailApi,
  subscribeChatRailApi,
  __resetChatRailStore,
} from '@/lib/chatRailStore';

afterEach(() => {
  __resetChatRailStore();
});

describe('boundary', () => {
  it('BOUNDARY 0: no publisher yet returns null', () => {
    expect(getChatRailApi()).toBeNull();
  });

  it('BOUNDARY 1: after a publish, the exact published object is returned', () => {
    const api = { openRail: vi.fn() };
    publishChatRailApi(api);
    expect(getChatRailApi()).toBe(api);
  });

  it('the server snapshot is always null (SSR never has a mounted rail)', () => {
    publishChatRailApi({ openRail: vi.fn() });
    expect(getServerChatRailApi()).toBeNull();
  });
});

describe('contract — subscribe/notify', () => {
  it('every subscriber is notified on publish', () => {
    const a = vi.fn();
    const b = vi.fn();
    subscribeChatRailApi(a);
    subscribeChatRailApi(b);
    publishChatRailApi({ openRail: vi.fn() });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('an unsubscribed listener is not notified by a later publish', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeChatRailApi(listener);
    unsubscribe();
    publishChatRailApi({ openRail: vi.fn() });
    expect(listener).not.toHaveBeenCalled();
  });

  it('publishing the SAME object reference again does not re-notify (no-op dedupe)', () => {
    const api = { openRail: vi.fn() };
    publishChatRailApi(api);
    const listener = vi.fn();
    subscribeChatRailApi(listener);
    publishChatRailApi(api);
    expect(listener).not.toHaveBeenCalled();
  });

  it('publishing null clears the current API and notifies', () => {
    publishChatRailApi({ openRail: vi.fn() });
    const listener = vi.fn();
    subscribeChatRailApi(listener);
    publishChatRailApi(null);
    expect(getChatRailApi()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('race — stale unmount must not clobber a newer publish', () => {
  it('mirrors CommunityLayout: cleanup only clears if it is still the published instance', () => {
    // Simulates the exact pattern in CommunityLayout.tsx's publish effect.
    const apiA = { openRail: vi.fn() };
    const cleanupA = () => {
      if (getChatRailApi() === apiA) publishChatRailApi(null);
    };
    publishChatRailApi(apiA);

    // A fast client-side navigation mounts the NEXT page's CommunityLayout
    // (and publishes its own api) BEFORE the old instance's effect cleanup
    // runs.
    const apiB = { openRail: vi.fn() };
    publishChatRailApi(apiB);

    // Old instance's cleanup finally runs — it must be a no-op now.
    cleanupA();

    expect(getChatRailApi()).toBe(apiB);
  });
});
