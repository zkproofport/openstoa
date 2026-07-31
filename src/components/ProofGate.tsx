'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import Spinner from '@/components/Spinner';
import { useTranslation } from '@/lib/i18n/I18nProvider';

interface ProofGateProps {
  /** Circuit to use */
  circuitType?: 'coinbase_attestation' | 'coinbase_country_attestation' | 'oidc_domain_attestation';
  scope?: string;
  countryList?: string[];
  isIncluded?: boolean;
  /** Domain for workspace/MS365 proof (e.g., 'company.com') */
  domain?: string;
  /** OIDC provider — determines which login flow the app shows */
  provider?: 'google' | 'microsoft';

  /**
   * 'login' — polls `/api/auth/poll/{id}` (no query param), calls onLogin on completion
   * 'proof'  — polls `/api/auth/poll/{id}?mode=proof`, calls onProofData with raw proof
   */
  mode?: 'login' | 'proof';

  /** Called when mode='login' and proof completes */
  onLogin?: (result: { requestId: string; nullifier?: string; needsNickname?: boolean }) => void;
  /** Called when mode='proof' and proof completes */
  onProofData?: (result: { proof: string; publicInputs: string[]; circuit: string }) => void;

  /** Label shown below the QR code */
  label?: string;
  /** QR code pixel size */
  qrSize?: number;

  /** If false, show a "Verify" button first instead of auto-starting. Default true. */
  autoStart?: boolean;

  /** Called when user clicks Cancel/Back */
  onCancel?: () => void;
}

type GateState = 'idle' | 'loading' | 'active' | 'completed' | 'error';

export default function ProofGate({
  circuitType = 'coinbase_attestation',
  scope,
  countryList,
  isIncluded,
  domain,
  provider,
  mode = 'login',
  onLogin,
  onProofData,
  label,
  qrSize = 240,
  autoStart = true,
  onCancel,
}: ProofGateProps) {
  const { t } = useTranslation();
  const effectiveLabel = label ?? t('proofGate.defaultLabel');
  const [state, setState] = useState<GateState>(autoStart ? 'loading' : 'idle');
  const [deepLink, setDeepLink] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isMobile, setIsMobile] = useState(false);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const doneRef = useRef(false);

  useEffect(() => {
    const ua = navigator.userAgent;
    setIsMobile(/iPhone|iPad|iPod|Android/i.test(ua));
  }, []);

  const cleanup = useCallback(() => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
  }, []);

  useEffect(() => {
    return cleanup;
  }, [cleanup]);

  const startFlow = useCallback(async () => {
    cleanup();
    setState('loading');
    setErrorMsg(null);
    setDeepLink(null);
    setQrDataUrl(null);
    doneRef.current = false;

    try {
      const body: Record<string, unknown> = { circuitType };
      if (scope) body.scope = scope;
      if (countryList) body.countryList = countryList;
      if (isIncluded !== undefined) body.isIncluded = isIncluded;
      if (domain) body.domain = domain;
      if (provider) body.provider = provider;

      const res = await fetch('/api/auth/proof-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? t('proofGate.requestFailed'));
      }

      const data = await res.json();
      setDeepLink(data.deepLink);

      // Generate QR — use SDK if available, else raw qrcode lib
      try {
        const { createSDK } = await import('@/lib/relay');
        const sdk = createSDK();
        const url = await sdk.generateQRCode(data.deepLink, {
          width: qrSize,
          margin: 2,
          darkColor: 'var(--color-text-primary)',
          lightColor: 'var(--color-bg-primary)',
        });
        setQrDataUrl(url);
      } catch {
        // Fallback to qrcode library
        const QRCode = await import('qrcode');
        const url = await QRCode.toDataURL(data.deepLink, {
          width: qrSize,
          margin: 2,
          color: { dark: 'var(--color-text-primary)', light: 'var(--color-bg-primary)' },
        });
        setQrDataUrl(url);
      }

      setState('active');

      // Start polling
      const pollUrl =
        mode === 'proof'
          ? `/api/auth/poll/${data.requestId}?mode=proof`
          : `/api/auth/poll/${data.requestId}`;

      pollingRef.current = setInterval(async () => {
        if (doneRef.current) return;
        try {
          const pollRes = await fetch(pollUrl);
          if (!pollRes.ok) return;
          const pollData = await pollRes.json();
          if (pollData.status === 'completed') {
            doneRef.current = true;
            if (pollingRef.current) clearInterval(pollingRef.current);
            setState('completed');

            if (mode === 'proof' && onProofData && pollData.proof && pollData.publicInputs) {
              onProofData({
                proof: pollData.proof,
                publicInputs: pollData.publicInputs,
                circuit: pollData.circuit ?? circuitType,
              });
            } else if (mode === 'login' && onLogin) {
              onLogin({
                requestId: data.requestId,
                nullifier: pollData.nullifier,
                needsNickname: pollData.needsNickname,
              });
            }
          }
        } catch {
          // Silently retry
        }
      }, 2000);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : t('proofGate.unknownError'));
      setState('error');
    }
  }, [circuitType, scope, countryList, isIncluded, mode, qrSize, onLogin, onProofData, cleanup]);

  // Auto-start on mount if autoStart is true
  const startedRef = useRef(false);
  useEffect(() => {
    if (autoStart && !startedRef.current) {
      startedRef.current = true;
      startFlow();
    }
  }, [autoStart, startFlow]);

  // --- IDLE: show start button ---
  if (state === 'idle') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, padding: '16px 0' }}>
        <button
          type="button"
          onClick={startFlow}
          style={{
            background: 'var(--accent)',
            color: 'var(--color-text-inverted)',
            border: 'none',
            borderRadius: 8,
            padding: '10px 24px',
            fontSize: 'var(--text-caption)',
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          {effectiveLabel || t('proofGate.startVerification')}
        </button>
      </div>
    );
  }

  // --- LOADING: spinner placeholder ---
  if (state === 'loading') {
    const containerSize = qrSize + 40; // padding
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16, padding: '16px 0' }}>
        <div
          style={{
            width: containerSize,
            height: containerSize,
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-modal)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Spinner />
        </div>
        <p style={{ color: 'var(--muted)', fontSize: 'var(--text-body-sm)', margin: 0 }}>{t('proofGate.generatingRequest')}</p>
      </div>
    );
  }

  // --- ERROR: message + retry ---
  if (state === 'error') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, padding: '16px 0' }}>
        <p style={{ color: 'var(--color-status-danger)', fontSize: 'var(--text-body-sm)', margin: 0, fontFamily: 'var(--font-mono)' }}>
          {errorMsg}
        </p>
        <button
          type="button"
          onClick={startFlow}
          style={{
            background: 'var(--accent)',
            color: 'var(--color-text-inverted)',
            border: 'none',
            borderRadius: 8,
            padding: '8px 20px',
            fontSize: 'var(--text-body-sm)',
            cursor: 'pointer',
          }}
        >
          {t('common.retry')}
        </button>
      </div>
    );
  }

  // --- COMPLETED: green checkmark ---
  if (state === 'completed') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, padding: '16px 0' }}>
        <div
          style={{
            width: 56,
            height: 56,
            background: 'color-mix(in srgb, var(--color-brand-accent) 15%, transparent)',
            border: '1px solid color-mix(in srgb, var(--color-brand-accent) 30%, transparent)',
            borderRadius: '50%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 24,
            color: 'var(--color-brand-accent)',
          }}
        >
          ✓
        </div>
        <p style={{ fontSize: 'var(--text-body-sm)', fontWeight: 600, color: 'var(--color-brand-accent)', margin: 0 }}>
          {t('proofGate.verificationComplete')}
        </p>
      </div>
    );
  }

  // --- ACTIVE: QR code or mobile button + polling ---
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16, padding: '16px 0' }}>
      {isMobile ? (
        <>
          {deepLink && (
            <a
              href={deepLink}
              style={{
                display: 'block',
                background: 'var(--accent)',
                color: 'var(--color-text-inverted)',
                border: 'none',
                borderRadius: 10,
                padding: '16px 40px',
                fontSize: 'var(--text-body)',
                fontWeight: 600,
                textDecoration: 'none',
                textAlign: 'center',
                width: '100%',
                maxWidth: 320,
                letterSpacing: '-0.01em',
              }}
            >
              {t('proofGate.openInApp')}
            </a>
          )}
        </>
      ) : (
        <>
          {qrDataUrl && (
            <div
              style={{
                padding: 'var(--space-4)',
                background: 'var(--color-bg-primary)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-modal)',
                position: 'relative',
              }}
            >
              <img
                src={qrDataUrl}
                alt={t('proofGate.qrAlt')}
                width={qrSize}
                height={qrSize}
                style={{ display: 'block', borderRadius: 8 }}
              />
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  borderRadius: 'var(--radius-modal)',
                  boxShadow: '0 0 0 1px color-mix(in srgb, var(--color-brand-primary) 15%, transparent) inset',
                  pointerEvents: 'none',
                }}
              />
            </div>
          )}
        </>
      )}

      <div style={{ textAlign: 'center' }}>
        <p style={{ fontSize: 'var(--text-body-sm)', color: 'var(--foreground)', fontWeight: 500, margin: 0 }}>
          {effectiveLabel}
        </p>
      </div>

      {!isMobile && deepLink && (
        <a
          href={deepLink}
          style={{
            fontSize: 'var(--text-label)',
            color: 'var(--accent)',
            textDecoration: 'none',
            fontFamily: 'var(--font-mono)',
          }}
        >
          {t('proofGate.openInAppSecondary')}
        </a>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Spinner size={14} />
        <span style={{ fontSize: 'var(--text-label)', color: 'var(--muted)' }}>{t('proofGate.waitingForProof')}</span>
      </div>

      {onCancel && (
        <button
          type="button"
          onClick={() => {
            cleanup();
            onCancel();
          }}
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--muted)',
            fontSize: 'var(--text-caption)',
            cursor: 'pointer',
            padding: 0,
          }}
        >
          {t('common.cancel')}
        </button>
      )}
    </div>
  );
}
