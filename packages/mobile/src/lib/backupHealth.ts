/**
 * How much this account's chat history is worth to a phone that no longer
 * exists — and therefore whether anybody needs to be told about it.
 *
 * THE THING BEING ANSWERED. Every message is sealed under keys derived from
 * `master_key`, which is generated on the phone and never leaves it. Two
 * separate pieces have to be on file for a next phone to read anything:
 *
 *   1. a WRAP of `master_key` (a recovery code, or a passkey PRF wrap) —
 *      without it the key itself is gone;
 *   2. a TAK-KEYCHAIN SNAPSHOT that the recovered key can open — without it the
 *      key comes back and unlocks nothing.
 *
 * Missing either one is unrecoverable, they fail for different reasons, and the
 * sentence you would say to somebody differs, so they are different answers
 * here rather than one boolean.
 *
 * WHY DATE-BASED STALENESS IS NOT ONE OF THE ANSWERS, which is the part that
 * reads as an omission and is not. `tak_key_backups.updatedAt` only advances
 * when the blob is REWRITTEN, and the uploader
 * (`mobileTransport.ts`, `pushTakKeychain`) short-circuits with `'present'` when
 * the snapshot already covers everything this device holds — deliberately, to
 * avoid churning an identical map. So an account whose keys have not changed in
 * two months has a snapshot dated two months ago that is nonetheless COMPLETE.
 * Telling that person "your backup is 60 days old" is a false alarm, and a
 * warning that is wrong once is a warning the next one does not get believed.
 *
 * What the takeover screen (`deviceTakeover.ts`) does with the same timestamp is
 * a different question in a different situation: there the device being asked
 * about is the OTHER phone, which is not running this uploader and may never
 * have caught up. Here the device asking is the device that owns the keys, and
 * it has just tried to upload them — so COVERAGE, not age, is the honest
 * signal, and coverage is exactly what `TakBackupOutcome` reports.
 *
 * WHY IT REFUSES TO GUESS. Every path that cannot establish the facts returns
 * `unknown`, and `unknown` sends nothing. The alternative — assuming the worse
 * case and warning anyway — puts "everything you have is about to be lost" in
 * somebody's room because a request timed out.
 */

/**
 * What an attempt to put this device's TAK keychain on the server did.
 *
 * Structurally identical to `TakBackupOutcome` in `crypto/mobileTransport.ts`,
 * restated here so this module stays free of the crypto layer and can be driven
 * from a test with no keystore. The caller passes the real one straight in.
 */
export type KeychainCoverage = 'uploaded' | 'empty' | 'present' | 'untrusted' | 'failed';

export interface BackupHealthInputs {
  /** A real signed-in session. Nothing is claimed about a signed-out app. */
  authenticated: boolean;
  /**
   * Whether a recovery-code wrap is on file — `null` when the server did not
   * answer. Null is NOT "no": see `unknown` below.
   */
  hasRecoveryWrap: boolean | null;
  /** Whether any passkey wrap is on file. `null` when the server did not answer. */
  hasPasskey: boolean | null;
  /** What this launch's keychain upload found or did. */
  keychain: KeychainCoverage;
}

export type BackupHealth =
  /**
   * Not established. Signed out, or the server did not answer — say nothing.
   * The next launch asks again, which costs one launch; a wrong warning costs
   * the credibility of every later one.
   */
  | { kind: 'unknown' }
  /**
   * There are no chat keys anywhere yet, so there is nothing to lose. A brand
   * new account does not get a message about losing history it has not made —
   * the same rule `shouldNudgeRecovery` applies to the profile banner, kept
   * identical on purpose so the two surfaces never disagree.
   */
  | { kind: 'nothing-at-stake' }
  /** A wrap is on file and this device's keys are inside the snapshot it opens. */
  | { kind: 'ok' }
  /**
   * No wrap of any kind. `master_key` exists on this phone and nowhere else, so
   * the history is one reset away from being unreadable by anyone, forever.
   */
  | { kind: 'none' }
  /**
   * A wrap exists, but the snapshot it would restore was sealed under a
   * DIFFERENT key — this device cannot open it and must not overwrite it
   * (`readBackedUpKeychain` refuses, and is right to: the row is one per user).
   * Recovery would return the account and leave these rooms unreadable, which
   * is the failure people are least likely to see coming, because from the
   * outside it looks exactly like being backed up.
   */
  | { kind: 'unopenable' };

/** The two states somebody has to be told about. */
export type BackupNoticeKind = 'none' | 'unopenable';

export function backupHealth(input: BackupHealthInputs): BackupHealth {
  if (!input.authenticated) return { kind: 'unknown' };

  /*
   * 'failed' means the upload path could not even read the server. It is not
   * evidence of anything — least of all of an absent backup.
   */
  if (input.keychain === 'failed') return { kind: 'unknown' };

  // A wrap lookup that did not answer is not a wrap that is not there.
  if (input.hasRecoveryWrap === null || input.hasPasskey === null) return { kind: 'unknown' };

  /*
   * Checked BEFORE the wrap, deliberately. An account with no chat keys and no
   * recovery is in no danger — there is nothing sealed to lose — and telling it
   * otherwise is the "prompting at signup about an empty keychain" mistake
   * `recoveryNudge.ts` was written to stop making.
   */
  if (input.keychain === 'empty') return { kind: 'nothing-at-stake' };

  if (!input.hasRecoveryWrap && !input.hasPasskey) return { kind: 'none' };

  if (input.keychain === 'untrusted') return { kind: 'unopenable' };

  return { kind: 'ok' };
}

/** Does this state need saying out loud? Narrows to the kinds a notice exists for. */
export function noticeKindFor(health: BackupHealth): BackupNoticeKind | null {
  return health.kind === 'none' || health.kind === 'unopenable' ? health.kind : null;
}
