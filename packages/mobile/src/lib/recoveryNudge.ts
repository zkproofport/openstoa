/**
 * When to prompt a user to set up account recovery — and when to shut up.
 *
 * Recovery used to be reachable ONLY from `/recovery`, `/my` and the mobile
 * profile screen, so the overwhelmingly common case was a user who never set it
 * up and silently could not recover anything. This module holds the decision
 * itself, separate from either surface's UI, so both clients apply the same rule
 * and it can be tested without a renderer.
 *
 * THE MOMENT MATTERS. Prompting at signup is prompting about nothing: a fresh
 * account holds no TAK keys, so a backup then snapshots an empty keychain and
 * the warning ("you could lose your chat history") names something that does not
 * exist yet. The moment there IS something to lose is when chat keys exist —
 * i.e. once the user has joined a topic and opened its chat. `backup` carries
 * exactly that signal, because the session-boot repair already had to ask:
 *
 *   'uploaded'  this device's chat keys just went up  → there is history to lose
 *   'present'   the account already has a snapshot     → there is history to lose
 *   'empty'     no chat keys anywhere yet              → nothing to lose, stay quiet
 *   'untrusted' contradictory with hasRecovery=false   → claim nothing, stay quiet
 *   'failed'    we could not read the server           → claim nothing, stay quiet
 *
 * Two copies exist — `src/lib/recoveryNudge.ts` (web) and
 * `packages/mobile/src/lib/recoveryNudge.ts` (mini-app) — and a test asserts
 * they stay BYTE-IDENTICAL, so keep this file dependency-free.
 */

/** Result of the account-level TAK-keychain backup check run at session start. */
export type KeychainBackupState = 'uploaded' | 'empty' | 'present' | 'untrusted' | 'failed';

export interface RecoveryNudgeInputs {
  /** A real signed-in session. Guests have no account to back up. */
  authenticated: boolean;
  /** The user already dismissed this prompt (persisted per account). */
  dismissed: boolean;
  /** The server holds a passkey wrap or a recovery-code wrap for this account. */
  hasRecovery: boolean;
  /** What the session-start keychain-backup check found or did. */
  backup: KeychainBackupState;
}

/**
 * Show the first-run recovery nudge? Every gate is a NO — the prompt appears
 * only when all four agree, so a wrong answer errs towards silence rather than
 * towards nagging a user who already set recovery up or has nothing at stake.
 */
export function shouldNudgeRecovery(input: RecoveryNudgeInputs): boolean {
  if (!input.authenticated) return false;
  if (input.dismissed) return false;
  if (input.hasRecovery) return false;
  return input.backup === 'uploaded' || input.backup === 'present';
}

/**
 * Where a dismissal is remembered. Keyed BY ACCOUNT: a shared browser or a
 * handed-over phone must not hide the prompt for the next person, who has their
 * own unprotected history.
 */
export function recoveryNudgeDismissKey(userId: string): string {
  return `openstoa.recoveryNudge.dismissed.${userId}`;
}
