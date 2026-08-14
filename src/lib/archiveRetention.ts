/**
 * How long a topic keeps its chat ARCHIVE — the rule, for BOTH clients and the
 * server.
 *
 * The archive (`chat_archive.ciphertext`) is the history layer: the copy a
 * later joiner reads, sealed under a key the server may or may not hold. It was
 * kept forever, with no purge anywhere, which was never the intent — and it
 * matters most for `public`, the one tier where the server ALSO holds the
 * archive root, so an unbounded window there means operator-readable data
 * accumulating with no end date.
 *
 * This is NOT the delivery queue. `chat_messages.ciphertext` is a post box and
 * has its own, separate rule (drop it once delivered); nothing here touches it.
 *
 * The window is chosen by the admin when the topic is created, from a closed
 * set, and the cost of a short one is real and has to be said out loud in the
 * interface: **a later joiner sees less**. There is no way to shorten a window
 * without deleting somebody's history, which is why the choice is made once, at
 * creation, rather than being an editable preference.
 *
 * Two copies exist — `src/lib/archiveRetention.ts` (web/server) and
 * `packages/mobile/src/lib/archiveRetention.ts` (mini-app) — and a test asserts
 * they stay BYTE-IDENTICAL, so keep this file dependency-free.
 *
 * The reasoning is in `docs/design/openstoa-chat-history-decision.md`
 * (§"Retention: the copy that should not survive delivery").
 */

/** Kept indefinitely — no purge. Stored as 0 days, never as NULL. */
export const ARCHIVE_RETENTION_UNLIMITED = 0;

/**
 * Every window a topic may be created with, in the order both clients offer
 * them. A closed set rather than a free number: each option has to be
 * explained, and an explanation is only honest if the value is one we wrote
 * copy for.
 */
export const ARCHIVE_RETENTION_CHOICES = [ARCHIVE_RETENTION_UNLIMITED, 365, 90, 30] as const;

export type ArchiveRetentionDays = (typeof ARCHIVE_RETENTION_CHOICES)[number];

/**
 * What a topic gets when the creator says nothing.
 *
 * Unlimited, deliberately. Every topic that predates this setting has an
 * unbounded archive, so any other default would make an omitted field delete
 * history that the creator never agreed to lose — a destructive default is the
 * one kind this file must not have. Shortening it is a decision someone makes
 * on purpose.
 */
export const ARCHIVE_RETENTION_DEFAULT: ArchiveRetentionDays = ARCHIVE_RETENTION_UNLIMITED;

/** Milliseconds in a day. Named because the arithmetic below reads as a claim. */
const DAY_MS = 24 * 60 * 60 * 1000;

/** Is this one of the windows a topic may actually be created with? */
export function isArchiveRetentionDays(value: unknown): value is ArchiveRetentionDays {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    (ARCHIVE_RETENTION_CHOICES as readonly number[]).includes(value)
  );
}

/**
 * A caller-supplied window, or null when the caller sent something we will not
 * store. Null means REJECT (the route answers 400) — never "use the default",
 * because the two are different requests and a client that sent `-1` or `"30"`
 * has a bug that a silent substitution would hide.
 *
 * `undefined` is the one absence that is not an error: the field is optional,
 * and omitting it means the creator did not choose, so they get
 * `ARCHIVE_RETENTION_DEFAULT`. `null` is a value the caller typed, so it is
 * rejected like any other value we do not accept.
 *
 * Strings are refused even when they look like numbers. JSON carries numbers
 * natively, so `"30"` is a client that is guessing at the contract, and a
 * coercion here would make the contract whatever the sloppiest caller does.
 */
export function parseArchiveRetentionDays(value: unknown): ArchiveRetentionDays | null {
  if (value === undefined) return ARCHIVE_RETENTION_DEFAULT;
  return isArchiveRetentionDays(value) ? value : null;
}

/** Whether this window keeps the archive forever. */
export function isUnlimitedRetention(days: number): boolean {
  return days === ARCHIVE_RETENTION_UNLIMITED;
}

/**
 * The cut-off: archive rows created STRICTLY BEFORE this instant are outside
 * the window. Null for an unlimited window, where there is no cut-off at all.
 *
 * Strictly before, so a row exactly `days` old is still inside — the same
 * boundary `grantTimeFloor` uses for history grants, and the forgiving side of
 * the line, because the alternative is deleting a message a reader can still
 * see on their screen.
 */
export function archiveRetentionFloor(days: number, now: Date): Date | null {
  if (isUnlimitedRetention(days)) return null;
  return new Date(now.getTime() - days * DAY_MS);
}

/**
 * Would the purge delete a row created at this instant?
 *
 * The predicate the SQL implements, expressed once so a test can pin the
 * boundary without a database: at the edge — not expired; one millisecond past
 * it — expired.
 */
export function isArchiveRowExpired(createdAt: Date, days: number, now: Date): boolean {
  const floor = archiveRetentionFloor(days, now);
  if (floor === null) return false;
  return createdAt.getTime() < floor.getTime();
}

/**
 * The i18n leaf both clients look this window's copy up under.
 *
 * Shared so the web page and the mini-app cannot end up describing the same
 * number differently — the label and the "a later joiner sees less" warning are
 * the whole point of offering the choice, and two catalogues drifting is how
 * one of them ends up promising something we do not do.
 */
export function archiveRetentionKey(days: number): string {
  switch (days) {
    case ARCHIVE_RETENTION_UNLIMITED:
      return 'unlimited';
    case 365:
      return 'year1';
    case 90:
      return 'days90';
    case 30:
      return 'days30';
    default:
      // Unreachable through the routes, which store only the closed set. A row
      // that somehow carries another number is described as unlimited: it
      // under-promises about deletion rather than claiming a window we are not
      // enforcing.
      return 'unlimited';
  }
}
