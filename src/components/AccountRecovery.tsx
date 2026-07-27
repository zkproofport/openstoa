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

const card: React.CSSProperties = {
  padding: '16px 18px',
  background: 'var(--surface, #0c0e18)',
  border: '1px solid var(--border)',
  borderRadius: 10,
  marginBottom: 16,
};
const btn: React.CSSProperties = {
  padding: '9px 14px',
  borderRadius: 8,
  border: '1px solid var(--border)',
  background: 'var(--surface, #0c0e18)',
  color: 'var(--foreground)',
  fontSize: 14,
  cursor: 'pointer',
};
const label: React.CSSProperties = { fontSize: 13, color: 'var(--muted)', margin: 0 };

export function AccountRecovery({ userId, displayName }: { userId: string; displayName: string }) {
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
      setMsg('Recovery code created. Store it now — it is shown only once.');
      await refresh();
    });

  const addPasskey = () =>
    run(async () => {
      const mk = await getDeviceMasterKey();
      const { credentialId, prfOutput } = await registerPasskeyPrf(userId, displayName);
      await km.backupWithPasskey(mk, credentialId, prfOutput, http.postPasskey);
      setMsg('Passkey registered for recovery.');
      await refresh();
    });

  const recoverWithCode = () =>
    run(async () => {
      const code = recoverCode.trim();
      if (kb.recoveryCodeEntropyBits(code) < kb.RECOVERY_MIN_BITS) {
        throw new Error('That does not look like a valid recovery code.');
      }
      const mk = await km.recoverWithRecoveryCode(code, http.getBackup);
      if (!mk) throw new Error('Recovery failed — wrong code, or no recovery-code backup exists.');
      await recoverDevice(mk);
      setRecoverCode('');
      setMsg('Recovered. Your chat history will reload.');
    });

  const recoverWithPasskeyFlow = () =>
    run(async () => {
      const { prfOutput } = await getPasskeyPrf();
      const mk = await km.recoverWithPasskey(prfOutput, http.getBackup);
      if (!mk) throw new Error('Recovery failed — this passkey has no backup on file.');
      await recoverDevice(mk);
      setMsg('Recovered with passkey. Your chat history will reload.');
    });

  return (
    <div style={{ marginTop: 32 }}>
      <h2 style={{ fontSize: 18, fontWeight: 700, letterSpacing: '-0.02em', margin: '0 0 4px' }}>
        Chat recovery
      </h2>
      <p style={{ ...label, marginBottom: 16 }}>
        End-to-end encrypted chat keys live only on your devices. Set up recovery so you can restore
        your history if you lose them. We never see your keys.
      </p>

      {/* Status */}
      <div style={card}>
        <p style={label}>Status</p>
        <p style={{ fontSize: 15, margin: '4px 0 0', color: hasBackup ? 'var(--foreground)' : '#f0a020' }}>
          {state == null
            ? 'Checking…'
            : hasBackup
              ? `Recovery is set up${state.passkeys.length ? ` · ${state.passkeys.length} passkey(s)` : ''}${state.wrappedMaster ? ' · recovery code' : ''}.`
              : 'Not set up — you could permanently lose chat history if you lose your devices.'}
        </p>
      </div>

      {/* Back up */}
      <div style={card}>
        <p style={{ fontSize: 15, fontWeight: 600, margin: '0 0 10px' }}>Back up</p>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {isPasskeySupported() && (
            <button style={btn} disabled={busy} onClick={addPasskey}>
              Register a passkey
            </button>
          )}
          <button style={btn} disabled={busy} onClick={genRecoveryCode}>
            Generate a recovery code
          </button>
        </div>
        {shownCode && (
          <div style={{ marginTop: 12 }}>
            <p style={label}>Write this down and keep it safe. It is shown only once:</p>
            <code
              style={{
                display: 'block',
                marginTop: 6,
                padding: '10px 12px',
                background: 'var(--background, #05060a)',
                border: '1px solid var(--border)',
                borderRadius: 8,
                fontFamily: 'monospace',
                fontSize: 15,
                letterSpacing: '0.06em',
                wordBreak: 'break-all',
              }}
            >
              {shownCode}
            </code>
            <button style={{ ...btn, marginTop: 8 }} onClick={() => setShownCode(null)}>
              I&apos;ve saved it
            </button>
          </div>
        )}
      </div>

      {/* Recover */}
      <div style={card}>
        <p style={{ fontSize: 15, fontWeight: 600, margin: '0 0 10px' }}>Recover on this device</p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {isPasskeySupported() && (
            <button style={btn} disabled={busy} onClick={recoverWithPasskeyFlow}>
              Recover with a passkey
            </button>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              value={recoverCode}
              onChange={(e) => setRecoverCode(e.target.value)}
              placeholder="Enter recovery code"
              style={{
                flex: 1,
                padding: '9px 12px',
                borderRadius: 8,
                border: '1px solid var(--border)',
                background: 'var(--background, #05060a)',
                color: 'var(--foreground)',
                fontFamily: 'monospace',
                fontSize: 14,
              }}
            />
            <button style={btn} disabled={busy || !recoverCode.trim()} onClick={recoverWithCode}>
              Recover
            </button>
          </div>
        </div>
      </div>

      {msg && <p style={{ fontSize: 14, color: '#3ecf8e', margin: '4px 0 0' }}>{msg}</p>}
      {err && <p style={{ fontSize: 14, color: '#f0506e', margin: '4px 0 0' }}>{err}</p>}
    </div>
  );
}
