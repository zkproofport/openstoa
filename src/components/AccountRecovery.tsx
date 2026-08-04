'use client';

/**
 * Phase 4 account-recovery UI (design §6.4, §10-1). Two panels:
 *   - Back up: register a synced passkey (WebAuthn PRF) and/or generate a
 *     recovery code — either one lets the user recover their E2EE chat history
 *     after losing every device. The recovery code is shown ONCE.
 *   - Recover: on a device with no local master_key, restore it via passkey or
 *     recovery code, which also pulls the encrypted TAK-keychain backup so all
 *     archived history becomes readable again.
 *
 * "no escrow": the server only ever holds wrapped ciphertext (SI-8). If the user
 * sets up neither path, recovery is impossible by design — surfaced explicitly.
 */
import { useEffect, useState } from 'react';
import { getDeviceMasterKey, keyBackupHttp, recoverDevice, uploadTakKeychainNow } from '@/lib/mls/webTransport';
import * as km from '@/lib/mls/keyManager';
import * as kb from '@/lib/mls/keyBackup';
import { isPasskeySupported, registerPasskeyPrf, getPasskeyPrf } from '@/lib/passkeyPrf';
import { useTranslation } from '@/lib/i18n/I18nProvider';

// ─── Settings surface contract ───────────────────────────────────────────────

/**
 * ONE list idiom for every settings row on this surface.
 *
 * `/my`'s Settings tab used to stack five differently-styled panels — a bare
 * section here, a bordered card there, a tinted danger box at the bottom —
 * and the two components it embeds (`AiAgentSettings`, and `AccountRecovery`
 * via `/recovery`) each carried a third and fourth look. These two objects are
 * the whole contract: a bordered list, and a row inside it.
 *
 * Mirrored VERBATIM in `src/app/my/page.tsx` and
 * `src/components/AiAgentSettings.tsx`, which render into this same surface.
 * `src/__tests__/settingsSurface.test.tsx` re-parses all three files and fails
 * if any copy drifts, so "they match" is a checked fact, not a convention.
 */
const SETTINGS_LIST: React.CSSProperties = {
  background: 'var(--color-bg-secondary)',
  border: '1px solid var(--color-border-default)',
  borderRadius: 'var(--radius-card)',
  overflow: 'hidden',
};
const SETTINGS_ROW: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--space-4)',
  flexWrap: 'wrap',
  padding: 'var(--space-4)',
  minHeight: 'var(--touch-target-min)',
};

const ROW_DIVIDER: React.CSSProperties = { borderTop: '1px solid var(--color-border-default)' };
const ROW_TEXT: React.CSSProperties = { flex: '1 1 200px', minWidth: 0 };
const ROW_LABEL: React.CSSProperties = {
  fontSize: 'var(--text-body-sm)',
  fontWeight: 600,
  color: 'var(--color-text-primary)',
  margin: 0,
};
const ROW_HINT: React.CSSProperties = {
  fontSize: 'var(--text-caption)',
  color: 'var(--color-text-tertiary)',
  lineHeight: 'var(--leading-base)',
  maxWidth: '60ch',
  margin: '2px 0 0',
};
/** Section heading above a list. `.os-label` gates uppercase+tracking to :lang(en). */
const SECTION_HEADING: React.CSSProperties = {
  color: 'var(--color-text-tertiary)',
  margin: '0 0 var(--space-3)',
};
const SECTION: React.CSSProperties = { marginBottom: 'var(--space-6)' };

export function AccountRecovery({ userId, displayName }: { userId: string; displayName: string }) {
  const { t } = useTranslation();
  const http = keyBackupHttp();
  const [state, setState] = useState<km.KeyBackupState | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [shownCode, setShownCode] = useState<string | null>(null);
  const [recoverCode, setRecoverCode] = useState('');
  // Recovery succeeded but the chat-key snapshot did not go up. NOT an error —
  // the master_key wrap is real and worth keeping — but it must be VISIBLE,
  // because the resulting half-built state is exactly the reported bug.
  const [partial, setPartial] = useState<string | null>(null);

  async function refresh() {
    try {
      setState(await http.getBackup());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }
  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const hasBackup = !!state && (!!state.wrappedMaster || state.passkeys.length > 0);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setErr(null);
    setMsg(null);
    setPartial(null);
    try {
      await fn();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  /**
   * Setting recovery up IS the user saying "back up what I hold now".
   *
   * Without this, `tak_key_backups` was only ever written by the TAK key-CHANGE
   * hook, so a user who already held their keys and then registered a passkey
   * got a `key_backups` row and NOTHING to restore: recovery came back and
   * unlocked nothing, and opening a chat wrote no new key so the change hook
   * never fired again.
   *
   * NEVER rolls the master_key wrap back. A failed keychain upload leaves the
   * account strictly better off than no recovery at all — the honest move is to
   * keep the wrap and say plainly that the chat keys have not gone up yet.
   */
  async function backUpKeychain(): Promise<void> {
    switch (await uploadTakKeychainNow()) {
      case 'untrusted':
        setPartial(t('accountRecovery.keychainUntrusted'));
        break;
      case 'failed':
        setPartial(t('accountRecovery.keychainUploadFailed'));
        break;
      // 'uploaded' — done. 'empty' — no chat keys on this device yet, so there
      // is genuinely nothing to snapshot; the wrap alone is the right outcome.
      // 'present' is unreachable here (this path always attempts the upload).
    }
  }

  const genRecoveryCode = () =>
    run(async () => {
      const mk = await getDeviceMasterKey();
      const code = await km.backupWithRecoveryCode(mk, http.postRecovery);
      setShownCode(code);
      setMsg(t('accountRecovery.recoveryCodeCreated'));
      await backUpKeychain();
      await refresh();
    });

  const addPasskey = () =>
    run(async () => {
      const mk = await getDeviceMasterKey();
      const { credentialId, prfOutput } = await registerPasskeyPrf(userId, displayName);
      await km.backupWithPasskey(mk, credentialId, prfOutput, http.postPasskey);
      setMsg(t('accountRecovery.passkeyRegistered'));
      await backUpKeychain();
      await refresh();
    });

  const recoverWithCode = () =>
    run(async () => {
      const code = recoverCode.trim();
      if (kb.recoveryCodeEntropyBits(code) < kb.RECOVERY_MIN_BITS) {
        throw new Error(t('accountRecovery.invalidRecoveryCode'));
      }
      const mk = await km.recoverWithRecoveryCode(code, http.getBackup);
      if (!mk) throw new Error(t('accountRecovery.recoveryFailedCode'));
      await recoverDevice(mk);
      setRecoverCode('');
      setMsg(t('accountRecovery.recovered'));
    });

  const recoverWithPasskeyFlow = () =>
    run(async () => {
      const { prfOutput } = await getPasskeyPrf();
      const mk = await km.recoverWithPasskey(prfOutput, http.getBackup);
      if (!mk) throw new Error(t('accountRecovery.recoveryFailedPasskey'));
      await recoverDevice(mk);
      setMsg(t('accountRecovery.recoveredWithPasskey'));
    });

  return (
    <div>
      {/* `<h1>`, not `<h2>`: this component is rendered on exactly one page
          (`/recovery`), which carries no other heading — that page has no
          sidebar or tab bar to name it, so the heading has to. */}
      <h1
        style={{
          fontSize: 'var(--text-heading-lg)',
          fontWeight: 700,
          letterSpacing: '-0.03em',
          color: 'var(--color-text-primary)',
          margin: 0,
        }}
      >
        {t('accountRecovery.heading')}
      </h1>
      <p
        style={{
          fontSize: 'var(--text-body-sm)',
          color: 'var(--color-text-secondary)',
          lineHeight: 'var(--leading-base)',
          maxWidth: '68ch',
          margin: 'var(--space-2) 0 var(--space-6)',
        }}
      >
        {t('accountRecovery.intro')}
      </p>

      {/* Status */}
      <section style={SECTION}>
        <h2 className="os-label" style={SECTION_HEADING}>{t('accountRecovery.status')}</h2>
        <div style={SETTINGS_LIST}>
          <div style={SETTINGS_ROW}>
            <div style={ROW_TEXT}>
              <p
                style={{
                  ...ROW_LABEL,
                  color: state != null && !hasBackup ? 'var(--color-status-warning)' : 'var(--color-text-primary)',
                }}
              >
                {state == null
                  ? t('accountRecovery.statusChecking')
                  : hasBackup
                    ? `${t('accountRecovery.statusSetUp')}${state.passkeys.length ? t('accountRecovery.statusPasskeyCount', { count: state.passkeys.length }) : ''}${state.wrappedMaster ? t('accountRecovery.statusRecoveryCode') : ''}.`
                    : t('accountRecovery.statusNotSetUp')}
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Back up */}
      <section style={SECTION}>
        <h2 className="os-label" style={SECTION_HEADING}>{t('accountRecovery.backUp')}</h2>
        <div style={SETTINGS_LIST}>
          {isPasskeySupported() && (
            <div style={SETTINGS_ROW}>
              <div style={ROW_TEXT}>
                <p style={ROW_LABEL}>{t('accountRecovery.registerPasskey')}</p>
                <p style={ROW_HINT}>{t('accountRecovery.passkeyHint')}</p>
              </div>
              <button
                type="button"
                className="os-button"
                disabled={busy}
                onClick={addPasskey}
                style={{ cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.5 : 1 }}
              >
                {t('accountRecovery.registerPasskey')}
              </button>
            </div>
          )}
          <div style={{ ...SETTINGS_ROW, ...(isPasskeySupported() ? ROW_DIVIDER : null) }}>
            <div style={ROW_TEXT}>
              <p style={ROW_LABEL}>{t('accountRecovery.generateRecoveryCode')}</p>
              <p style={ROW_HINT}>{t('accountRecovery.recoveryCodeHint')}</p>
            </div>
            <button
              type="button"
              className="os-button"
              disabled={busy}
              onClick={genRecoveryCode}
              style={{ cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.5 : 1 }}
            >
              {t('accountRecovery.generateRecoveryCode')}
            </button>
          </div>
        </div>

        {/* The code is shown exactly once — a transient reveal the user must
            act on, so it deliberately does NOT read as a settings row. */}
        {shownCode && (
          <div
            style={{
              ...SETTINGS_LIST,
              background: 'color-mix(in srgb, var(--color-brand-accent) 6%, transparent)',
              border: '1px solid color-mix(in srgb, var(--color-brand-accent) 30%, transparent)',
              padding: 'var(--space-4)',
              marginTop: 'var(--space-3)',
            }}
          >
            <p style={{ ...ROW_LABEL, color: 'var(--color-brand-accent)' }}>{t('accountRecovery.writeDownCode')}</p>
            <code
              className="os-break-all"
              style={{
                display: 'block',
                marginTop: 'var(--space-2)',
                padding: 'var(--space-3)',
                background: 'var(--color-bg-primary)',
                border: '1px solid var(--color-border-default)',
                borderRadius: 'var(--radius-control)',
                fontFamily: 'var(--font-mono)',
                fontSize: 'var(--text-body)',
                letterSpacing: '0.06em',
              }}
            >
              {shownCode}
            </code>
            <button type="button" className="os-button" style={{ marginTop: 'var(--space-3)' }} onClick={() => setShownCode(null)}>
              {t('accountRecovery.savedIt')}
            </button>
          </div>
        )}
      </section>

      {/* Recover */}
      <section style={SECTION}>
        <h2 className="os-label" style={SECTION_HEADING}>{t('accountRecovery.recoverOnDevice')}</h2>
        <div style={SETTINGS_LIST}>
          {isPasskeySupported() && (
            <div style={SETTINGS_ROW}>
              <div style={ROW_TEXT}>
                <p style={ROW_LABEL}>{t('accountRecovery.recoverWithPasskey')}</p>
              </div>
              <button
                type="button"
                className="os-button"
                disabled={busy}
                onClick={recoverWithPasskeyFlow}
                style={{ cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.5 : 1 }}
              >
                {t('accountRecovery.recoverWithPasskey')}
              </button>
            </div>
          )}
          <div style={{ ...SETTINGS_ROW, ...(isPasskeySupported() ? ROW_DIVIDER : null), flexDirection: 'column', alignItems: 'stretch' }}>
            <p style={ROW_LABEL}>{t('accountRecovery.recover')}</p>
            <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', marginTop: 'var(--space-2)' }}>
              <input
                value={recoverCode}
                onChange={(e) => setRecoverCode(e.target.value)}
                placeholder={t('accountRecovery.recoveryCodePlaceholder')}
                aria-label={t('accountRecovery.recoveryCodePlaceholder')}
                style={{
                  flex: '1 1 200px',
                  minWidth: 0,
                  padding: '0 var(--space-3)',
                  minHeight: 'var(--touch-target-min)',
                  borderRadius: 'var(--radius-control)',
                  border: '1px solid var(--color-border-default)',
                  background: 'var(--color-bg-primary)',
                  color: 'var(--color-text-primary)',
                  fontFamily: 'var(--font-mono)',
                  // var(--text-body) = 16px: below that, iOS Safari zooms on focus.
                  fontSize: 'var(--text-body)',
                  boxSizing: 'border-box',
                }}
              />
              <button
                type="button"
                className="os-button"
                disabled={busy || !recoverCode.trim()}
                onClick={recoverWithCode}
                style={{
                  cursor: busy || !recoverCode.trim() ? 'not-allowed' : 'pointer',
                  opacity: busy || !recoverCode.trim() ? 0.5 : 1,
                }}
              >
                {t('accountRecovery.recover')}
              </button>
            </div>
          </div>
        </div>
      </section>

      {msg && (
        <p style={{ fontSize: 'var(--text-body-sm)', color: 'var(--color-brand-accent)', lineHeight: 'var(--leading-base)', maxWidth: '68ch', margin: 0 }}>
          {msg}
        </p>
      )}
      {/* Warning, not danger: the recovery key IS saved. What did not happen is
          the chat-key snapshot, and saying so is the whole point — a silent
          half-built recovery is the defect this page was reported for. */}
      {partial && (
        <p
          data-testid="recovery-partial"
          style={{ fontSize: 'var(--text-body-sm)', color: 'var(--color-status-warning)', lineHeight: 'var(--leading-base)', maxWidth: '68ch', margin: 'var(--space-2) 0 0' }}
        >
          {partial}
        </p>
      )}
      {err && (
        <p style={{ fontSize: 'var(--text-body-sm)', color: 'var(--color-status-danger)', lineHeight: 'var(--leading-base)', maxWidth: '68ch', margin: 'var(--space-2) 0 0' }}>
          {err}
        </p>
      )}
    </div>
  );
}
