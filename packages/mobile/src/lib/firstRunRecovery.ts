/**
 * Deciding whether this account still needs to be shown its recovery code.
 *
 * WHY IT IS A FIRST-RUN THING. `master_key` is generated on the phone and never
 * leaves it. Everything sealed under it — MLS group state, the archive keys, the
 * cached plaintexts — is unreadable to anyone who does not have that key,
 * including its owner on their next phone. The recovery code is the only copy
 * that exists outside the device, and the only moment at which somebody is
 * certain to still have the device is the moment they first sign in.
 *
 * AND IT DOES NOT GO STALE, which is the part worth stating because it reads
 * wrong at first. The code wraps `master_key`, and `master_key` does not change;
 * messages that arrive later are sealed under keys derived from that same key
 * and uploaded as the TAK backup. So a code written down on day one still opens
 * a backup made on day ninety. What the takeover screen warns about —
 * "anything after its last backup is not in it" — is the TAK UPLOAD being
 * behind, not the code being old.
 *
 * WHAT THIS FILE IS NOT. It does not generate or store the code; `keyManager`
 * does that and hands it back once. This only answers "should we be asking?",
 * which is a question about server state (is there a wrap on file) and local
 * state (has this install already shown one), and both have to be consulted:
 * asking a second time on a device that already did is noise, and NOT asking
 * because a flag was lost is silence about the one thing that cannot be undone.
 */

/** Where the "this install has shown it" mark lives. */
export const RECOVERY_SHOWN_KEY = 'openstoa.recovery.shown.v1';

export interface LocalFlagStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

/** What the server knows about this account's backups. */
export interface BackupState {
  /** A recovery-code wrap is on file. */
  hasRecoveryWrap: boolean;
  /** At least one passkey wrap is on file. */
  hasPasskey: boolean;
}

export type RecoveryPrompt =
  /** Nothing to do: a wrap already exists, or this install has been through it. */
  | { kind: 'none' }
  /** Show the code now, and require the person to confirm they stored it. */
  | { kind: 'show'; reason: 'first-run' | 'no-backup' };

/**
 * Should this launch ask?
 *
 * The account state wins over the local mark. A phone that shows the code and
 * then has its store wiped would otherwise never ask again — and "never asks
 * again" is indistinguishable, from the outside, from "has a backup".
 */
export async function recoveryPrompt(
  store: LocalFlagStore,
  backups: BackupState,
  opts: { isFirstRun: boolean },
): Promise<RecoveryPrompt> {
  if (backups.hasRecoveryWrap || backups.hasPasskey) return { kind: 'none' };

  if (opts.isFirstRun) return { kind: 'show', reason: 'first-run' };

  /*
   * Not a first run, and no backup anywhere.
   *
   * Reached by an account that dismissed the prompt, or whose backup was
   * removed. Asking again is right — the alternative is an account one lost
   * phone away from losing every room it is in, quietly.
   *
   * The local mark is read but not obeyed on its own: it only suppresses the
   * SAME launch asking twice.
   */
  let shown: string | null = null;
  try {
    shown = await store.getItem(RECOVERY_SHOWN_KEY);
  } catch {
    /*
     * A store that cannot be read is not a reason to skip. The cost of asking
     * twice is a dismissed sheet; the cost of not asking is unrecoverable.
     */
  }
  if (shown === 'pending') return { kind: 'none' };

  return { kind: 'show', reason: 'no-backup' };
}

/** Mark that this launch is showing it, so a re-render does not stack sheets. */
export async function markRecoveryShown(store: LocalFlagStore): Promise<void> {
  try {
    await store.setItem(RECOVERY_SHOWN_KEY, 'pending');
  } catch {
    // Losing the mark costs a duplicate prompt, which is the safe direction.
  }
}

/**
 * Mark that the person confirmed they stored it.
 *
 * Deliberately a DIFFERENT value from `pending`, so "we showed it" and "they
 * said they wrote it down" are distinguishable. A single boolean would let a
 * dismissed sheet look like a completed one.
 */
export async function markRecoveryStored(store: LocalFlagStore): Promise<void> {
  try {
    await store.setItem(RECOVERY_SHOWN_KEY, 'stored');
  } catch {
    // Same direction: worst case, they are asked again.
  }
}
