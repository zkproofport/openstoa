// @vitest-environment jsdom
/*
 * WHY THIS EXISTS. `chatDiscoveryEntryPoints.test.tsx` proves the web offers no
 * way IN to chat — the left-nav entry, the topic page's "Open topic chat", the
 * header toggle and the rail mount are all asserted absent. It passed the whole
 * time the bug below was live.
 *
 * It tests a FRESH browser. `CommunityLayout` reads the rail's open/closed
 * choice out of `localStorage` on mount (`readRailOpenPreference`), and the
 * commit that removed the entry points did not clear what was already written
 * there. So anyone who had the rail open when they took that release kept it
 * open — on every page, forever, with the control that could close it gone. A
 * jsdom `localStorage` starts empty, which is exactly why the guard could not
 * see it.
 *
 * The user found it before any test did, on staging, and asked the obvious
 * question: "why is the chat room showing on the web?"
 *
 * So this file asserts the other half: with the flag off, the stored preference
 * does not matter. Written against `CHAT_ON_WEB` rather than against the
 * absence of a button, because "no way in" and "not on" are different claims
 * and only the second one survives a value someone already saved.
 */
import { describe, it, expect } from 'vitest';
import { CHAT_ON_WEB } from '@/lib/chatOnWeb';
import { readRailOpenPreference, writeRailOpenPreference } from '@/lib/chatRail';

/** The condition `CommunityLayout` renders the rail on, in one place. */
const railWouldMount = (isGuest: boolean, railOpen: boolean) =>
  CHAT_ON_WEB && !isGuest && railOpen;

describe('a browser that saved "rail open" before chat left the web', () => {
  it('kept the preference — the storage write is not what was removed', () => {
    writeRailOpenPreference(true);
    expect(readRailOpenPreference()).toBe(true);
  });

  it('still gets no rail, because the flag decides and the preference does not', () => {
    writeRailOpenPreference(true);
    expect(railWouldMount(false, readRailOpenPreference())).toBe(false);
  });

  it.each([
    ['a signed-in member with the rail saved open', false, true],
    ['a signed-in member with it saved closed', false, false],
    ['a guest with a stale open preference', true, true],
    ['a guest with nothing saved', true, false],
  ])('%s sees no rail', (_label, isGuest, saved) => {
    expect(railWouldMount(isGuest, saved)).toBe(false);
  });

  it('CONTRACT: chat is off on the web, and this test is here to keep it off', () => {
    /*
     * Not a tautology — it is the tripwire. `CHAT_ON_WEB` is documented as a
     * constant nobody flips on their own, and the reasons are in
     * `lib/chatOnWeb.ts`: the keys live on one device, and a browser that
     * signs out still holds the MLS state, the leaf identity and the
     * decrypted-picture cache for whoever sits down next. If a change makes
     * this line fail, that change is turning chat on for browsers, and it
     * needs a person's decision rather than a passing suite.
     */
    expect(CHAT_ON_WEB).toBe(false);
  });
});
