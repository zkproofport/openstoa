/**
 * `auth/sessionExpiry.ts` is a two-function leaf pub/sub: everything about
 * WHEN it fires is covered where it's actually wired (`sessionLifecycle.test.ts`,
 * `openstoaClient.test.ts`). This file only owns the pub/sub contract itself.
 *
 * Matrix rows covered: boundary (zero / one / many listeners), race
 * (unsubscribing mid-broadcast does not skip or double-call a sibling),
 * contract (unsubscribe actually detaches).
 */
import { describe, it, expect } from 'vitest';
import { notifySessionExpired, subscribeSessionExpired } from '../auth/sessionExpiry';

describe('auth/sessionExpiry — pub/sub contract', () => {
  it('notifying with zero subscribers is a silent no-op', () => {
    expect(() => notifySessionExpired()).not.toThrow();
  });

  it('a single subscriber is called exactly once per notify', () => {
    let calls = 0;
    const unsub = subscribeSessionExpired(() => {
      calls++;
    });
    notifySessionExpired();
    expect(calls).toBe(1);
    notifySessionExpired();
    expect(calls).toBe(2);
    unsub();
  });

  it('multiple subscribers all fire on one notify', () => {
    let a = 0;
    let b = 0;
    const unsubA = subscribeSessionExpired(() => {
      a++;
    });
    const unsubB = subscribeSessionExpired(() => {
      b++;
    });
    notifySessionExpired();
    expect(a).toBe(1);
    expect(b).toBe(1);
    unsubA();
    unsubB();
  });

  it('unsubscribe detaches — a later notify no longer reaches it', () => {
    let calls = 0;
    const unsub = subscribeSessionExpired(() => {
      calls++;
    });
    unsub();
    notifySessionExpired();
    expect(calls).toBe(0);
  });

  it('unsubscribing one listener does not affect a sibling still subscribed', () => {
    let a = 0;
    let b = 0;
    const unsubA = subscribeSessionExpired(() => {
      a++;
    });
    const unsubB = subscribeSessionExpired(() => {
      b++;
    });
    unsubA();
    notifySessionExpired();
    expect(a).toBe(0);
    expect(b).toBe(1);
    unsubB();
  });

  it('calling unsubscribe twice is harmless', () => {
    let calls = 0;
    const unsub = subscribeSessionExpired(() => {
      calls++;
    });
    unsub();
    expect(() => unsub()).not.toThrow();
    notifySessionExpired();
    expect(calls).toBe(0);
  });
});
