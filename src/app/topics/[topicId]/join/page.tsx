'use client';

import { useState, useEffect } from 'react';
import { useParams, useSearchParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import CommunityLayout from '@/components/CommunityLayout';
import Spinner from '@/components/Spinner';
import ProofGate from '@/components/ProofGate';

interface TopicInfo {
  id: string;
  title: string;
  description?: string;
  memberCount: number;
  requiresCountryProof: boolean;
  allowedCountries?: string[];
  proofType?: string;
  requiredDomain?: string;
  isMember: boolean;
}

export default function JoinPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const router = useRouter();
  const topicId = params.topicId as string;
  const inviteCode = searchParams.get('invite') ?? '';

  const [topicInfo, setTopicInfo] = useState<TopicInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);

  // Proof state
  const [effectiveProofType, setEffectiveProofType] = useState<string>('none');
  const [proofDone, setProofDone] = useState(false);
  const [proofData, setProofData] = useState<{
    proof: string;
    publicInputs: string[];
  } | null>(null);
  // For workspace (either) topics, joiner picks their provider — null until selected
  const [joinProvider, setJoinProvider] = useState<'google' | 'microsoft' | null>(null);

  useEffect(() => {
    loadTopicInfo();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadTopicInfo() {
    try {
      let info: TopicInfo;
      if (inviteCode) {
        const res = await fetch(`/api/topics/join/${inviteCode}`);
        if (!res.ok) throw new Error('Invite link is invalid or expired');
        const data = await res.json();
        info = { ...data.topic, isMember: data.isMember, memberCount: data.topic.memberCount ?? 0 };
      } else {
        const res = await fetch(`/api/topics/${topicId}`);
        if (!res.ok) throw new Error('Topic not found');
        const data = await res.json();
        info = data.topic;
      }
      setTopicInfo(info);

      if (info.isMember) {
        router.replace(`/topics/${info.id}`);
        return;
      }

      const pt = info.proofType || (info.requiresCountryProof ? 'country' : 'none');
      setEffectiveProofType(pt);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load topic');
    } finally {
      setLoading(false);
    }
  }

  async function handleJoin() {
    if (!topicInfo) return;
    setJoining(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {};
      if (inviteCode) body.inviteCode = inviteCode;
      if (proofData) {
        body.proof = proofData.proof;
        body.publicInputs = proofData.publicInputs;
      }

      const res = await fetch(`/api/topics/${topicInfo.id}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? 'Failed to join topic');
      }
      router.push(`/topics/${topicInfo.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      setJoining(false);
    }
  }

  const needsProof = effectiveProofType !== 'none';
  const canJoin = topicInfo && (!needsProof || proofDone);

  if (loading) {
    return (
      <CommunityLayout isGuest={false} sessionChecked={true}>
        <div style={{ display: 'flex', justifyContent: 'center', padding: '80px 0' }}>
          <Spinner />
        </div>
      </CommunityLayout>
    );
  }

  if (error && !topicInfo) {
    return (
      <CommunityLayout isGuest={false} sessionChecked={true}>
        <div style={{ padding: '60px 0', textAlign: 'center' }}>
          <p style={{ color: '#ef4444', fontFamily: 'monospace', fontSize: 14, marginBottom: 16 }}>
            {error}
          </p>
        </div>
      </CommunityLayout>
    );
  }

  return (
    <CommunityLayout isGuest={false} sessionChecked={true}>
      <div
        style={{
          minHeight: 'calc(100vh - 73px)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '40px 1.5rem',
        }}
      >
        <div style={{ width: '100%', maxWidth: 460 }}>
          {/* Topic card */}
          {topicInfo && (
            <div
              style={{
                padding: '24px',
                background: 'var(--surface, #0c0e18)',
                border: '1px solid var(--border)',
                borderRadius: 14,
                marginBottom: 28,
              }}
            >
              <p style={{ fontSize: 15, color: 'var(--muted)', fontFamily: 'monospace', margin: '0 0 8px' }}>
                You&apos;ve been invited to
              </p>
              <h1 style={{ fontSize: 26, fontWeight: 800, letterSpacing: '-0.03em', margin: '0 0 8px' }}>
                {topicInfo.title}
              </h1>
              {topicInfo.description && (
                <p style={{ fontSize: 14, color: 'var(--muted)', margin: '0 0 12px', lineHeight: 1.6 }}>
                  {topicInfo.description}
                </p>
              )}
              <div className="flex items-center gap-3 flex-wrap">
                <span
                  style={{
                    fontSize: 14,
                    fontFamily: 'monospace',
                    color: 'var(--muted)',
                  }}
                >
                  {topicInfo.memberCount} member{topicInfo.memberCount !== 1 ? 's' : ''}
                </span>
                {effectiveProofType !== 'none' && (
                  <span
                    style={{
                      fontSize: 15,
                      fontFamily: 'monospace',
                      background: 'rgba(59,130,246,0.12)',
                      color: 'var(--accent)',
                      border: '1px solid rgba(59,130,246,0.2)',
                      padding: '2px 7px',
                      borderRadius: 4,
                    }}
                  >
                    {effectiveProofType === 'kyc' ? 'KYC required' :
                     effectiveProofType === 'country' ? 'country gated' :
                     effectiveProofType === 'google_workspace' ? 'Google Workspace required' :
                     effectiveProofType === 'microsoft_365' ? 'Microsoft 365 required' :
                     effectiveProofType === 'workspace' ? 'organization proof required' :
                     'proof required'}
                  </span>
                )}
              </div>
            </div>
          )}

          {/* Proof section */}
          {needsProof && !proofDone && topicInfo && (
            <div
              style={{
                padding: '24px',
                background: 'var(--surface, #0c0e18)',
                border: '1px solid var(--border)',
                borderRadius: 14,
                marginBottom: 20,
                textAlign: 'center',
              }}
            >
              <p style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>
                {effectiveProofType === 'kyc' ? 'KYC Verification Required' :
                 effectiveProofType === 'country' ? 'Country Proof Required' :
                 effectiveProofType === 'google_workspace' ? 'Google Workspace Verification Required' :
                 effectiveProofType === 'microsoft_365' ? 'Microsoft 365 Verification Required' :
                 effectiveProofType === 'workspace' ? 'Organization Verification Required' :
                 'Proof Required'}
              </p>
              <p style={{ fontSize: 15, color: 'var(--muted)', marginBottom: 20, lineHeight: 1.5 }}>
                {effectiveProofType === 'kyc'
                  ? 'This topic requires Coinbase KYC verification via ZKProofport.'
                  : effectiveProofType === 'country'
                  ? 'This topic requires proof of your country via ZKProofport.'
                  : effectiveProofType === 'google_workspace'
                  ? `This topic requires Google Workspace domain verification${topicInfo.requiredDomain ? ` (${topicInfo.requiredDomain})` : ''}.`
                  : effectiveProofType === 'microsoft_365'
                  ? `This topic requires Microsoft 365 domain verification${topicInfo.requiredDomain ? ` (${topicInfo.requiredDomain})` : ''}.`
                  : effectiveProofType === 'workspace'
                  ? `This topic requires organization membership verification${topicInfo.requiredDomain ? ` (${topicInfo.requiredDomain})` : ''} via Google Workspace or Microsoft 365.`
                  : 'This topic requires proof verification via ZKProofport.'}
              </p>

              {/* Provider chooser for workspace (either) topics */}
              {effectiveProofType === 'workspace' && (
                <div style={{ marginBottom: 16 }}>
                  <p style={{ fontSize: 14, color: 'var(--muted)', marginBottom: 8 }}>
                    Verify with:
                  </p>
                  <div style={{ display: 'flex', gap: 12, justifyContent: 'center' }}>
                    {([
                      { value: 'google' as const, label: 'Google Workspace' },
                      { value: 'microsoft' as const, label: 'Microsoft 365' },
                    ]).map((opt) => (
                      <label key={opt.value} style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        padding: '8px 14px',
                        background: joinProvider === opt.value ? 'rgba(59,130,246,0.06)' : '#111',
                        border: `1px solid ${joinProvider === opt.value ? 'rgba(59,130,246,0.3)' : 'var(--border)'}`,
                        borderRadius: 8,
                        cursor: 'pointer',
                        transition: 'all 0.12s',
                        fontSize: 14,
                      }}>
                        <input
                          type="radio"
                          name="joinProvider"
                          checked={joinProvider === opt.value}
                          onChange={() => {
                            setJoinProvider(opt.value);
                            setProofData(null);
                            setProofDone(false);
                          }}
                          style={{ accentColor: 'var(--accent)' }}
                        />
                        {opt.label}
                      </label>
                    ))}
                  </div>
                </div>
              )}

              {/* Show ProofGate only when provider is determined (workspace requires explicit selection) */}
              {(effectiveProofType !== 'workspace' || joinProvider) && (
                <ProofGate
                  key={joinProvider ?? effectiveProofType}
                  circuitType={
                    effectiveProofType === 'kyc' ? 'coinbase_attestation' :
                    effectiveProofType === 'country' ? 'coinbase_country_attestation' :
                    'oidc_domain_attestation'
                  }
                  scope="zkproofport-community"
                  countryList={effectiveProofType === 'country' ? (topicInfo.allowedCountries ?? []) : undefined}
                  isIncluded={effectiveProofType === 'country' ? true : undefined}
                  domain={
                    (effectiveProofType === 'google_workspace' || effectiveProofType === 'microsoft_365' || effectiveProofType === 'workspace')
                      ? topicInfo.requiredDomain
                      : undefined
                  }
                  provider={
                    effectiveProofType === 'google_workspace' ? 'google' :
                    effectiveProofType === 'microsoft_365' ? 'microsoft' :
                    effectiveProofType === 'workspace' ? (joinProvider ?? undefined) :
                    undefined
                  }
                  mode="proof"
                  autoStart={false}
                  qrSize={224}
                  label={
                    effectiveProofType === 'kyc' ? 'Scan with ZKProofport app to verify KYC' :
                    effectiveProofType === 'country' ? 'Scan with ZKProofport app to verify your country' :
                    effectiveProofType === 'workspace' ? `Scan with ZKProofport app to verify your ${joinProvider === 'microsoft' ? 'Microsoft 365' : 'Google Workspace'} affiliation` :
                    'Scan with ZKProofport app to verify your organization'
                  }
                  onProofData={({ proof, publicInputs }) => {
                    setProofData({ proof, publicInputs });
                    setProofDone(true);
                  }}
                />
              )}
              {effectiveProofType === 'workspace' && !joinProvider && (
                <p style={{ fontSize: 14, color: 'var(--muted)', textAlign: 'center', margin: '16px 0 0' }}>
                  Select a provider above to start verification
                </p>
              )}
            </div>
          )}

          {needsProof && proofDone && (
            <div
              style={{
                padding: '14px 18px',
                background: 'rgba(34,197,94,0.08)',
                border: '1px solid rgba(34,197,94,0.25)',
                borderRadius: 10,
                marginBottom: 20,
                display: 'flex',
                alignItems: 'center',
                gap: 10,
              }}
            >
              <span style={{ color: '#22c55e', fontSize: 18 }}>✓</span>
              <span style={{ fontSize: 14, color: '#22c55e', fontWeight: 500 }}>
                Verification complete
              </span>
            </div>
          )}

          {/* Privacy notice for proof-gated topics */}
          {needsProof && (
            <div
              style={{
                padding: '12px 16px',
                background: 'rgba(59,130,246,0.05)',
                border: '1px solid rgba(59,130,246,0.15)',
                borderRadius: 8,
                marginBottom: 16,
                fontSize: 13,
                color: 'var(--muted)',
                lineHeight: 1.5,
              }}
            >
              <span style={{ fontWeight: 600, color: 'var(--foreground)' }}>Privacy:</span>{' '}
              Your proof is verified without storing personal information. Only a hashed
              verification status is cached for 30 days to avoid repeated proofs. No email,
              domain, or country data is saved to the database.
            </div>
          )}

          {error && (
            <p
              style={{
                fontSize: 15,
                color: '#ef4444',
                fontFamily: 'monospace',
                background: 'rgba(239,68,68,0.08)',
                border: '1px solid rgba(239,68,68,0.2)',
                borderRadius: 6,
                padding: '8px 12px',
                marginBottom: 16,
              }}
            >
              {error}
            </p>
          )}

          <button
            onClick={handleJoin}
            disabled={!canJoin || joining}
            style={{
              width: '100%',
              background: canJoin ? 'var(--accent)' : 'var(--border)',
              color: canJoin ? '#fff' : 'var(--muted)',
              border: 'none',
              borderRadius: 10,
              padding: '14px',
              fontSize: 15,
              fontWeight: 600,
              cursor: canJoin ? 'pointer' : 'not-allowed',
              transition: 'all 0.15s',
              letterSpacing: '-0.01em',
            }}
          >
            {joining ? 'Joining...' : needsProof && !proofDone ? 'Complete verification to join' : 'Join Topic'}
          </button>

          <div style={{ textAlign: 'center', marginTop: 16 }}>
            <Link href="/topics" style={{ fontSize: 15, color: 'var(--muted)', textDecoration: 'none' }}>
              Browse all topics instead
            </Link>
          </div>
        </div>
      </div>
    </CommunityLayout>
  );
}
