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
import { getDeviceMasterKey, keyBackupHttp, recoverDevice } from '@/lib/mls/webTransport';
import * as km from '@/lib/mls/keyManager';
import * as kb from '@/lib/mls/keyBackup';
import { isPasskeySupported, registerPasskeyPrf, getPasskeyPrf } from '@/lib/passkeyPrf';
import { useTranslation } from '@/lib/i18n/I18nProvider';

const card: React.CSSProperties = {
  padding: '16px 18px',
  background: 'var(--color-bg-secondary)',
  border: '1px solid var(--border)',
  borderRadius: 10,
  marginBottom: 'var(--space-4)',
};
const btn: React.CSSProperties = {
  padding: '9px 14px',
  borderRadius: 8,
  border: '1px solid var(--border)',
  background: 'var(--color-bg-secondary)',
  color: 'var(--foreground)',
  fontSize: 'var(--text-body-sm)',
  cursor: 'pointer',
};
const label: React.CSSProperties = { fontSize: 'var(--text-caption)', color: 'var(--muted)', margin: 0 };

export function AccountRecovery({ userId, displayName }: { userId: string; displayName: string }) {
  const { t } = useTranslation();
  const http = keyBackupHttp();
  const [state, setState] = useState<km.KeyBackupState | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [shownCode, setShownCode] = useState<string | null>(null);
  const [recoverCode, setRecoverCode] = useState('');

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
    try {
      await fn();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const genRecoveryCode = () =>
    run(async () => {
      const mk = await getDeviceMasterKey();
      const code = await km.backupWithRecoveryCode(mk, http.postRecovery);
      setShownCode(code);
      setMsg(t('accountRecovery.recoveryCodeCreated'));
      await refresh();
    });

  const addPasskey = () =>
    run(async () => {
      const mk = await getDeviceMasterKey();
      const { credentialId, prfOutput } = await registerPasskeyPrf(userId, displayName);
      await km.backupWithPasskey(mk, credentialId, prfOutput, http.postPasskey);
      setMsg(t('accountRecovery.passkeyRegistered'));
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
    <div style={{ marginTop: 'var(--space-6)' }}>
      <h2 style={{ fontSize: 'var(--text-body-lg)', fontWeight: 700, letterSpacing: '-0.02em', margin: '0 0 4px' }}>
        {t('accountRecovery.heading')}
      </h2>
      <p style={{ ...label, marginBottom: 'var(--space-4)' }}>
        {t('accountRecovery.intro')}
      </p>

      {/* Status */}
      <div style={card}>
        <p style={label}>{t('accountRecovery.status')}</p>
        <p style={{ fontSize: 15, margin: '4px 0 0', color: hasBackup ? 'var(--foreground)' : 'var(--color-status-warning)' }}>
          {state == null
            ? t('accountRecovery.statusChecking')
            : hasBackup
              ? `${t('accountRecovery.statusSetUp')}${state.passkeys.length ? t('accountRecovery.statusPasskeyCount', { count: state.passkeys.length }) : ''}${state.wrappedMaster ? t('accountRecovery.statusRecoveryCode') : ''}.`
              : t('accountRecovery.statusNotSetUp')}
        </p>
      </div>

      {/* Back up */}
      <div style={card}>
        <p style={{ fontSize: 15, fontWeight: 600, margin: '0 0 10px' }}>{t('accountRecovery.backUp')}</p>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {isPasskeySupported() && (
            <button style={btn} disabled={busy} onClick={addPasskey}>
              {t('accountRecovery.registerPasskey')}
            </button>
          )}
          <button style={btn} disabled={busy} onClick={genRecoveryCode}>
            {t('accountRecovery.generateRecoveryCode')}
          </button>
        </div>
        {shownCode && (
          <div style={{ marginTop: 12 }}>
            <p style={label}>{t('accountRecovery.writeDownCode')}</p>
            <code
              style={{
                display: 'block',
                marginTop: 6,
                padding: '10px 12px',
                background: 'var(--color-bg-primary)',
                border: '1px solid var(--border)',
                borderRadius: 8,
                fontFamily: 'var(--font-mono)',
                fontSize: 15,
                letterSpacing: '0.06em',
                wordBreak: 'break-all',
              }}
            >
              {shownCode}
            </code>
            <button style={{ ...btn, marginTop: 8 }} onClick={() => setShownCode(null)}>
              {t('accountRecovery.savedIt')}
            </button>
          </div>
        )}
      </div>

      {/* Recover */}
      <div style={card}>
        <p style={{ fontSize: 15, fontWeight: 600, margin: '0 0 10px' }}>{t('accountRecovery.recoverOnDevice')}</p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {isPasskeySupported() && (
            <button style={btn} disabled={busy} onClick={recoverWithPasskeyFlow}>
              {t('accountRecovery.recoverWithPasskey')}
            </button>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              value={recoverCode}
              onChange={(e) => setRecoverCode(e.target.value)}
              placeholder={t('accountRecovery.recoveryCodePlaceholder')}
              style={{
                flex: 1,
                padding: '9px 12px',
                borderRadius: 8,
                border: '1px solid var(--border)',
                background: 'var(--color-bg-primary)',
                color: 'var(--foreground)',
                fontFamily: 'var(--font-mono)',
                // var(--text-body) = 16px: below that, iOS Safari zooms on focus.
                fontSize: 'var(--text-body)',
              }}
            />
            <button style={btn} disabled={busy || !recoverCode.trim()} onClick={recoverWithCode}>
              {t('accountRecovery.recover')}
            </button>
          </div>
        </div>
      </div>

      {msg && <p style={{ fontSize: 'var(--text-body-sm)', color: 'var(--color-brand-accent)', margin: '4px 0 0' }}>{msg}</p>}
      {err && <p style={{ fontSize: 'var(--text-body-sm)', color: 'var(--color-status-danger)', margin: '4px 0 0' }}>{err}</p>}
    </div>
  );
}
