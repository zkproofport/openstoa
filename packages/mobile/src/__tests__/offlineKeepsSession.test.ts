/**
 * Being offline is not being signed out.
 *
 * THE DEFECT, found on a real device (SM-A235N). The boot path asked
 * `/api/auth/session` whether the stored token was still good, and returned the
 * same `false` for "the server refused it" as for "there was no server to ask".
 * The caller reads a refusal as a reason to call `session.clear()` — so with
 * wifi and mobile data switched off, relaunching the app showed the Welcome
 * screen to an account that had been signed in seconds earlier, AND discarded
 * the token, so coming back into range did not restore it. A tunnel, a lift or
 * a flight was enough to lose the session.
 *
 * The token was never invalid. Nobody could be asked.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage
 *   contract   → every 2xx is 'ok'
 *   integrity  → 4xx is 'rejected', the one verdict allowed to sign out
 *   boundary   → 5xx is the SERVER failing, never the account
 *   boundary   → the exact edges 199 / 200 / 299 / 300 / 499 / 500
 *   hostile    → 0, negative, fractional and absurd statuses never sign out
 *   integrity  → exactly ONE verdict clears, asserted over the whole set
 */
import { describe, it, expect } from 'vitest';
import {
  sessionVerdictForStatus,
  userIdFromToken,
  verdictClearsSession,
  SESSION_VERDICTS,
  type SessionVerdict,
} from '../lib/sessionVerdict';

describe('offline is not signed out', () => {
  it.each([200, 201, 204, 299])('CONTRACT: %s is ok', (status) => {
    expect(sessionVerdictForStatus(status)).toBe('ok');
    expect(verdictClearsSession(sessionVerdictForStatus(status))).toBe(false);
  });

  it.each([
    ['401 — the token really was refused', 401],
    ['403 — the account lost access', 403],
    ['400', 400],
    ['404', 404],
    ['499', 499],
  ])('INTEGRITY: %s is the one case that may sign out', (_label, status) => {
    expect(sessionVerdictForStatus(status)).toBe('rejected');
    expect(verdictClearsSession(sessionVerdictForStatus(status))).toBe(true);
  });

  it.each([
    ['500', 500],
    ['502', 502],
    ['503 — a deploy in progress', 503],
    ['504 — a gateway timeout', 504],
  ])('BOUNDARY: %s is the server failing, and costs nobody their account', (_label, status) => {
    // Reading a 5xx as a refusal would sign every user out during a bad
    // deploy — the same defect as the offline one, louder.
    expect(sessionVerdictForStatus(status)).toBe('unreachable');
    expect(verdictClearsSession(sessionVerdictForStatus(status))).toBe(false);
  });

  it.each([
    ['100, the first real status', 100, 'rejected'],
    ['199, just under the ok range', 199, 'rejected'],
    ['200, the first ok', 200, 'ok'],
    ['299, the last ok', 299, 'ok'],
    ['300, just over', 300, 'rejected'],
    ['499, the last refusal', 499, 'rejected'],
    ['500, the first server failure', 500, 'unreachable'],
  ])('BOUNDARY: %s', (_label, status, expected) => {
    expect(sessionVerdictForStatus(status)).toBe(expected);
  });

  it.each([
    ['zero — a status that was never assigned', 0],
    ['negative', -1],
    ['fractional', 200.5],
    ['absurd', 99999],
    ['NaN', Number.NaN],
  ])('HOSTILE: %s never signs the account out', (_label, status) => {
    // A nonsense status means the request did not complete normally, and the
    // one thing that must never follow from "we do not know" is "sign out".
    expect(verdictClearsSession(sessionVerdictForStatus(status))).toBe(false);
  });

  it('INTEGRITY: exactly ONE verdict is allowed to clear a session', () => {
    // Asserted over the whole set, so a fourth verdict that also clears has to
    // be a deliberate edit here rather than something inherited by accident.
    const clearing = SESSION_VERDICTS.filter((v: SessionVerdict) => verdictClearsSession(v));
    expect(clearing).toEqual(['rejected']);
  });
});

/**
 * Knowing you are signed in is not the same as knowing WHO.
 *
 * Two offline fixes cancelled each other out and it took the device to show it.
 * The first kept the session when the server was unreachable but set `userId`
 * to `''`, reasoning that gated controls would stay disabled — true, and beside
 * the point. The second cached the room list PER ACCOUNT, so two accounts on
 * one phone cannot see each other's rooms. With an empty id the offline list
 * could never be found, and the phone still showed "Couldn't load chats" after
 * both had shipped and both had passing tests.
 *
 * A first repair persisted the id to `localStore` and was REVERTED: read state
 * moved to the server in `feat(chat): move the read cursor to the server`, and
 * a second device-local copy of who-you-are is the duplication that decision
 * removed. The token already names the account, so it is read from there and
 * lives in the one global session store.
 *
 * EDGE-CASE MATRIX → coverage
 *   contract   → a normal token yields its userId
 *   contract   → base64URL padding and the -/_ alphabet decode correctly
 *   hostile    → not a JWT, wrong segment count, junk payload, no userId
 *   hostile    → a payload that is a JSON array or a bare string
 *   empty      → null, undefined, empty string
 *   integrity  → a non-string userId is refused rather than coerced
 */
describe('an offline launch reads its account from the token', () => {
  const jwt = (payload: unknown) => {
    const b64 = (o: unknown) =>
      Buffer.from(JSON.stringify(o))
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
    return `${b64({ alg: 'HS256' })}.${b64(payload)}.sig`;
  };

  it('CONTRACT: a normal token yields its userId', () => {
    expect(userIdFromToken(jwt({ userId: '0xabc', nickname: 'someone' }))).toBe('0xabc');
  });

  it('CONTRACT: a payload whose base64 needs padding still decodes', () => {
    // Length %4 of 2 and 3 are the cases a missing `=` breaks — roughly one
    // token in four, which reads as "sometimes the offline list is empty".
    for (const id of ['0xa', '0xab', '0xabc', '0xabcd']) {
      expect(userIdFromToken(jwt({ userId: id }))).toBe(id);
    }
  });

  it('CONTRACT: the base64URL alphabet (- and _) decodes', () => {
    // A payload chosen so its base64 carries both substituted characters.
    const id = '0x' + 'ÿþý'.repeat(4);
    expect(userIdFromToken(jwt({ userId: id }))).toBe(id);
  });

  it.each([
    ['not a JWT at all', 'hello'],
    ['two segments', 'a.b'],
    ['four segments', 'a.b.c.d'],
    ['a payload that is not base64', 'a.!!!.c'],
    ['a payload that is not JSON', `a.${Buffer.from('nope').toString('base64url')}.c`],
    ['a JSON array payload', jwt([1, 2, 3])],
    ['a bare-string payload', jwt('hello')],
    ['a payload with no userId', jwt({ nickname: 'someone' })],
  ])('HOSTILE: %s yields an empty id, never a throw', (_label, token) => {
    expect(userIdFromToken(token)).toBe('');
  });

  it.each([
    ['a numeric userId', 42],
    ['a null userId', null],
    ['an object userId', { id: 'x' }],
  ])('INTEGRITY: %s is refused rather than coerced', (_label, userId) => {
    // A coerced "42" would key the cache under a room list nobody owns.
    expect(userIdFromToken(jwt({ userId }))).toBe('');
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an empty string', ''],
  ])('EMPTY: %s is an empty id', (_label, token) => {
    expect(userIdFromToken(token)).toBe('');
  });
});
