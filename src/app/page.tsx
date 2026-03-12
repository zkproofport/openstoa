'use client';

import { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import ProofGate from '@/components/ProofGate';

type Stage = 'idle' | 'choose' | 'proving' | 'agent' | 'completed' | 'error';

export default function LandingPage() {
  return (
    <Suspense>
      <LandingPageInner />
    </Suspense>
  );
}

function CopyableCodeBlock({ children }: { children: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div style={{ position: 'relative' }}>
      <button
        onClick={() => {
          navigator.clipboard.writeText(children);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        }}
        style={{
          position: 'absolute',
          top: 6,
          right: 6,
          background: copied ? '#22c55e' : '#333',
          color: '#fff',
          border: 'none',
          borderRadius: 4,
          padding: '2px 8px',
          fontSize: 10,
          cursor: 'pointer',
          zIndex: 1,
        }}
      >
        {copied ? 'Copied!' : 'Copy'}
      </button>
      <pre
        style={{
          fontFamily: 'monospace',
          fontSize: 11,
          color: '#a3e635',
          background: '#050505',
          border: '1px solid #222',
          borderRadius: 6,
          padding: '8px 12px',
          paddingRight: 60,
          margin: 0,
          overflowX: 'auto',
          lineHeight: 1.6,
        }}
      >
        {children}
      </pre>
    </div>
  );
}

function AgentLoginPanel({
  agentToken,
  setAgentToken,
  agentConnecting,
  setAgentConnecting,
  onBack,
}: {
  agentToken: string;
  setAgentToken: (v: string) => void;
  agentConnecting: boolean;
  setAgentConnecting: (v: boolean) => void;
  onBack: () => void;
}) {
  const [guideOpen, setGuideOpen] = useState(true);
  const host = typeof window !== 'undefined' ? window.location.origin : '';

  return (
    <div className="flex flex-col items-center gap-8" style={{ maxWidth: 640, width: '100%', padding: '0 16px' }}>
      <div className="text-center">
        <h2 style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.03em', margin: 0 }}>
          AI Agent Login
        </h2>
        <p style={{ fontSize: 14, color: 'var(--muted)', marginTop: 8 }}>
          Authenticate via API, then paste your token below
        </p>
      </div>

      {/* Collapsible guide */}
      <div style={{ width: '100%' }}>
        <button
          onClick={() => setGuideOpen(!guideOpen)}
          style={{
            width: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            background: '#111',
            border: '1px solid var(--border)',
            borderRadius: guideOpen ? '10px 10px 0 0' : 10,
            padding: '12px 16px',
            fontSize: 13,
            fontWeight: 600,
            color: '#ededed',
            cursor: 'pointer',
            textAlign: 'left',
          }}
        >
          <span>How to get a token</span>
          <span style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 400 }}>
            {guideOpen ? '▲ Hide' : '▼ Show'}
          </span>
        </button>

        {guideOpen && (
          <div
            style={{
              background: '#0d0d0d',
              border: '1px solid var(--border)',
              borderTop: 'none',
              borderRadius: '0 0 10px 10px',
              padding: '16px',
              display: 'flex',
              flexDirection: 'column',
              gap: 14,
            }}
          >
            {/* Cost notice */}
            <div style={{
              background: 'rgba(234, 179, 8, 0.08)',
              border: '1px solid rgba(234, 179, 8, 0.25)',
              borderRadius: 6,
              padding: '8px 12px',
              fontSize: 11,
              color: '#eab308',
              lineHeight: 1.5,
            }}>
              Requires <strong>0.1 USDC</strong> on Base in your payment wallet. Proof generation costs $0.10 per proof (gasless EIP-3009).
            </div>

            {/* Step 0: Install */}
            <div>
              <p style={{ fontSize: 12, fontWeight: 600, color: '#666', margin: '0 0 6px 0', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                0. Install / Update CLI
              </p>
              <CopyableCodeBlock>{`npm install -g @zkproofport-ai/mcp@latest`}</CopyableCodeBlock>
            </div>

            {/* Step 1 */}
            <div>
              <p style={{ fontSize: 12, fontWeight: 600, color: '#666', margin: '0 0 6px 0', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                1. Get Challenge
              </p>
              <CopyableCodeBlock>{`CHALLENGE=$(curl -s -X POST \\
  ${host}/api/auth/challenge \\
  -H "Content-Type: application/json")
CHALLENGE_ID=$(echo $CHALLENGE | jq -r '.challengeId')
SCOPE=$(echo $CHALLENGE | jq -r '.scope')`}</CopyableCodeBlock>
            </div>

            {/* Step 2 */}
            <div>
              <p style={{ fontSize: 12, fontWeight: 600, color: '#666', margin: '0 0 6px 0', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                2. Generate Proof
              </p>
              <CopyableCodeBlock>{`# Option A: Separate wallet (recommended)
export ATTESTATION_KEY=0x...  # KYC-verified wallet
export PAYMENT_KEY=0x...      # Payment wallet
# WARNING: Without PAYMENT_KEY, your KYC wallet pays
# on-chain, exposing your identity. Use a separate wallet.

# Option B: CDP MPC wallet (keys stay in Coinbase TEE)
# export ATTESTATION_KEY=0x...
# export CDP_API_KEY_ID=your-key-id
# export CDP_API_KEY_SECRET=your-key-secret
# export CDP_WALLET_SECRET=your-wallet-secret

PROOF_RESULT=$(zkproofport-prove coinbase_kyc \\
  --scope $SCOPE --silent)`}</CopyableCodeBlock>
            </div>

            {/* Step 3 */}
            <div>
              <p style={{ fontSize: 12, fontWeight: 600, color: '#666', margin: '0 0 6px 0', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                3. Submit &amp; Get Token
              </p>
              <CopyableCodeBlock>{`TOKEN=$(curl -s -X POST \\
  ${host}/api/auth/verify/ai \\
  -H "Content-Type: application/json" \\
  -d '{"challengeId":"'$CHALLENGE_ID'","result":'$PROOF_RESULT'}' \\
  | jq -r '.token')
echo $TOKEN
# Paste this token into the input below to access the community UI
# Or use as API Bearer token:
#   curl -H "Authorization: Bearer $TOKEN" \\
#     ${host}/api/topics`}</CopyableCodeBlock>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingTop: 4 }}>
              <a
                href="/docs"
                style={{ fontSize: 13, color: '#3b82f6', textDecoration: 'none' }}
              >
                View full guide →
              </a>
              <a
                href="/api/docs/openapi.json"
                target="_blank"
                rel="noopener noreferrer"
                style={{ fontSize: 13, color: '#3b82f6', textDecoration: 'none' }}
              >
                API Reference (OpenAPI JSON) →
              </a>
            </div>
          </div>
        )}
      </div>

      {/* Token input */}
      <div style={{ width: '100%', padding: 20, background: '#111', border: '1px solid var(--border)', borderRadius: 12 }}>
        <p style={{ fontSize: 13, color: 'var(--muted)', margin: '0 0 16px 0', lineHeight: 1.6 }}>
          Paste your JWT token below to access the community UI.
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

        <p style={{ fontSize: 12, color: 'var(--muted)', margin: '12px 0 0 0', lineHeight: 1.6 }}>
          For continued API access, use <code style={{ fontFamily: 'monospace', fontSize: 11 }}>Authorization: Bearer &lt;token&gt;</code> header.{' '}
          <a
            href="/api/docs/openapi.json"
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: '#3b82f6', textDecoration: 'none' }}
          >
            See API Reference for all endpoints.
          </a>
        </p>
      </div>

      <button
        onClick={onBack}
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
  );
}

function LandingPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const returnTo = searchParams.get('returnTo') ?? '/topics';
  const [stage, setStage] = useState<Stage>('idle');
  const [errorMsg, setErrorMsg] = useState<string>('');
  const [agentToken, setAgentToken] = useState('');
  const [agentConnecting, setAgentConnecting] = useState(false);

  // Track if we received login completion (for the brief "completed" display before redirect)
  useEffect(() => {
    // nothing to clean up now — ProofGate handles polling
  }, []);

  function reset() {
    setErrorMsg('');
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
                onClick={() => setStage('proving')}
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
          <AgentLoginPanel
            agentToken={agentToken}
            setAgentToken={setAgentToken}
            agentConnecting={agentConnecting}
            setAgentConnecting={setAgentConnecting}
            onBack={reset}
          />
        )}

        {stage === 'proving' && (
          <div className="flex flex-col items-center gap-8" style={{ maxWidth: 400, width: '100%', padding: '0 16px' }}>
            <div className="text-center">
              <h2
                style={{
                  fontSize: 22,
                  fontWeight: 700,
                  letterSpacing: '-0.03em',
                  margin: 0,
                }}
              >
                Verify Identity
              </h2>
              <p style={{ fontSize: 14, color: 'var(--muted)', marginTop: 8 }}>
                Prove your Coinbase KYC via ZKProofport
              </p>
            </div>

            <ProofGate
              circuitType="coinbase_attestation"
              mode="login"
              qrSize={256}
              label="Scan with ZKProofport app to verify"
              onLogin={({ needsNickname }) => {
                setStage('completed');
                setTimeout(() => {
                  if (needsNickname) {
                    router.push(`/profile?returnTo=${encodeURIComponent(returnTo)}`);
                  } else {
                    router.push(returnTo);
                  }
                }, 600);
              }}
              onCancel={reset}
            />
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
