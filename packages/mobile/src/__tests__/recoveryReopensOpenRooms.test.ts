/**
 * A ROOM LEFT OPEN THROUGH A RECOVERY STAYED LOCKED.
 *
 * Measured on R59T600DXYZ on 2026-08-27. A secret room was opened, the person
 * switched tabs, recovered with their code, and came back. All five epoch keys
 * were already restored — the log says so — and the room still read
 * `키를 기다리는 중…` a minute and a half later. Leaving the room and
 * re-entering opened it instantly. Nobody would guess to do that; they read a
 * recovery that reported success over an empty room as their messages being
 * gone, which is the one conclusion this whole feature exists to prevent.
 *
 * ── The fix that did NOT work, kept here because it looks right ───────────
 *
 * Invalidating the chat query from the recovery screen. Tried first, measured,
 * did nothing. The room decrypts inside its query function using the MLS
 * session it holds, and that session is a module singleton the recovery sets
 * to null so the next caller rebuilds it — and the room's next caller is its
 * next RENDER. An invalidation from another screen refetches immediately,
 * while the room still holds the dead session; the rows come back locked and
 * the entry is no longer stale, so returning refetches nothing.
 *
 * So the room moves first: it subscribes to a counter, a bump re-renders it,
 * and only then does it ask for its history again. Both steps live in one
 * component, where the order can be relied on.
 *
 * ── The cumulative axis ───────────────────────────────────────────────────
 *
 * Not "one bump reaches one listener". Every listener hears every bump, for as
 * many rooms as are open and as many times as the keys change — a device can
 * recover twice, and a person can have several rooms in the stack.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  bumpCryptoGeneration,
  getCryptoGeneration,
  subscribeCryptoGeneration,
} from '../crypto/mobileTransport';

function codeOf(rel: string): string {
  const raw = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  return raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('the key-change signal', () => {
  it('every listener hears every bump, however many of each', () => {
    const heard = [0, 0, 0];
    const off = heard.map((_, i) => subscribeCryptoGeneration(() => (heard[i] += 1)));
    const before = getCryptoGeneration();
    for (let n = 0; n < 5; n++) bumpCryptoGeneration();
    off.forEach((fn) => fn());
    expect(heard).toEqual([5, 5, 5]);
    expect(getCryptoGeneration()).toBe(before + 5);
  });

  it('the number only ever goes up, so a re-render cannot miss one', () => {
    const seen: number[] = [getCryptoGeneration()];
    for (let n = 0; n < 4; n++) {
      bumpCryptoGeneration();
      seen.push(getCryptoGeneration());
    }
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('a listener that throws does not silence the others', () => {
    const quiet = vi.fn();
    const off1 = subscribeCryptoGeneration(() => {
      throw new Error('this one is broken');
    });
    const off2 = subscribeCryptoGeneration(quiet);
    expect(() => bumpCryptoGeneration()).not.toThrow();
    expect(quiet).toHaveBeenCalledTimes(1);
    off1();
    off2();
  });

  it('unsubscribing really stops the notifications', () => {
    const fn = vi.fn();
    const off = subscribeCryptoGeneration(fn);
    bumpCryptoGeneration();
    off();
    bumpCryptoGeneration();
    bumpCryptoGeneration();
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('the two halves are wired', () => {
  const TRANSPORT = codeOf('crypto/mobileTransport.ts');
  const ROOM = codeOf('screens/chat/ChatRoomScreen.tsx');
  const RECOVERY = codeOf('screens/profile/AccountRecoveryScreen.tsx');

  it('the comment strip is real, or these pass on prose alone', () => {
    const raw = fs.readFileSync(path.join(__dirname, '..', 'crypto', 'mobileTransport.ts'), 'utf8');
    expect(TRANSPORT.length).toBeLessThan(raw.length);
    expect(TRANSPORT).not.toContain('a minute and a half later');
  });

  it('recovery raises the counter', () => {
    const fn = TRANSPORT.slice(TRANSPORT.indexOf('export async function recoverDevice'));
    const body = fn.slice(0, fn.indexOf('\n}') + 2);
    expect(body).toContain('importKeychain');
    expect(body).toContain('bumpCryptoGeneration()');
  });

  it('the room listens to it and asks for its history again', () => {
    /*
     * The CALL, not the names. Checking that the identifiers appear anywhere
     * passed while the subscription itself was replaced with a constant —
     * they were still up in the import line, which is worth nothing.
     */
    expect(ROOM).toMatch(
      /useSyncExternalStore\(\s*subscribeCryptoGeneration\s*,\s*getCryptoGeneration\s*\)/,
    );
    const after = ROOM.slice(ROOM.indexOf('subscribeCryptoGeneration'));
    expect(after).toContain('invalidateQueries');
    expect(after).toContain('topicKeys.chat(topicId)');
  });

  it('the recovery screen does NOT invalidate — that was the version that failed', () => {
    /*
     * A guard against putting the first attempt back. It reads as the obvious
     * fix, and it refetches with the session the recovery just replaced.
     */
    expect(RECOVERY).not.toContain('invalidateQueries');
  });

  it('recoverDevice is reachable from exactly one place in the recovery screen', () => {
    // Cumulative: two ways to recover today, more later, one call site always.
    expect((RECOVERY.match(/\brecoverDevice\s*\(/g) ?? []).length).toBe(1);
    expect((RECOVERY.match(/await recoverAndReopenRooms\(/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});
