'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

type Stage = 'idle' | 'choose' | 'proving' | 'agent' | 'completed' | 'error';

export default function LandingPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const returnTo = searchParams.get('returnTo') ?? '/topics';
  const [stage, setStage] = useState<Stage>('idle');
  const [requestId, setRequestId] = useState<string | null>(null);
  const [deepLink, setDeepLink] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string>('');
  const [isMobile, setIsMobile] = useState(false);
  const [agentToken, setAgentToken] = useState('');
  const [agentConnecting, setAgentConnecting] = useState(false);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const doneRef = useRef(false);

  useEffect(() => {
    const ua = navigator.userAgent;
    setIsMobile(/iPhone|iPad|iPod|Android/i.test(ua));
  }, []);

  useEffect(() => {
    return () => {
      if (pollingRef.current) clearInterval(pollingRef.current);
    };
  }, []);

  async function startProof() {
    setStage('proving');
    setErrorMsg('');
    doneRef.current = false;

    try {
      const res = await fetch('/api/auth/proof-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ circuitType: 'coinbase_attestation' }),
      });

      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? 'Failed to create proof request');
      }

      const data = await res.json();
      setRequestId(data.requestId);
      setDeepLink(data.deepLink);

      const { createSDK } = await import('@/lib/relay');
      const sdk = createSDK();
      const url = await sdk.generateQRCode(data.deepLink, {
        width: 256,
        margin: 2,
        darkColor: '#ededed',
        lightColor: '#0a0a0a',
      });
      setQrDataUrl(url);

      pollingRef.current = setInterval(async () => {
        if (doneRef.current) return;
        try {
          const pollRes = await fetch(`/api/auth/poll/${data.requestId}`);
          if (!pollRes.ok) return;
          const pollData = await pollRes.json();
          if (pollData.status === 'completed') {
            doneRef.current = true;
            if (pollingRef.current) clearInterval(pollingRef.current);
            setStage('completed');
            // Give state a tick to settle before redirect
            setTimeout(() => {
              if (pollData.needsNickname) {
                router.push(`/profile?returnTo=${encodeURIComponent(returnTo)}`);
              } else {
                router.push(returnTo);
              }
            }, 600);
          }
        } catch {
          // Silently retry
        }
      }, 2000);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Unknown error');
      setStage('error');
    }
  }

  function reset() {
    if (pollingRef.current) clearInterval(pollingRef.current);
    setRequestId(null);
    setDeepLink(null);
    setQrDataUrl(null);
    setErrorMsg('');
    doneRef.current = false;
    setStage('idle');
  }

  return (
    <div
      style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}
    >
      {/* Hero */}
      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          paddingTop: 80,
          paddingBottom: 80,
          position: 'relative',
        }}
      >
        {/* Background glow */}
        <div
          style={{
            position: 'absolute',
            top: '20%',
            left: '50%',
            transform: 'translateX(-50%)',
            width: '100%',
            maxWidth: 600,
            height: 300,
            background:
              'radial-gradient(ellipse at center, rgba(59,130,246,0.08) 0%, transparent 70%)',
            pointerEvents: 'none',
          }}
        />

        {stage === 'idle' && (
          <div className="flex flex-col items-center text-center gap-8" style={{ maxWidth: 520, width: '100%', padding: '0 16px' }}>
            <div className="flex flex-col items-center gap-4">
              <div
                style={{
                  width: 56,
                  height: 56,
                  background: 'var(--accent)',
                  borderRadius: 14,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 22,
                  fontWeight: 800,
                  color: '#fff',
                  letterSpacing: '-0.03em',
                }}
              >
                ZK
              </div>
              <h1
                style={{
                  fontSize: 42,
                  fontWeight: 800,
                  letterSpacing: '-0.04em',
                  lineHeight: 1.1,
                  margin: 0,
                }}
              >
                ZK Community
              </h1>
              <p
                style={{
                  fontSize: 16,
                  color: 'var(--muted)',
                  lineHeight: 1.6,
                  margin: 0,
                }}
              >
                A private community accessible only to Coinbase KYC verified users
              </p>
              <p
                style={{
                  fontSize: 13,
                  color: 'var(--muted)',
                  fontFamily: 'monospace',
                  background: 'var(--border)',
                  padding: '4px 12px',
                  borderRadius: 6,
                }}
              >
                zero-knowledge · privacy-preserving · on-chain verified
              </p>
            </div>

            <button
              onClick={() => setStage('choose')}
              style={{
                background: 'var(--accent)',
                color: '#fff',
                border: 'none',
                borderRadius: 10,
                padding: '14px 36px',
                fontSize: 15,
                fontWeight: 600,
                cursor: 'pointer',
                letterSpacing: '-0.01em',
                transition: 'opacity 0.15s',
              }}
              onMouseEnter={(e) => (e.currentTarget.style.opacity = '0.85')}
              onMouseLeave={(e) => (e.currentTarget.style.opacity = '1')}
            >
              Verify &amp; Enter
            </button>

            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                justifyContent: 'center',
                gap: '8px 24px',
                fontSize: 13,
                color: 'var(--muted)',
              }}
            >
              <span>✓ ZK Proof</span>
              <span>✓ No personal data stored</span>
              <span>✓ On-chain verified</span>
            </div>
          </div>
        )}

        {stage === 'choose' && (
          <div className="flex flex-col items-center gap-8" style={{ maxWidth: 440, width: '100%', padding: '0 16px' }}>
            <div className="text-center">
              <h2 style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.03em', margin: 0 }}>
                How do you want to verify?
              </h2>
              <p style={{ fontSize: 14, color: 'var(--muted)', marginTop: 8 }}>
                Choose your verification method
              </p>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, width: '100%' }}>
              <button
                onClick={startProof}
                style={{
                  background: 'var(--accent)',
                  color: '#fff',
                  border: 'none',
                  borderRadius: 10,
                  padding: '16px 24px',
                  fontSize: 15,
                  fontWeight: 600,
                  cursor: 'pointer',
                  textAlign: 'left',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4,
                }}
              >
                <span>Verify with ZKProofport App</span>
                <span style={{ fontSize: 12, fontWeight: 400, opacity: 0.8 }}>
                  Scan QR code or open deep link on mobile
                </span>
              </button>

              <button
                onClick={() => {
                  setStage('agent');
                  window.open('/docs', '_blank');
                }}
                style={{
                  background: '#111',
                  color: '#ededed',
                  border: '1px solid var(--border)',
                  borderRadius: 10,
                  padding: '16px 24px',
                  fontSize: 15,
                  fontWeight: 600,
                  cursor: 'pointer',
                  textAlign: 'left',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4,
                }}
              >
                <span>Login as AI Agent</span>
                <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--muted)' }}>
                  Authenticate via API with a session token
                </span>
              </button>
            </div>

            <button
              onClick={reset}
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--muted)',
                fontSize: 13,
                cursor: 'pointer',
                padding: 0,
              }}
            >
              Back
            </button>
          </div>
        )}

        {stage === 'agent' && (
          <div className="flex flex-col items-center gap-8" style={{ maxWidth: 480, width: '100%', padding: '0 16px' }}>
            <div className="text-center">
              <h2 style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.03em', margin: 0 }}>
                AI Agent Login
              </h2>
              <p style={{ fontSize: 14, color: 'var(--muted)', marginTop: 8 }}>
                Authenticate via API, then paste your token below
              </p>
            </div>

            <div style={{ width: '100%', padding: 20, background: '#111', border: '1px solid var(--border)', borderRadius: 12 }}>
              <p style={{ fontSize: 13, color: 'var(--muted)', margin: '0 0 16px 0', lineHeight: 1.6 }}>
                Use the API to get a session token, then paste it here to access the community UI.
              </p>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  type="text"
                  value={agentToken}
                  onChange={(e) => setAgentToken(e.target.value)}
                  placeholder="Paste JWT token here..."
                  style={{
                    flex: 1,
                    background: '#0a0a0a',
                    border: '1px solid var(--border)',
                    borderRadius: 8,
                    padding: '10px 14px',
                    fontSize: 13,
                    fontFamily: 'monospace',
                    color: '#ededed',
                    outline: 'none',
                  }}
                />
                <button
                  onClick={() => {
                    if (!agentToken.trim()) return;
                    setAgentConnecting(true);
                    window.location.href = `/api/auth/token-login?token=${encodeURIComponent(agentToken.trim())}`;
                  }}
                  disabled={!agentToken.trim() || agentConnecting}
                  style={{
                    background: agentToken.trim() ? 'var(--accent)' : '#333',
                    color: '#fff',
                    border: 'none',
                    borderRadius: 8,
                    padding: '10px 20px',
                    fontSize: 13,
                    fontWeight: 600,
                    cursor: agentToken.trim() ? 'pointer' : 'not-allowed',
                    whiteSpace: 'nowrap',
                    opacity: agentConnecting ? 0.6 : 1,
                  }}
                >
                  {agentConnecting ? 'Connecting...' : 'Connect'}
                </button>
              </div>

              <a
                href="/docs"
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  display: 'inline-block',
                  marginTop: 16,
                  fontSize: 13,
                  color: 'var(--accent)',
                  textDecoration: 'none',
                }}
              >
                View API Documentation →
              </a>
            </div>

            <button
              onClick={reset}
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--muted)',
                fontSize: 13,
                cursor: 'pointer',
                padding: 0,
              }}
            >
              Back
            </button>
          </div>
        )}

        {stage === 'proving' && (
          <div className="flex flex-col items-center gap-8" style={{ maxWidth: 400, width: '100%', padding: '0 16px' }}>
            {isMobile ? (
              <>
                <div className="text-center">
                  <h2
                    style={{
                      fontSize: 22,
                      fontWeight: 700,
                      letterSpacing: '-0.03em',
                      margin: 0,
                    }}
                  >
                    Open ZKProofport
                  </h2>
                  <p style={{ fontSize: 14, color: 'var(--muted)', marginTop: 8 }}>
                    Tap below to open the app and verify your identity
                  </p>
                </div>

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
                      cursor: 'pointer',
                      letterSpacing: '-0.01em',
                      textDecoration: 'none',
                      textAlign: 'center',
                      width: '100%',
                    }}
                  >
                    Open in ZKProofport →
                  </a>
                )}

                <div className="flex flex-col items-center gap-3">
                  <div className="flex items-center gap-2">
                    <Spinner size={14} />
                    <span style={{ fontSize: 13, color: 'var(--muted)' }}>
                      Waiting for proof...
                    </span>
                  </div>
                  <button
                    onClick={reset}
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
                </div>
              </>
            ) : (
              <>
                <div className="text-center">
                  <h2
                    style={{
                      fontSize: 22,
                      fontWeight: 700,
                      letterSpacing: '-0.03em',
                      margin: 0,
                    }}
                  >
                    Scan to Verify
                  </h2>
                  <p style={{ fontSize: 14, color: 'var(--muted)', marginTop: 8 }}>
                    Open ZKProofport app and scan this QR code
                  </p>
                </div>

                {qrDataUrl ? (
                  <div
                    style={{
                      padding: 20,
                      border: '1px solid var(--border)',
                      borderRadius: 20,
                      background: '#0d0d0d',
                      position: 'relative',
                    }}
                  >
                    <img
                      src={qrDataUrl}
                      alt="Proof request QR code"
                      width={256}
                      height={256}
                      style={{ display: 'block', borderRadius: 10 }}
                    />
                    <div
                      style={{
                        position: 'absolute',
                        inset: 0,
                        borderRadius: 20,
                        boxShadow: '0 0 0 1px rgba(59,130,246,0.2) inset',
                        pointerEvents: 'none',
                      }}
                    />
                  </div>
                ) : (
                  <div
                    style={{
                      width: 296,
                      height: 296,
                      border: '1px solid var(--border)',
                      borderRadius: 20,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <Spinner />
                  </div>
                )}

                <div className="flex flex-col items-center gap-3">
                  {deepLink && (
                    <a
                      href={deepLink}
                      style={{
                        fontSize: 13,
                        color: 'var(--accent)',
                        textDecoration: 'none',
                        fontFamily: 'monospace',
                      }}
                    >
                      Open in ZKProofport app →
                    </a>
                  )}
                  <div className="flex items-center gap-2">
                    <Spinner size={14} />
                    <span style={{ fontSize: 13, color: 'var(--muted)' }}>
                      Waiting for proof...
                    </span>
                  </div>
                  <button
                    onClick={reset}
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
                </div>
              </>
            )}
          </div>
        )}

        {stage === 'completed' && (
          <div className="flex flex-col items-center gap-6 text-center">
            <div
              style={{
                width: 64,
                height: 64,
                background: 'rgba(34,197,94,0.15)',
                border: '1px solid rgba(34,197,94,0.3)',
                borderRadius: '50%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 28,
              }}
            >
              ✓
            </div>
            <div>
              <h2
                style={{
                  fontSize: 22,
                  fontWeight: 700,
                  letterSpacing: '-0.03em',
                  margin: 0,
                  color: '#22c55e',
                }}
              >
                Verified!
              </h2>
              <p style={{ fontSize: 14, color: 'var(--muted)', marginTop: 8 }}>
                Redirecting...
              </p>
            </div>
          </div>
        )}

        {stage === 'error' && (
          <div className="flex flex-col items-center gap-6 text-center" style={{ maxWidth: 400 }}>
            <div
              style={{
                width: 64,
                height: 64,
                background: 'rgba(239,68,68,0.12)',
                border: '1px solid rgba(239,68,68,0.25)',
                borderRadius: '50%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 28,
              }}
            >
              ✗
            </div>
            <div>
              <h2
                style={{
                  fontSize: 22,
                  fontWeight: 700,
                  letterSpacing: '-0.03em',
                  margin: 0,
                }}
              >
                Something went wrong
              </h2>
              <p
                style={{
                  fontSize: 13,
                  color: '#ef4444',
                  marginTop: 8,
                  fontFamily: 'monospace',
                }}
              >
                {errorMsg}
              </p>
            </div>
            <button
              onClick={reset}
              style={{
                background: 'var(--accent)',
                color: '#fff',
                border: 'none',
                borderRadius: 8,
                padding: '10px 28px',
                fontSize: 14,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              Try Again
            </button>
          </div>
        )}
      </div>

    </div>
  );
}

function Spinner({ size = 28 }: { size?: number }) {
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
