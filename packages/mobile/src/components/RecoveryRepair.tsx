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
 *
 * 3. THE NOTICE IN THE PERSON'S OWN ROOM (`sendBackupNotice`), for the account
 *    that has nothing backed up. It lands here rather than in a screen because
 *    this effect is the one place that already knows both halves of the answer
 *    — what the keychain upload found, and what wraps the server holds — and
 *    because it must not depend on anybody visiting a tab.
 *
 *    IT IS NOT A SECOND BANNER. The banner is a thing you see if you are on
 *    Profile and have not dismissed it; the message is a thing that raises an
 *    unread count, stays in the chat list, and is still there next month. That
 *    is why it is sent BEFORE the dismissal check below: dismissing the banner
 *    says "stop showing me this here", not "I have a backup now".
 *
 *    Once, ever, per distinct fact — enforced by reading the room, since only
 *    this device can. See `sendBackupNotice.ts`.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ChatMessage } from '@openstoa/api-types';
import { useHost } from '@openstoa/miniapp-bridge';
import { useOpenStoaClient } from '../hooks/useOpenStoaClient';
import { useOpenStoaSession } from '../stores/sessionStore';
import {
  ensureTakKeychainBackup,
  retryTakKeychainBackup,
  getMlsSessionStore,
  keyBackupHttp,
  toDisplayMessageMls,
  UNREADABLE_BODY,
} from '../crypto/mobileTransport';
import { recoveryNudgeDismissKey, shouldNudgeRecovery } from '../lib/recoveryNudge';
import { backupHealth } from '../lib/backupHealth';
import { refuseUnreadable, type OpenRow } from '../lib/personalRoomNote';
import { sendBackupNotice } from '../lib/sendBackupNotice';

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
  const { t } = useTranslation();

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

      /*
       * A failed repair used to end here. This effect latches on the user id
       * (`ranFor`), so nothing tried again until the app was killed and
       * reopened — and the repair is silent by design, so the person was never
       * told that was what it needed. Offline, an expired session and a server
       * hiccup all clear by themselves; the ladder waits them out and comes
       * back to a fast attempt rather than settling at its ceiling.
       */
      if (backup === 'failed' || backup === 'untrusted') {
        retryTakKeychainBackup(client, secureStore, localStore);
      }

      /*
       * Read the wraps BEFORE the dismissal check, and file the notice from
       * them, because the two prompts answer to different things. Dismissing
       * the banner means "stop putting this at the top of my Profile"; it does
       * not mean the account acquired a backup. The message in the person's own
       * room is the copy that survives that dismissal — it raises an unread
       * count once, stays in the chat list, and is still findable a month later
       * when they go looking for what the banner said.
       */
      let wraps: Awaited<ReturnType<ReturnType<typeof keyBackupHttp>['getBackup']>> | null = null;
      try {
        wraps = await keyBackupHttp(client).getBackup();
      } catch {
        // Offline. Claim nothing — not to the banner, not to the room.
      }

      /*
       * Fire-and-forget, and deliberately unreported. Everything it can hit is
       * either "already said" or "could not tell", and neither is something to
       * interrupt somebody with; a red line here would read as the account
       * having a NEW problem rather than as a reminder failing to be delivered.
       */
      const mls = getMlsSessionStore(client, secureStore, localStore);
      const open: OpenRow = async (topicId, row) =>
        (await toDisplayMessageMls(mls, topicId, row as ChatMessage)).message ?? '';

      void sendBackupNotice(
        client,
        mls,
        // A row this device cannot decrypt makes the whole scan inconclusive —
        // see `refuseUnreadable` for why silence is the right answer there.
        refuseUnreadable(open, UNREADABLE_BODY),
        backupHealth({
          authenticated: true,
          hasRecoveryWrap: wraps ? !!wraps.wrappedMaster : null,
          hasPasskey: wraps ? wraps.passkeys.length > 0 : null,
          keychain: backup,
        }),
        {
          none: {
            heading: t('openstoa.backupNotice.none.heading'),
            body: t('openstoa.backupNotice.none.body'),
          },
          unopenable: {
            heading: t('openstoa.backupNotice.unopenable.heading'),
            body: t('openstoa.backupNotice.unopenable.body'),
          },
        },
      ).catch(() => {
        /* never the thing that breaks a session */
      });

      let dismissed = false;
      try {
        dismissed = (await localStore?.getItem(recoveryNudgeDismissKey(userId))) === '1';
      } catch {
        // Storage unavailable: treat as not dismissed. Erring towards showing a
        // dismissible banner beats hiding the only prompt a user gets about
        // history nobody can recover.
      }
      if (dismissed) return;

      if (!wraps) return; // offline: never nag on a guess
      const hasRecovery = !!wraps.wrappedMaster || wraps.passkeys.length > 0;

      setShow(shouldNudgeRecovery({ authenticated: true, dismissed: false, hasRecovery, backup }));
    })();
  }, [authenticated, userId, secureStore, localStore, client, t]);

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
