/**
 * How long an invite token stays usable.
 *
 * It used to be a fixed seven days decided in the route. A topic's admin is the
 * one who knows whether a link is being handed to one person in a meeting or
 * posted somewhere it will sit for a month, so the lifetime is theirs to set —
 * within bounds, because "never expires" is how a leaked link becomes a
 * permanent way in, and that is exactly the hole the fixed topic-wide invite
 * code already leaves open.
 */

/** Used when the caller says nothing — the previous behaviour, unchanged. */
export const DEFAULT_INVITE_HOURS = 24 * 7;

/**
 * The shortest and longest an admin may choose.
 *
 * The floor is an hour rather than a minute because a link that expires while
 * it is still being delivered is a support ticket, not a security win. The
 * ceiling is thirty days: past that the difference from "forever" stops being
 * meaningful, and a topic that needs a standing door should use a re-issued
 * link rather than one nobody remembers creating.
 */
export const MIN_INVITE_HOURS = 1;
export const MAX_INVITE_HOURS = 24 * 30;

export type InviteExpiryResult =
  | { ok: true; expiresAt: Date }
  | { ok: false; error: string };

/**
 * Turn an admin's requested lifetime into an expiry instant.
 *
 * `now` is a parameter so the caller — and the tests — decide what "now" is,
 * rather than this reaching for the clock and becoming untestable.
 */
export function resolveInviteExpiry(hours: unknown, now: Date): InviteExpiryResult {
  const requested = hours === undefined || hours === null ? DEFAULT_INVITE_HOURS : hours;

  // A string that looks like a number is still not a number: accepting it here
  // would mean `"24abc"` silently becoming 24 somewhere down the line.
  if (typeof requested !== 'number' || !Number.isFinite(requested)) {
    return { ok: false, error: 'expiresInHours must be a number' };
  }
  if (!Number.isInteger(requested)) {
    return { ok: false, error: 'expiresInHours must be a whole number of hours' };
  }
  if (requested < MIN_INVITE_HOURS || requested > MAX_INVITE_HOURS) {
    return {
      ok: false,
      error: `expiresInHours must be between ${MIN_INVITE_HOURS} and ${MAX_INVITE_HOURS}`,
    };
  }

  return { ok: true, expiresAt: new Date(now.getTime() + requested * 60 * 60 * 1000) };
}
