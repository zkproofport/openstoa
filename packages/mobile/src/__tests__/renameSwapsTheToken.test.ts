/**
 * A rename hands back a new token, and this client has to start using it.
 *
 * WHY IT MATTERS. The nickname is a JWT CLAIM. The token the app sent with the
 * rename still names the old one, so a client that keeps it shows the old name
 * everywhere the claim is the source — including `GET /api/auth/session`, which
 * is what the profile screen reads on its next refetch. Nothing errors: the old
 * token stays valid (a rename is not a new session), so the only symptom is a
 * person renaming themselves and watching the app keep the old name.
 *
 * WHY A SOURCE CHECK. Both halves are one line each — `await
 * client.updateToken(data.token)` in the screen, and `token` in the route's
 * response — and deleting either produces a build that passes every existing
 * test. Nothing else in either repo asserts the swap, which is how a one-line
 * deletion becomes a bug report about "renaming doesn't work".
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage
 *   contract  → the screen adopts the returned token
 *   contract  → it adopts it BEFORE re-reading the session, or the refetch
 *               carries the stale claim and undoes the rename on screen
 *   contract  → the server actually SENDS a token to adopt
 *   integrity → the adopted token reaches persistent storage, not just memory,
 *               so the next launch is not back on the old claim
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MOBILE = join(HERE, '..');
const OPENSTOA = join(MOBILE, '..', '..', '..');

const SCREEN = readFileSync(join(MOBILE, 'screens/profile/EditProfileScreen.tsx'), 'utf8');
const CLIENT = readFileSync(join(MOBILE, 'api/openstoaClient.ts'), 'utf8');
const ROUTE = readFileSync(join(OPENSTOA, 'src/app/api/profile/nickname/route.ts'), 'utf8');

describe('renaming yourself in the mini-app', () => {
  it('CONTRACT: the screen adopts the token the rename returned', () => {
    expect(SCREEN).toMatch(/updateToken\(\s*data\.token\s*\)/);
  });

  it('CONTRACT: it adopts it BEFORE invalidating the session query', () => {
    /*
     * Order is the whole thing. `invalidateQueries` triggers a refetch of
     * `/api/auth/session`, and that request carries whatever token the client
     * holds at that moment. Invalidating first means the refetch goes out on
     * the OLD token, comes back with the OLD name, and overwrites the new one
     * the user just set — the rename appears to fail.
     */
    const swap = SCREEN.indexOf('updateToken(data.token)');
    const invalidate = SCREEN.indexOf('invalidateQueries', swap);
    expect(swap, 'the swap is missing').toBeGreaterThan(-1);
    expect(invalidate, 'no invalidate after the swap').toBeGreaterThan(swap);
    // Awaited, or the refetch races it and the order above buys nothing.
    expect(SCREEN.slice(swap - 20, swap)).toContain('await');
  });

  it('INTEGRITY: adopting a token persists it, not just caches it in memory', () => {
    // A memory-only swap works until the app restarts, and then the person is
    // back on the old claim with no idea why the name reverted.
    const fn = CLIENT.slice(CLIENT.indexOf('async updateToken('));
    const body = fn.slice(0, fn.indexOf('\n  }'));
    expect(body).toContain('setOpenStoaToken');
  });

  it('CONTRACT: the server actually returns a token to adopt', () => {
    // The client half is useless if the route stops sending it, and the route
    // has no test of its own for the body shape.
    expect(ROUTE).toMatch(/NextResponse\.json\(\s*\{\s*nickname,\s*token\s*\}/);
  });

  it('CONTRACT: the response schema DECLARES the token', () => {
    /*
     * Agents read the generated skill file, which is built from this JSDoc. The
     * schema listed `nickname` only, so the prose told agents to swap a field
     * the machine-readable half said did not exist.
     */
    const responses = ROUTE.slice(ROUTE.indexOf('*     responses:'), ROUTE.indexOf('*       400:'));
    expect(responses).toContain('token:');
  });
});
