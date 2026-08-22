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
  const [show, setShow] = useState(false);
  // The repair is account-level and idempotent; running it once per mounted
  // session is the point. Without this latch a route change inside the shell
  // would re-run it (and re-decide the banner the user just dismissed).
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current || !sessionChecked || isGuest) return;
    ran.current = true;

    void (async () => {
      let id: string;
      try {
        const r = await apiFetch('/api/auth/session');
        const data = r.ok ? ((await r.json()) as { userId?: string }) : null;
        if (!data?.userId) return; // no session after all — nothing to repair
        id = data.userId;
      } catch {
        return; // claim nothing about an account we could not identify
      }
      setUserId(id);

      // Runs even when the banner will be suppressed: the repair is the fix for
      // every account already in the broken state, and it is silent by design.
      const backup = await ensureTakKeychainBackup();

      if (pathname === RECOVERY_PATH) return; // already looking at the answer
      if (readDismissed(id)) return;

      let hasRecovery = false;
      try {
        const wraps = await keyBackupHttp().getBackup();
        hasRecovery = !!wraps.wrappedMaster || wraps.passkeys.length > 0;
      } catch {
        return; // offline: never nag on a guess
      }

      setShow(shouldNudgeRecovery({ authenticated: true, dismissed: false, hasRecovery, backup }));
    })();
    // `pathname` is read once, at the single run this latch permits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isGuest, sessionChecked]);

  if (!show) return null;

  const dismiss = () => {
    if (userId) writeDismissed(userId);
    setShow(false);
  };

  return (
    <div
      role="status"
      data-testid="recovery-nudge"
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 'var(--space-4)',
        flexWrap: 'wrap',
        padding: 'var(--space-4)',
        marginBottom: 'var(--space-4)',
        background: 'color-mix(in srgb, var(--color-status-warning) 8%, transparent)',
        border: '1px solid color-mix(in srgb, var(--color-status-warning) 30%, transparent)',
        borderRadius: 'var(--radius-card)',
      }}
    >
      <div style={{ flex: '1 1 260px', minWidth: 0 }}>
        <p
          style={{
            fontSize: 'var(--text-body-sm)',
            fontWeight: 600,
            color: 'var(--color-text-primary)',
            margin: 0,
          }}
        >
          {t('recoveryNudge.title')}
        </p>
        {/* States the loss plainly. A prompt that says "set up recovery" without
            saying what disappears without it is a prompt people rationally skip. */}
        <p
          style={{
            fontSize: 'var(--text-caption)',
            color: 'var(--color-text-secondary)',
            lineHeight: 'var(--leading-base)',
            maxWidth: '60ch',
            margin: '2px 0 0',
          }}
        >
          {t('recoveryNudge.body')}
        </p>
      </div>
      <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
        <button
          type="button"
          className="os-button"
          onClick={() => router.push(RECOVERY_PATH)}
          style={{ cursor: 'pointer' }}
        >
          {t('recoveryNudge.cta')}
        </button>
        <button
          type="button"
          className="os-button"
          aria-label={t('recoveryNudge.dismissAria')}
          onClick={dismiss}
          style={{ cursor: 'pointer', color: 'var(--color-text-tertiary)' }}
        >
          {t('recoveryNudge.dismiss')}
        </button>
      </div>
    </div>
  );
}
