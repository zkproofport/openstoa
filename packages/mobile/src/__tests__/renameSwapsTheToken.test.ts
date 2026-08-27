/*
 * A rename changes a name. It must not change the session.
 *
 * THIS FILE USED TO ASSERT THE OPPOSITE, and it was right at the time. The
 * nickname was a JWT claim, so the route re-minted the token to carry the new
 * one and the client had to adopt it; a client that kept the old Bearer showed
 * the old name until it next signed in. Four cases guarded that swap.
 *
 * WHAT CHANGED, and why the swap had to go rather than be guarded harder.
 * Re-minting rewrote `deviceKind` at the same time:
 *
 *     deviceKind: session.deviceKind ?? (session.isAI === true ? 'agent' : 'web')
 *
 * Reading a missing claim as `web` is a safe answer about one request. WRITING
 * it is a verdict about every request that follows. So a phone whose session
 * predated that claim went to change its display name and came back a browser —
 * and the chat gate then refused every chat, MLS and TAK call from the app
 * itself. Measured on staging: `/api/topics` 200 while `chat`,
 * `chat/subscribe` and `mls/group-info` all answered 403.
 *
 * The fix is not a safer re-mint. It is that a rename has no business minting
 * anything: `GET /api/auth/session` reads the nickname from the users table
 * now, so the claim is merely stale and nothing consults it.
 *
 * So the guard is inverted. The cases below fail if the re-mint comes back.
 *
 * WHY A SOURCE CHECK. Each half is one line — a `createSession` call in the
 * route, an `updateToken` in the screen — and either could be reintroduced by
 * someone fixing "the name looks stale in some cached view" without seeing what
 * it costs. Nothing else in either repo asserts their absence.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage
 *   contract  → the route does not mint a session
 *   contract  → the route does not send a token back
 *   contract  → the screen does not adopt one
 *   integrity → `deviceKind` is not written anywhere on the rename path
 *   integrity → the session route reads the nickname from the table, so the
 *               stale claim is genuinely unread rather than merely unused today
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MOBILE = join(HERE, '..');
const OPENSTOA = join(MOBILE, '..', '..', '..');

/** Source with comments stripped — a comment must not be able to satisfy a case. */
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

const ROUTE = code(join(OPENSTOA, 'src/app/api/profile/nickname/route.ts'));
const SESSION_ROUTE = code(join(OPENSTOA, 'src/app/api/auth/session/route.ts'));
const SCREEN = code(join(MOBILE, 'screens/profile/EditProfileScreen.tsx'));

describe('renaming yourself does not re-mint the session', () => {
  it('CONTRACT: the route does not mint a session', () => {
    expect(ROUTE).not.toContain('createSession(');
  });

  it('CONTRACT: the route does not send a token back', () => {
    // `NextResponse.json({ nickname })` and nothing else. A `token` field would
    // be a client's invitation to swap its Bearer again.
    expect(ROUTE).not.toMatch(/json\(\{[^}]*\btoken\b/);
  });

  it('INTEGRITY: `deviceKind` is not written anywhere on the rename path', () => {
    /*
     * The specific harm, named. Even a "correct-looking" carry here is a write
     * of a value that was only ever a read-time default.
     */
    expect(ROUTE).not.toContain('deviceKind');
  });

  it('CONTRACT: the screen does not adopt a token', () => {
    expect(SCREEN).not.toContain('updateToken(');
  });

  it('INTEGRITY: the session route reads the nickname from the users table', () => {
    /*
     * Without this the whole change is unsound rather than merely different:
     * the claim would still be the source, and dropping the re-mint would leave
     * a rename invisible until the next sign-in.
     */
    expect(SESSION_ROUTE).toContain('users.nickname');
    expect(SESSION_ROUTE).toMatch(/nickname\s*=\s*user\[0\]\?\.nickname/);
  });
});
