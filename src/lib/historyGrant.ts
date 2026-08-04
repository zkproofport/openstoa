/**
 * `history_grant` ENFORCEMENT — the consuming half of the API-key scope
 * (design §7 follow-up, SI-6).
 *
 * An API key carries TWO independent scopes and BOTH gate a history read:
 *   - `cmd`          — WHICH operations the key may perform (`requireAiCapability`,
 *                      `src/lib/aiPermissions.ts`).
 *   - `historyGrant` — HOW MUCH of the past a key holding `/openstoa/chat/read`
 *                      may retrieve. THIS module.
 * Holding `chat/read` is necessary but not sufficient: a key scoped to the last
 * 7 days must not be able to page back three years just because it can call the
 * endpoint at all.
 *
 * The grammar is the TAK scope grammar and there is exactly ONE parser for it:
 * `isValidTakScope` (`src/lib/mls/http.ts`) decides validity, and
 * `parseHistoryGrant` below only destructures what that validator already
 * accepted. A second, drifting definition of "valid scope" is the bug class this
 * arrangement exists to prevent — never re-implement the shapes here.
 *
 * Enforced surfaces (all SERVER-SIDE, in the route/query — never a client filter):
 *   - `GET /api/topics/{id}/chat`          — live message history
 *   - `GET /api/topics/{id}/archive`       — TAK-re-encrypted back-fill
 *   - `GET /api/topics/{id}/tak/bundles`   — the keys that decrypt that back-fill
 *
 * Humans (`isAI` falsy) are NEVER touched by any of this: `resolveEnforcedHistoryGrant`
 * returns null for them and every route keeps its pre-existing code path byte
 * for byte.
 */
import { NextResponse } from 'next/server';
import { isValidTakScope } from '@/lib/mls/http';

/** A parsed grant. Mirrors the five shapes `isValidTakScope` accepts. */
export type HistoryGrant =
  | { kind: 'full' }
  | { kind: 'none' }
  | { kind: 'days'; days: number }
  | { kind: 'count'; count: number }
  | { kind: 'sinceEpoch'; epoch: number };

/** What an unparseable/absent grant collapses to. Fail-closed, never 'full'. */
export const DENIED_GRANT: HistoryGrant = { kind: 'none' };

/**
 * Destructure a scope string that `isValidTakScope` has ALREADY accepted.
 * Returns null for anything that validator rejects — empty, over-length,
 * hostile text, `0d`, a non-string, null/undefined. Callers must treat null as
 * DENY, never as "unrestricted".
 */
export function parseHistoryGrant(raw: unknown): HistoryGrant | null {
  if (!isValidTakScope(raw)) return null;
  if (raw === 'full') return { kind: 'full' };
  if (raw === 'none') return { kind: 'none' };
  let m: RegExpMatchArray | null;
  // Order matters: `since_epoch:N` before `Nd` before the bare-`N` count form.
  if ((m = raw.match(/^since_epoch:(\d{1,15})$/))) return { kind: 'sinceEpoch', epoch: Number(m[1]) };
  if ((m = raw.match(/^(\d{1,9})d$/))) return { kind: 'days', days: Number(m[1]) };
  if ((m = raw.match(/^(\d{1,9})$/))) return { kind: 'count', count: Number(m[1]) };
  return null;
}

/** The slice of a session this module needs — structural so tests need no JWT. */
export interface HistoryGrantSession {
  userId: string;
  isAI?: boolean;
  apiKeyId?: string;
  apiKeyHistoryGrant?: string;
}

/**
 * Resolve the grant a request must be BOUNDED BY, or null when the caller is
 * not history-gated at all. Two distinct reasons produce null, and both mean
 * "run the route exactly as before":
 *   - the session is a human (`isAI` falsy) — grants apply to agent credentials,
 *     never to a person's own session;
 *   - the grant is `full` — bounded by nothing.
 *
 * Everything else returns a bound. FAIL-CLOSED: an `isAI` session whose grant is
 * missing or unparseable collapses to `none` (deny), never to `full`. In
 * practice that shape is unreachable through the front door — `api_keys.history_grant`
 * is NOT NULL and validated on write, and a bare `isAI` JWT with no key is
 * already rejected by `requireAiCapability` for having no `cmd` — but a
 * credential with no declared scope must not inherit one if it ever gets here.
 */
export function resolveEnforcedHistoryGrant(session: HistoryGrantSession): HistoryGrant | null {
  if (!session.isAI) return null;
  const parsed = parseHistoryGrant(session.apiKeyHistoryGrant);
  if (!parsed) return DENIED_GRANT;
  if (parsed.kind === 'full') return null;
  return parsed;
}

/**
 * 403 for a grant of `none`, else null so the route continues.
 *
 * WHY 403 AND NOT AN EMPTY 200: `none` is an authorization answer, not a query
 * result. It is the same class of denial as a missing `cmd`, and it is returned
 * in the same shape, so an operator who mis-scoped a key sees the mistake
 * immediately instead of concluding the topic is empty. A silent empty page is
 * the worse failure mode for an agent — it cannot distinguish "no history for
 * me" from "no history at all" and will happily report the latter.
 *
 * Consistent across all three history surfaces (chat, archive, tak/bundles).
 */
export function historyGrantDenial(grant: HistoryGrant | null): NextResponse | null {
  if (grant?.kind !== 'none') return null;
  return NextResponse.json(
    {
      error:
        "History grant required: this API key was issued with historyGrant 'none' and may not read history",
    },
    { status: 403 },
  );
}

/**
 * Inclusive lower bound on message time for an `Nd` grant, or null when the
 * grant is not time-shaped. Boundary: a message exactly N days old IS inside
 * "the last N days" (the comparison at the call site is `>=`).
 */
export function grantTimeFloor(grant: HistoryGrant, now: Date): Date | null {
  if (grant.kind !== 'days') return null;
  return new Date(now.getTime() - grant.days * 24 * 60 * 60 * 1000);
}

/** Inclusive lower bound on group epoch for a `since_epoch:N` grant, else null. */
export function grantEpochFloor(grant: HistoryGrant): number | null {
  return grant.kind === 'sinceEpoch' ? grant.epoch : null;
}

/** Number of newest messages a bare-`N` grant covers, else null. */
export function grantMessageCount(grant: HistoryGrant): number | null {
  return grant.kind === 'count' ? grant.count : null;
}

/**
 * Is a TAK bundle's own `scope` contained within the caller's grant?
 *
 * A bundle carries the KEYS for a history range, so handing one over is handing
 * over that range. `grant === null` (human or `full`) allows everything;
 * otherwise the bundle must be PROVABLY no wider than the grant:
 *   - bundle `none`  → always fine, it unlocks nothing.
 *   - bundle `full`  → refused (the grant is bounded, or we would not be here).
 *   - same family    → compare magnitudes: fewer days / fewer messages is
 *                      narrower; a HIGHER `since_epoch` starts later and is
 *                      therefore narrower.
 *   - cross-family   → REFUSED. `7d` vs `since_epoch:3` cannot be ordered
 *                      without mapping epochs to wall-clock time, which the
 *                      server does not store per epoch. Fail-closed rather than
 *                      guess: an unprovable containment is not a containment.
 *   - unparseable    → refused.
 */
export function takScopeWithinGrant(bundleScope: unknown, grant: HistoryGrant | null): boolean {
  if (grant === null) return true;
  const b = parseHistoryGrant(bundleScope);
  if (!b) return false;
  if (b.kind === 'none') return true;
  switch (grant.kind) {
    case 'full':
      return true;
    case 'none':
      return false;
    case 'days':
      return b.kind === 'days' && b.days <= grant.days;
    case 'count':
      return b.kind === 'count' && b.count <= grant.count;
    case 'sinceEpoch':
      // A HIGHER start epoch begins later and is therefore the narrower range.
      return b.kind === 'sinceEpoch' && b.epoch >= grant.epoch;
  }
}
