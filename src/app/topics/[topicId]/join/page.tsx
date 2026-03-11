'use client';

import { useState, useEffect } from 'react';
import { useParams, useSearchParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import Header from '@/components/Header';
import Spinner from '@/components/Spinner';
import ProofGate from '@/components/ProofGate';

interface TopicInfo {
  id: string;
  title: string;
  description?: string;
  memberCount: number;
  requiresCountryProof: boolean;
  allowedCountries?: string[];
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

  // Country proof state
  const [needsCountryProof, setNeedsCountryProof] = useState(false);
  const [proofDone, setProofDone] = useState(false);
  const [countryProofData, setCountryProofData] = useState<{
    proof: string;
    publicInputs: string[];
  } | null>(null);

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

      setNeedsCountryProof(info.requiresCountryProof);
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
      if (countryProofData) {
        body.proof = countryProofData.proof;
        body.publicInputs = countryProofData.publicInputs;
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

  const canJoin = topicInfo && (!needsCountryProof || proofDone);

  if (loading) {
    return (
      <>
        <Header />
        <div style={{ display: 'flex', justifyContent: 'center', padding: '80px 0' }}>
          <Spinner />
        </div>
      </>
    );
  }

  if (error && !topicInfo) {
    return (
      <>
        <Header />
        <div style={{ padding: '60px 0', textAlign: 'center' }}>
          <p style={{ color: '#ef4444', fontFamily: 'monospace', fontSize: 14, marginBottom: 16 }}>
            {error}
          </p>
          <Link href="/topics" style={{ color: 'var(--accent)', fontSize: 14 }}>
            ← Browse topics
          </Link>
        </div>
      </>
    );
  }

  return (
    <>
      <Header />
      <div
        style={{
          minHeight: 'calc(100vh - 73px)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '40px 0',
        }}
      >
        <div style={{ width: '100%', maxWidth: 460 }}>
          {/* Topic card */}
          {topicInfo && (
            <div
              style={{
                padding: '24px',
                background: '#0d0d0d',
                border: '1px solid var(--border)',
                borderRadius: 14,
                marginBottom: 28,
              }}
            >
              <p style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'monospace', margin: '0 0 8px' }}>
                You&apos;ve been invited to
              </p>
              <h1 style={{ fontSize: 22, fontWeight: 800, letterSpacing: '-0.03em', margin: '0 0 8px' }}>
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
                    fontSize: 12,
                    fontFamily: 'monospace',
                    color: 'var(--muted)',
                  }}
                >
                  {topicInfo.memberCount} member{topicInfo.memberCount !== 1 ? 's' : ''}
                </span>
                {topicInfo.requiresCountryProof && (
                  <span
                    style={{
                      fontSize: 11,
                      fontFamily: 'monospace',
                      background: 'rgba(59,130,246,0.12)',
                      color: 'var(--accent)',
                      border: '1px solid rgba(59,130,246,0.2)',
                      padding: '2px 7px',
                      borderRadius: 4,
                    }}
                  >
                    country gated
                  </span>
                )}
              </div>
            </div>
          )}

          {/* Country proof section */}
          {needsCountryProof && !proofDone && topicInfo && (
            <div
              style={{
                padding: '24px',
                background: '#0d0d0d',
                border: '1px solid var(--border)',
                borderRadius: 14,
                marginBottom: 20,
                textAlign: 'center',
              }}
            >
              <p style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>
                Country Proof Required
              </p>
              <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 20, lineHeight: 1.5 }}>
                This topic requires proof of your country via ZKProofport.
              </p>

              <ProofGate
                circuitType="coinbase_country_attestation"
                scope={topicInfo.id}
                countryList={topicInfo.allowedCountries ?? []}
                isIncluded={true}
                mode="proof"
                qrSize={224}
                label="Scan with ZKProofport app to verify your country"
                onProofData={({ proof, publicInputs }) => {
                  setCountryProofData({ proof, publicInputs });
                  setProofDone(true);
                }}
              />
            </div>
          )}

          {needsCountryProof && proofDone && (
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
                Country proof verified
              </span>
            </div>
          )}

          {error && (
            <p
              style={{
                fontSize: 13,
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
            {joining ? 'Joining...' : needsCountryProof && !proofDone ? 'Complete verification to join' : 'Join Topic'}
          </button>

          <div style={{ textAlign: 'center', marginTop: 16 }}>
            <Link href="/topics" style={{ fontSize: 13, color: 'var(--muted)', textDecoration: 'none' }}>
              Browse all topics instead
            </Link>
          </div>
        </div>
      </div>
    </>
  );
}
