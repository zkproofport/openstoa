/**
 * The account-level half of recovery: the SILENT REPAIR, plus the decision
 * behind the visible nudge. `RecoveryNudge` is the banner and nothing else.
 *
 * WHY THE SPLIT. These two jobs used to live in one component mounted at the
 * app root, so moving the banner to the Profile tab would have taken the repair
 * with it — and an account only gets repaired if its owner happens to open
 * Profile. That is the same shape as the bug the repair exists to fix, one
 * screen further out.
 *
 * 1. REPAIR (silent, runs wherever this provider is mounted).
 *    Make sure the account has a TAK-keychain backup at all. `tak_key_backups`
 *    used to be written ONLY by the TAK key-change hook, which fires when a key
 *    is newly WRITTEN — so a user who already held their keys and then
 *    registered a passkey got a wrapped master_key and an EMPTY keychain row.
 *    Recovering returned the key and unlocked nothing, and simply opening a chat
 *    wrote no new key, so the hook never fired again. This runs at SESSION
 *    START: the backup is account-level (one row per user, every topic), so
 *    binding its repair to any one screen is what let the gap persist.
 *
 *    Mounted in `OpenStoaApp.tsx` wrapping the whole tab navigator, which is
 *    what "every signed-in account, regardless of where they go" means here —
 *    the provider mounts as soon as the app reaches `ready`, before any tab has
 *    been chosen, and stays mounted for the rest of the run.
 *
 * 2. NUDGE DECISION (published through context, rendered by `RecoveryNudge`).
 *    `shouldNudgeRecovery` owns the decision itself — including why the prompt
 *    waits until there is something to lose rather than firing at signup. The
 *    banner is Profile-only by product decision: a person reading the feed does
 *    not need to be told about chat keys.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useHost } from '@openstoa/miniapp-bridge';
import { useOpenStoaClient } from '../hooks/useOpenStoaClient';
import { useOpenStoaSession } from '../stores/sessionStore';
import { ensureTakKeychainBackup, keyBackupHttp } from '../crypto/mobileTransport';
import { recoveryNudgeDismissKey, shouldNudgeRecovery } from '../lib/recoveryNudge';

export interface RecoveryNudgeState {
  /** Should the Profile banner be on screen right now? */
  show: boolean;
  /** Hide it and remember that, per account. */
  dismiss: () => void;
}

/**
 * Default for a banner rendered outside the provider: silent. Erring towards
 * "no banner" rather than throwing keeps a mis-wired mount from taking the
 * Profile tab down with it — and `recoveryNudgeProfileOnly.test.tsx` asserts
 * the provider really does wrap the navigator, so the silent default is a
 * fallback, not the thing being relied on.
 */
const RecoveryNudgeContext = createContext<RecoveryNudgeState>({
  show: false,
  dismiss: () => {},
});

export function useRecoveryNudge(): RecoveryNudgeState {
  return useContext(RecoveryNudgeContext);
}

export function RecoveryRepairProvider({ children }: { children?: React.ReactNode }) {
  const host = useHost();
  const client = useOpenStoaClient();
  const session = useOpenStoaSession();

  const [show, setShow] = useState(false);
  // The repair is account-level and idempotent; running it once per signed-in
  // session is the point. Without this latch every re-render that flips a
  // dependency would re-run it (and re-decide a banner the user just dismissed).
  //
  // Latched BY ACCOUNT, not by a bare boolean. This provider wraps the
  // navigator, so it is never remounted by tab navigation and a `useRef(false)`
  // stays true for the whole app run. That defeated the very thing
  // `recoveryNudgeDismissKey` exists for: A dismisses, B signs in without an app
  // restart, the effect re-runs on the new `userId` and returns on the latch —
  // so B never sees their own prompt, and `show` stays false from A's dismissal.
  // The docstring on that key names this exact case ("a handed-over phone must
  // not hide the prompt for the next person"). Keying the latch to the account
  // it ran for restores it: same account, still once; new account, it runs again.
  const ranFor = useRef<string | null>(null);

  const secureStore = host.secureStore;
  const localStore = host.localStore;
  const userId = session.userId;
  const authenticated = session.mode === 'authenticated';

  useEffect(() => {
    // No secure store means no master_key on this device at all — backup and
    // recovery are both unavailable here, so there is nothing to repair and
    // nothing worth prompting for.
    // Logged unconditionally: "the repair never ran" and "it ran and found
    // nothing" produced the same silence on device, and only one of them is a
    // bug in here.
    console.log(
      '[TAKBACKUP]',
      'repair/effect',
      JSON.stringify({ ranFor: ranFor.current, authenticated, hasUserId: !!userId, hasSecureStore: !!secureStore, hasLocalStore: !!localStore }),
    );
    if (ranFor.current === userId || !authenticated || !userId || !secureStore) return;
    ranFor.current = userId;
    // A new account starts from "no decision yet" rather than inheriting the
    // previous one's hidden banner.
    setShow(false);

    void (async () => {
      // Runs even when the banner will be suppressed, and regardless of which
      // tab the user is on: the repair is the fix for every account already in
      // the broken state, and it is silent by design.
      const backup = await ensureTakKeychainBackup(client, secureStore, localStore);

      let dismissed = false;
      try {
        dismissed = (await localStore?.getItem(recoveryNudgeDismissKey(userId))) === '1';
      } catch {
        // Storage unavailable: treat as not dismissed. Erring towards showing a
        // dismissible banner beats hiding the only prompt a user gets about
        // history nobody can recover.
      }
      if (dismissed) return;

      let hasRecovery = false;
      try {
        const wraps = await keyBackupHttp(client).getBackup();
        hasRecovery = !!wraps.wrappedMaster || wraps.passkeys.length > 0;
      } catch {
        return; // offline: never nag on a guess
      }

      setShow(shouldNudgeRecovery({ authenticated: true, dismissed: false, hasRecovery, backup }));
    })();
  }, [authenticated, userId, secureStore, localStore, client]);

  const dismiss = useCallback(() => {
    setShow(false);
    if (!userId) return;
    void localStore?.setItem(recoveryNudgeDismissKey(userId), '1').catch(() => {
      /* storage unavailable — the banner still closes for this session */
    });
  }, [localStore, userId]);

  const value = useMemo<RecoveryNudgeState>(() => ({ show, dismiss }), [show, dismiss]);

  return <RecoveryNudgeContext.Provider value={value}>{children}</RecoveryNudgeContext.Provider>;
}
