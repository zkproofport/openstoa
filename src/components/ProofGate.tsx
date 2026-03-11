'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import Spinner from '@/components/Spinner';

interface ProofGateProps {
  /** Circuit to use */
  circuitType?: 'coinbase_attestation' | 'coinbase_country_attestation';
  scope?: string;
  countryList?: string[];
  isIncluded?: boolean;

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
  mode = 'login',
  onLogin,
  onProofData,
  label = 'Scan with ZKProofport app to verify',
  qrSize = 240,
  autoStart = true,
  onCancel,
}: ProofGateProps) {
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

      const res = await fetch('/api/auth/proof-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? 'Failed to create proof request');
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
          darkColor: '#ededed',
          lightColor: '#0a0a0a',
        });
        setQrDataUrl(url);
      } catch {
        // Fallback to qrcode library
        const QRCode = await import('qrcode');
        const url = await QRCode.toDataURL(data.deepLink, {
          width: qrSize,
          margin: 2,
          color: { dark: '#ededed', light: '#0a0a0a' },
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
      setErrorMsg(err instanceof Error ? err.message : 'Unknown error');
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
            color: '#fff',
            border: 'none',
            borderRadius: 8,
            padding: '10px 24px',
            fontSize: 13,
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          {label || 'Start Verification'}
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
            borderRadius: 16,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Spinner />
        </div>
        <p style={{ color: 'var(--muted)', fontSize: 14, margin: 0 }}>Generating proof request...</p>
      </div>
    );
  }

  // --- ERROR: message + retry ---
  if (state === 'error') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, padding: '16px 0' }}>
        <p style={{ color: '#ef4444', fontSize: 14, margin: 0, fontFamily: 'monospace' }}>
          {errorMsg}
        </p>
        <button
          type="button"
          onClick={startFlow}
          style={{
            background: 'var(--accent)',
            color: '#fff',
            border: 'none',
            borderRadius: 8,
            padding: '8px 20px',
            fontSize: 14,
            cursor: 'pointer',
          }}
        >
          Retry
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
            background: 'rgba(34,197,94,0.15)',
            border: '1px solid rgba(34,197,94,0.3)',
            borderRadius: '50%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 24,
            color: '#22c55e',
          }}
        >
          ✓
        </div>
        <p style={{ fontSize: 14, fontWeight: 600, color: '#22c55e', margin: 0 }}>
          Verification complete
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
                color: '#fff',
                border: 'none',
                borderRadius: 10,
                padding: '16px 40px',
                fontSize: 16,
                fontWeight: 600,
                textDecoration: 'none',
                textAlign: 'center',
                width: '100%',
                maxWidth: 320,
                letterSpacing: '-0.01em',
              }}
            >
              Open in ZKProofport →
            </a>
          )}
        </>
      ) : (
        <>
          {qrDataUrl && (
            <div
              style={{
                padding: 16,
                background: '#0a0a0a',
                border: '1px solid var(--border)',
                borderRadius: 16,
                position: 'relative',
              }}
            >
              <img
                src={qrDataUrl}
                alt="QR Code for ZKProofport verification"
                width={qrSize}
                height={qrSize}
                style={{ display: 'block', borderRadius: 8 }}
              />
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  borderRadius: 16,
                  boxShadow: '0 0 0 1px rgba(59,130,246,0.15) inset',
                  pointerEvents: 'none',
                }}
              />
            </div>
          )}
        </>
      )}

      <div style={{ textAlign: 'center' }}>
        <p style={{ fontSize: 14, color: 'var(--foreground)', fontWeight: 500, margin: 0 }}>
          {label}
        </p>
      </div>

      {!isMobile && deepLink && (
        <a
          href={deepLink}
          style={{
            fontSize: 12,
            color: 'var(--accent)',
            textDecoration: 'none',
            fontFamily: 'monospace',
          }}
        >
          Open in ZKProofport app →
        </a>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Spinner size={14} />
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>Waiting for proof...</span>
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
            fontSize: 13,
            cursor: 'pointer',
            padding: 0,
          }}
        >
          Cancel
        </button>
      )}
    </div>
  );
}
