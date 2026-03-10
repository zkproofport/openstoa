'use client';

import { useState, useEffect, useRef } from 'react';

interface ProofGateProps {
  onProofComplete: (result: { requestId: string; nullifier?: string }) => void;
  circuitType?: string;
  scope?: string;
  label?: string;
}

export default function ProofGate({
  onProofComplete,
  circuitType = 'coinbase_attestation',
  scope,
  label = 'Scan with ZKProofport app to verify',
}: ProofGateProps) {
  const [requestId, setRequestId] = useState<string | null>(null);
  const [deepLink, setDeepLink] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const doneRef = useRef(false);

  useEffect(() => {
    initProofRequest();
    return () => {
      if (pollingRef.current) clearInterval(pollingRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function initProofRequest() {
    setLoading(true);
    setError(null);
    doneRef.current = false;

    try {
      const body: Record<string, unknown> = { circuitType };
      if (scope) body.scope = scope;

      const res = await fetch('/api/auth/proof-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) throw new Error('Failed to create proof request');

      const data = await res.json();
      setRequestId(data.requestId);
      setDeepLink(data.deepLink);

      // Generate QR code
      const QRCode = await import('qrcode');
      const url = await QRCode.toDataURL(data.deepLink, {
        width: 240,
        margin: 2,
        color: { dark: '#ededed', light: '#0a0a0a' },
      });
      setQrDataUrl(url);
      setLoading(false);

      // Start polling
      pollingRef.current = setInterval(async () => {
        if (doneRef.current) return;
        try {
          const pollRes = await fetch(`/api/auth/poll/${data.requestId}`);
          if (!pollRes.ok) return;
          const pollData = await pollRes.json();
          if (pollData.status === 'completed') {
            doneRef.current = true;
            if (pollingRef.current) clearInterval(pollingRef.current);
            onProofComplete({ requestId: data.requestId, nullifier: pollData.nullifier });
          }
        } catch {
          // Silently retry
        }
      }, 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      setLoading(false);
    }
  }

  if (loading) {
    return (
      <div className="flex flex-col items-center gap-4 py-8">
        <div
          style={{
            width: 240,
            height: 240,
            border: '1px solid var(--border)',
            borderRadius: 12,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Spinner />
        </div>
        <p style={{ color: 'var(--muted)', fontSize: 14 }}>Generating proof request...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center gap-4 py-8">
        <p style={{ color: '#ef4444', fontSize: 14 }}>{error}</p>
        <button
          onClick={initProofRequest}
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

  return (
    <div className="flex flex-col items-center gap-6">
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
            width={240}
            height={240}
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

      <div className="text-center">
        <p style={{ fontSize: 14, color: 'var(--foreground)', fontWeight: 500 }}>{label}</p>
        <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
          Waiting for proof...
        </p>
      </div>

      {deepLink && (
        <a
          href={deepLink}
          style={{
            fontSize: 12,
            color: 'var(--accent)',
            textDecoration: 'none',
            fontFamily: 'monospace',
          }}
          className="hover:underline"
        >
          Open in app instead
        </a>
      )}

      <div className="flex items-center gap-2">
        <Spinner size={14} />
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>Polling for completion...</span>
      </div>
    </div>
  );
}

function Spinner({ size = 24 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="var(--accent)"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ animation: 'spin 1s linear infinite' }}
    >
      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  );
}
