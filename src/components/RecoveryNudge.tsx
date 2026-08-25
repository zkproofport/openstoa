'use client';

/**
 * Two jobs, one pass over the same server state (design §10-1, Phase 4).
 *
 * 1. REPAIR (silent). Make sure the account has a TAK-keychain backup at all.
 *    `tak_key_backups` used to be written ONLY by the TAK key-change hook, which
 *    fires when a key is newly WRITTEN — so a user who already held their keys
 *    and then set recovery up got a wrapped master_key and an EMPTY keychain
 *    row. Recovering returned the key and unlocked nothing, and simply opening a
 *    chat wrote no new key, so the hook never fired again. Every account already
 *    in that state needs a trigger that does not depend on writing a key: this
 *    runs at SESSION START, not on chat-room entry, because the backup is
 *    account-level (one row per user, every topic) and binding its repair to one
 *    room is what let the gap persist.
 *
 * 2. NUDGE (visible, dismissible). Prompt a user who has chat history but no
 *    recovery at all. `shouldNudgeRecovery` owns that decision — including why
 *    the prompt waits until there is something to lose rather than firing at
 *    signup. This component only supplies the inputs and renders the banner.
 *
 * Mounted from `CommunityLayout`, the shell every signed-in page renders, so the
 * repair does not depend on the user visiting any particular screen. It renders
 * nothing at all for guests, on `/recovery` itself, and whenever the decision
 * says no — so the common case costs one layout slot and no markup.
 */
import { apiFetch } from '@/lib/apiFetch';
import { useSession } from '@/lib/useSession';
import { useEffect, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { ensureTakKeychainBackup, keyBackupHttp } from '@/lib/mls/webTransport';
import { recoveryNudgeDismissKey, shouldNudgeRecovery } from '@/lib/recoveryNudge';
import { useTranslation } from '@/lib/i18n/I18nProvider';

/** The page the nudge sends people to — and the one page it must never appear on. */
const RECOVERY_PATH = '/recovery';

function readDismissed(userId: string): boolean {
  try {
    return localStorage.getItem(recoveryNudgeDismissKey(userId)) === '1';
  } catch {
    // Private mode / storage disabled: treat as not dismissed. Erring towards
    // showing a dismissible banner is safer than erring towards hiding the only
    // prompt a user gets about unrecoverable history.
    return false;
  }
}

function writeDismissed(userId: string): void {
  try {
    localStorage.setItem(recoveryNudgeDismissKey(userId), '1');
  } catch {
    /* storage unavailable — the banner still closes for this session */
  }
}

export default function RecoveryNudge({
  isGuest,
  sessionChecked,
}: {
  isGuest: boolean;
  sessionChecked: boolean;
}) {
  const { t } = useTranslation();
  const router = useRouter();
  const pathname = usePathname();
  const [userId, setUserId] = useState<string | null>(null);
  // The repair is account-level and idempotent; running it once per mounted
  // session is the point. Without this latch a route change inside the shell
  // would re-run it (and re-decide the banner the user just dismissed).
  const ran = useRef(false);
  // Shared with the header and everything else on the page; this component is
  // only ever mounted inside the signed-in shell, so it is already resolved.
  const { session: nudgeSession } = useSession();

  useEffect(() => {
    if (ran.current || !sessionChecked || isGuest) return;
    /*
     * The latch goes AFTER the session check, not before it.
     *
     * The account arrives asynchronously now (a shared query rather than an
     * await inside this effect), so the first run happens with nothing to
     * repair. Latching there would consume the one chance this component has
     * and the repair would never run at all — the effect re-runs when the
     * session lands, and that is the run that must be allowed through.
     */
    if (!nudgeSession?.userId) return; // not known yet, or genuinely signed out
    ran.current = true;
    const id: string = nudgeSession.userId;

    void (async () => {
      setUserId(id);

      // Runs even when the banner will be suppressed: the repair is the fix for
      // every account already in the broken state, and it is silent by design.
      const backup = await ensureTakKeychainBackup();

      /*
       * THE REPAIR RUNS. THE PROMPT DOES NOT.
       *
       * `ensureTakKeychainBackup` above is the silent half and it stays: it
       * fixes accounts whose `tak_key_backups` row is empty because the
       * key-change hook only fires on a NEW key, so someone who already held
       * their keys and then registered a passkey got a wrapped master key and
       * an empty keychain. That asks nothing of anyone.
       *
       * What is gone is the banner. Backing up is a BUTTON in Profile
       * settings, pressed by someone who is moving to a new device, and the
       * docs are where that is explained. A person who has not asked to back up
       * is not in an error state, and the top of every page is not the place to
       * tell them otherwise.
       *
       * It is also worth recording WHY removing it beats fixing it. The nudge
       * already had a per-account dismissal — and it still came back on every
       * launch, because the dismissal was written to a store that is optional
       * on the mini-app's host bridge, so `?.` swallowed the write and "Not
       * now" meant "not for thirty seconds". The fix is not a better place to
       * record a dismissal; it is not having something to dismiss.
       */
      void backup;
    })();
    // `pathname` is read once, at the single run this latch permits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isGuest, sessionChecked, nudgeSession]);

  // Nothing to render: this component is the repair, not a prompt.
  return null;
}
