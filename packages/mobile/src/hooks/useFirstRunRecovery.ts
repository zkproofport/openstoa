/**
 * Wiring the recovery sheet: when to ask, and making the key when the answer is
 * yes.
 *
 * THE ORDER IS THE POINT. The sheet opens BEFORE the key exists, because
 * creating it is a round trip — generate, wrap, upload — and a person staring at
 * a blank screen during that has no idea whether anything is happening. So the
 * sheet shows "creating…", then the key replaces it, and a failure has somewhere
 * to be reported instead of leaving the sheet stuck.
 *
 * ONE ATTEMPT PER LAUNCH. `started` is checked and set before the async work
 * begins, not after it resolves. Two renders arriving together would otherwise
 * both pass the check and both call `backupWithRecoveryCode`, which uploads two
 * wraps — the second replacing the first — and shows the person a code that is
 * no longer the one on file. That is worse than no code at all, because it looks
 * like it worked.
 *
 * WHAT IT DOES NOT DO. It does not decide whether to ask; `recoveryPrompt` does,
 * from the account's backup state and this install's mark. Keeping the decision
 * out of the hook is what lets it be tested against twenty launches without a
 * renderer.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  recoveryPrompt,
  markRecoveryShown,
  markRecoveryStored,
  type BackupState,
  type LocalFlagStore,
  type RecoveryPrompt,
} from '../lib/firstRunRecovery';

export interface FirstRunRecoveryDeps {
  /** Null until a session exists — nothing is asked of a signed-out app. */
  authenticated: boolean;
  /** This install's flag store. */
  store: LocalFlagStore | null;
  /** What the server knows about this account's backups. Null while loading. */
  backups: BackupState | null;
  /** True when this install has no local state yet. */
  isFirstRun: boolean;
  /** Generate + upload, returning the code to show once. */
  createCode: () => Promise<string>;
}

export interface FirstRunRecoveryState {
  prompt: RecoveryPrompt | null;
  code: string | null;
  error: string | null;
  onStored: () => void;
  onDismiss: () => void;
}

export function useFirstRunRecovery(deps: FirstRunRecoveryDeps): FirstRunRecoveryState {
  const { authenticated, store, backups, isFirstRun, createCode } = deps;
  const [prompt, setPrompt] = useState<RecoveryPrompt | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    /*
     * Nothing to decide until all three are known. `backups` in particular:
     * asking before the server has answered would show the sheet to an account
     * that already has a key, and the first thing it would do is make a second
     * one — replacing the wrap the person may have written down months ago.
     */
    if (!authenticated || !store || !backups) return;
    if (started.current) return;

    let cancelled = false;
    void (async () => {
      const decision = await recoveryPrompt(store, backups, { isFirstRun });
      if (cancelled || decision.kind !== 'show') return;

      // Claim the launch BEFORE the await, so a second render cannot also enter.
      started.current = true;
      setPrompt(decision);
      await markRecoveryShown(store);

      try {
        const c = await createCode();
        if (!cancelled) setCode(c);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [authenticated, store, backups, isFirstRun, createCode]);

  const onStored = useCallback(() => {
    setPrompt(null);
    if (store) void markRecoveryStored(store);
  }, [store]);

  /*
   * Dismissing leaves the `pending` mark alone rather than clearing it. It
   * suppresses a second sheet in THIS launch; the next launch reads the account
   * state again and asks once more, which is the pressure this is for.
   */
  const onDismiss = useCallback(() => setPrompt(null), []);

  return { prompt, code, error, onStored, onDismiss };
}
