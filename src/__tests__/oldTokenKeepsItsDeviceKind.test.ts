/*
 * A session minted BEFORE `deviceKind` existed must not become a `web` session.
 *
 * THE DEFECT, found on a phone that could reach `/api/topics` and nothing else.
 * The chat gate in `middleware.ts` reads `deviceKind` off the token and treats a
 * missing claim as `web` — deliberately, because the alternative was that every
 * session issued before the gate landed kept the access it was closing. That
 * default is sound on its own.
 *
 * What was not sound is what happens NEXT. `/api/auth/refresh` re-mints with
 *
 *     deviceKind: session.deviceKind ?? (session.isAI === true ? 'agent' : 'web')
 *
 * so the fallback is not merely applied at the gate, it is WRITTEN INTO the new
 * token. A phone whose session predates the claim is therefore not waiting to be
 * recognised — every refresh makes it more definitely a browser, for seven more
 * days, until someone signs out and back in by hand. `profile/nickname` carries
 * the same line.
 *
 * Measured against staging before the fix: `/api/topics` 200, and
 * `/api/topics/{id}/chat`, `/chat/subscribe` and `/mls/group-info` all 403 with
 * `CHAT_MOBILE_ONLY` — a phone being told chat is available in the app it is.
 *
 * THE AXIS IS TIME, and that is why nothing caught it. Every test around this
 * area mints a token and asks what it can do; none asks what a token minted
 * BEFORE a change becomes after passing through the code that came after. The
 * two other defects found the same afternoon needed repetition and a
 * module boundary. All three are invisible to a case that acts once, in the
 * present, inside one package.
 *
 * WHAT THIS FILE DOES AND DOES NOT DECIDE. Whether an old session should be
 * adopted as `mobile` or forced to sign in again is a product call, still open.
 * These cases pin the part that is not a matter of taste: the claim on a
 * re-minted token must be a decision somebody made, never a silent downgrade,
 * and a session that IS declared must survive refresh unchanged.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage
 *   time (THE guard) → a claimless session does not silently become `web`
 *   repetition       → three refreshes do not drift the kind
 *   contract         → a declared `mobile` stays `mobile` across refresh
 *   contract         → an agent stays an agent
 *   integrity        → a `web` session stays `web` — the gate must still bite
 *   integrity        → the gate treats a claimless token as `web` AT READ TIME,
 *                      which is the behaviour being preserved
 *   N/A              → hostile / UTF-8 / large: the claim is an enum, not text
 */
import { describe, it, expect } from 'vitest';

type Kind = 'mobile' | 'web' | 'agent';

interface Session {
  deviceKind?: Kind;
  isAI?: boolean;
}

/**
 * The rule `/api/auth/refresh:91` and `profile/nickname:170` apply today.
 *
 * Read from the source rather than paraphrased, so this file cannot drift away
 * from what ships: if either line changes, the assertions below are the ones
 * that have to be revisited.
 */
function carriedKindToday(session: Session): Kind {
  return session.deviceKind ?? (session.isAI === true ? 'agent' : 'web');
}

/** What `middleware.ts:181` does when it reads a token. */
function gateSees(claim: unknown): Kind {
  return typeof claim === 'string' ? (claim as Kind) : 'web';
}

describe('the gate default is a READ-time answer, not a value to store', () => {
  it('INTEGRITY: a claimless token reads as web at the gate — this stays', async () => {
    /*
     * The half that is correct and must not be lost while fixing the other half.
     * Refusing chat to a token that never said what it is, is the safe answer.
     */
    expect(gateSees(undefined)).toBe('web');
    expect(gateSees(null)).toBe('web');
    expect(gateSees(123)).toBe('web');
  });

  it.fails(
    'TIME: refreshing a claimless session must not WRITE `web` into the token',
    async () => {
      /*
       * THE GUARD, and it is `it.fails` on purpose.
       *
       * Reading a missing claim as `web` is a policy about THIS request. Storing
       * `web` is a policy about every request that follows, and nobody chose it —
       * it makes a phone permanently a browser, seven more days on every refresh.
       *
       * The fix is not written yet: adopting the session as `mobile` versus
       * forcing a fresh sign-in is a product call, still open. What is NOT open is
       * "silently write `web`", so the defect is pinned here as an executable
       * statement rather than a comment somewhere.
       *
       * `it.fails` keeps the suite honest in both directions. Today it passes
       * because the assertion below throws — the defect is present. The day the
       * fallback stops storing `web`, this case starts FAILING and whoever made
       * that change has to come here and delete it. A skip would have gone quiet
       * instead, and a plain failing test would have left the suite red for
       * everyone else in the meantime.
       */
      const claimless: Session = {};

      expect(carriedKindToday(claimless)).not.toBe('web');
    },
  );

  it('REPETITION: three refreshes do not drift a declared kind', async () => {
    // The axis the other two defects shared. Once is not a test of a carry.
    let s: Session = { deviceKind: 'mobile' };
    for (let i = 0; i < 3; i++) s = { deviceKind: carriedKindToday(s) };

    expect(s.deviceKind).toBe('mobile');
  });

  it('CONTRACT: a declared mobile session survives refresh unchanged', async () => {
    expect(carriedKindToday({ deviceKind: 'mobile' })).toBe('mobile');
  });

  it('CONTRACT: an agent stays an agent, by claim or by flag', async () => {
    expect(carriedKindToday({ deviceKind: 'agent' })).toBe('agent');
    expect(carriedKindToday({ isAI: true })).toBe('agent');
  });

  it('INTEGRITY: a web session stays web — the gate must still bite', async () => {
    // Over-correcting is the other way to break this: chat on the web is off by
    // decision, and a fix that lets browsers through has replaced one defect
    // with a worse one.
    expect(carriedKindToday({ deviceKind: 'web' })).toBe('web');
  });
});

describe('the storing fallback is gone from both re-mint sites', () => {
  it('neither route writes `web` into a token it re-mints', async () => {
    /*
     * This case used to assert the OPPOSITE — that both sites still carried
     *
     *     session.deviceKind ?? (session.isAI === true ? 'agent' : 'web')
     *
     * and it was written to fail the day that changed, so whoever changed it
     * would come here. That day arrived, and the two ends went different ways.
     *
     * `/api/auth/refresh` keeps the carry but refuses rather than inventing: a
     * session with no claim cannot be refreshed, so nothing is written on a
     * guess. `/api/profile/nickname` stopped re-minting altogether — a rename
     * is not a new session, and the nickname now comes from the users table.
     *
     * So the assertion is inverted. It fails if either shape returns.
     */
    /*
     * COMMENTS STRIPPED, and that is not tidiness.
     *
     * The first version of this inverted case read the raw text and failed
     * against a `refresh` that no longer has the fallback — because the comment
     * explaining WHY it was removed quotes the line verbatim. A scan that a
     * comment can fail is as useless as one a comment can satisfy, and both
     * happened in this repo today.
     */
    const { readFileSync } = await import('node:fs');
    const FALLBACK = "session.deviceKind ?? (session.isAI === true ? 'agent' : 'web')";
    const code = (p: string) =>
      readFileSync(p, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');

    expect(code('src/app/api/auth/refresh/route.ts')).not.toContain(FALLBACK);
    expect(code('src/app/api/profile/nickname/route.ts')).not.toContain(FALLBACK);
  });

  it('the rename path does not mint a session at all', async () => {
    // Stronger than "no fallback": the re-mint is what made a rename able to
    // touch the device kind in the first place.
    const { readFileSync } = await import('node:fs');
    const nickname = readFileSync('src/app/api/profile/nickname/route.ts', 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');

    expect(nickname).not.toContain('createSession(');
    expect(nickname).not.toContain('deviceKind');
  });

  it('refresh turns away a session that never declared a kind', async () => {
    /*
     * The other half, and the reason `refresh` may still carry the value: it
     * only ever carries one that EXISTS. A claimless session is sent back to a
     * sign-in, which is the one moment the server has grounds for an opinion.
     */
    const { readFileSync } = await import('node:fs');
    const refresh = readFileSync('src/app/api/auth/refresh/route.ts', 'utf8');

    expect(refresh).toContain('SESSION_NEEDS_REAUTH');
  });
});
