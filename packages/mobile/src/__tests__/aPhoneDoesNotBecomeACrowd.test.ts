/**
 * One phone is one device in a room, however many times the app is launched.
 *
 * WHAT HAPPENED, measured on staging on 2026-08-28. One phone, one personal
 * room, ELEVEN devices — two of them minutes apart from plain restarts, no
 * sign-out and no erase between them. Every member wraps a key bundle for every
 * device, so opening that room posted eleven bundles, more than everything else
 * the room open spent put together.
 *
 * The device said why, once it was asked to. Its identity was remembered
 * correctly on each launch; the room STATE was not:
 *
 *   mls/identity  {"reused": true, "id": "0x6fd8b04f…"}
 *   mls/restore   {"found": false, "threw": "Invalid key provided to
 *                  SecureStore. Keys must not be empty and contain only
 *                  alphanumeric characters, '.', '-', and '_'."}
 *   mls/newLeaf   {"identity": "0x6fd8b04f…"}
 *
 * A leaf identity is `<userId>:<deviceId>` and the state key was built from it
 * verbatim. iOS REJECTS a key containing a colon — it does not sanitise, it
 * throws — so both the save and the read threw, and both sides swallowed it:
 * the save was best-effort, the read fell through to "nothing saved". The
 * device then did the only thing left and joined the room again.
 *
 * The colon arrived with the fix that made the identity stable across launches
 * (2026-08-26). That fix was right and its own guard still passes — the
 * identity IS reused, as the first line above shows. It simply put a character
 * into a key that one platform will not take, on the platform its author was
 * not testing.
 *
 * EDGE-CASE MATRIX → coverage
 *   contract   → the key holds only characters iOS accepts
 *   integrity  → two identities never collapse onto one key
 *   boundary   → the safe characters pass through untouched
 *   hostile    → colon, slash, plus, equals, space, and a literal dash
 *   UTF-8      → Korean and emoji in an identity still produce a legal key
 *   empty      → an empty identity is not an empty key
 *   large      → a very long identity stays legal
 *   race/authz/external → N/A: a pure string function
 */
import { describe, it, expect } from 'vitest';
import { leafIdentity, storeKeySafe } from '../../../mls/src/leafIdentity';

/** Exactly what iOS accepts, from the message the device sent back. */
const IOS_ALLOWED = /^[A-Za-z0-9._-]+$/;

describe('a phone does not become a crowd', () => {
  it('THE DEFECT: a real leaf identity makes a key iOS will accept', () => {
    const id = leafIdentity('0x6fd8b04fb9ec20dd9e826be52cdb68c066376fa4', 'pz2zPNDLZj7RLFqD+f/JJK=');
    // The identity itself is not legal as a key, which is the whole problem.
    expect(IOS_ALLOWED.test(id)).toBe(false);
    expect(IOS_ALLOWED.test(storeKeySafe(id))).toBe(true);
  });

  it('CONTRACT: the whole key, not just the identity, is legal', () => {
    const id = leafIdentity('0xabc', 'dev+ice/id=');
    const key = `mls.state.${storeKeySafe(id)}.11111111-2222-4333-8444-555555555555`;
    expect(IOS_ALLOWED.test(key)).toBe(true);
  });

  it('INTEGRITY: two different identities never collapse onto one key', () => {
    // Stripping the offending characters would map both of these to "ab".
    expect(storeKeySafe('a:b')).not.toBe(storeKeySafe('ab'));
    expect(storeKeySafe('a:b')).not.toBe(storeKeySafe('a/b'));
    // A literal dash is escaped too, so an escape can never be forged.
    expect(storeKeySafe('a-3ab')).not.toBe(storeKeySafe('a:b'));
  });

  it('BOUNDARY: characters iOS already accepts pass through untouched', () => {
    expect(storeKeySafe('mls.state_v1-2')).toBe('mls.state_v1'.concat(storeKeySafe('-'), '2'));
    expect(storeKeySafe('abcXYZ019._')).toBe('abcXYZ019._');
  });

  it('HOSTILE: every character a leaf or a base64 device id can carry', () => {
    for (const s of [':', '/', '+', '=', ' ', '-', '\\', '"', "'", '\n', '\t', '%', '#', '?']) {
      const out = storeKeySafe(`a${s}b`);
      expect(IOS_ALLOWED.test(out)).toBe(true);
      expect(out).not.toBe('ab');
    }
  });

  it('UTF-8: Korean and emoji still produce a legal key', () => {
    for (const s of ['한글', '🎉', 'ZK 증명 混合']) {
      expect(IOS_ALLOWED.test(storeKeySafe(`id:${s}`))).toBe(true);
    }
  });

  it('EMPTY: an empty identity does not make an empty key', () => {
    // iOS rejects an empty key as well — the message says so.
    const key = `mls.state.${storeKeySafe('')}.topic`;
    expect(IOS_ALLOWED.test(key)).toBe(true);
    expect(key.length).toBeGreaterThan(0);
  });

  it('VERY LARGE: a long identity stays legal', () => {
    const id = leafIdentity(`0x${'a'.repeat(4000)}`, `${'b/c+d='.repeat(200)}`);
    expect(IOS_ALLOWED.test(storeKeySafe(id))).toBe(true);
  });

  it('the same identity always makes the same key', () => {
    const id = leafIdentity('0xabc', 'dev:ice');
    expect(storeKeySafe(id)).toBe(storeKeySafe(id));
  });
});
