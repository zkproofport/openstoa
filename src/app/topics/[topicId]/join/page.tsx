'use client';

import { apiFetch } from '@/lib/apiFetch';
import { useState, useEffect } from 'react';
import { useParams, useSearchParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import CommunityLayout from '@/components/CommunityLayout';
import Spinner from '@/components/Spinner';
import ProofGate from '@/components/ProofGate';
import { useTranslation } from '@/lib/i18n/I18nProvider';

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
  const { t } = useTranslation();
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
        const res = await apiFetch(`/api/topics/join/${inviteCode}`);
        if (!res.ok) throw new Error(t('joinPage.inviteInvalid'));
        const data = await res.json();
        info = { ...data.topic, isMember: data.isMember, memberCount: data.topic.memberCount ?? 0 };
      } else {
        const res = await apiFetch(`/api/topics/${topicId}`);
        if (!res.ok) throw new Error(t('joinPage.topicNotFound'));
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
      setError(err instanceof Error ? err.message : t('joinPage.loadFailed'));
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

      const res = await apiFetch(`/api/topics/${topicInfo.id}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? t('joinPage.joinFailed'));
      }
      router.push(`/topics/${topicInfo.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('editTopicPage.unknownError'));
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
          <p style={{ color: 'var(--color-status-danger)', fontFamily: 'var(--font-mono)', fontSize: 'var(--text-body-sm)', marginBottom: 'var(--space-4)' }}>
            {error}
          </p>
        </div>
      </CommunityLayout>
    );
  }

  const proofBadgeKey =
    effectiveProofType === 'kyc' ? 'kyc' :
    effectiveProofType === 'country' ? 'country' :
    effectiveProofType === 'google_workspace' ? 'googleWorkspace' :
    effectiveProofType === 'microsoft_365' ? 'microsoft365' :
    effectiveProofType === 'workspace' ? 'workspace' :
    'generic';
  const domainSuffix = topicInfo?.requiredDomain ? ` (${topicInfo.requiredDomain})` : '';

  return (
    <CommunityLayout isGuest={false} sessionChecked={true}>
      {/* 73px = standalone Header height convention (see recovery/page.tsx); 1.5rem = space-5. */}
      <div
        style={{
          minHeight: 'calc(100vh - 73px)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '40px var(--space-5)',
        }}
      >
        <div style={{ width: '100%', maxWidth: 460 }}>
          {/* Topic card */}
          {topicInfo && (
            <div
              style={{
                padding: 'var(--space-5)',
                background: 'var(--color-bg-secondary)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-card)',
                marginBottom: 28,
              }}
            >
              <p style={{ fontSize: 'var(--text-body)', color: 'var(--muted)', fontFamily: 'var(--font-mono)', margin: '0 0 var(--space-2)' }}>
                {t('joinPage.invitedTo')}
              </p>
              <h1 style={{ fontSize: 26, fontWeight: 800, letterSpacing: '-0.03em', margin: '0 0 var(--space-2)' }}>
                {topicInfo.title}
              </h1>
              {topicInfo.description && (
                <p style={{ fontSize: 'var(--text-body-sm)', color: 'var(--muted)', margin: '0 0 var(--space-3)', lineHeight: 1.6 }}>
                  {topicInfo.description}
                </p>
              )}
              <div className="flex items-center gap-3 flex-wrap">
                <span
                  style={{
                    fontSize: 'var(--text-body-sm)',
                    fontFamily: 'var(--font-mono)',
                    color: 'var(--muted)',
                  }}
                >
                  {topicInfo.memberCount} {topicInfo.memberCount === 1 ? t('rightSidebar.member') : t('rightSidebar.members')}
                </span>
                {effectiveProofType !== 'none' && (
                  <span
                    style={{
                      fontSize: 'var(--text-body)',
                      fontFamily: 'var(--font-mono)',
                      background: 'var(--color-brand-primary-muted)',
                      color: 'var(--accent)',
                      border: '1px solid color-mix(in srgb, var(--color-brand-primary) 20%, transparent)',
                      padding: '2px 7px',
                      borderRadius: 4,
                    }}
                  >
                    {t(`joinPage.proofBadge.${proofBadgeKey}`)}
                  </span>
                )}
              </div>
            </div>
          )}

          {/* Proof section */}
          {needsProof && !proofDone && topicInfo && (
            <div
              style={{
                padding: 'var(--space-5)',
                background: 'var(--color-bg-secondary)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-card)',
                marginBottom: 20,
                textAlign: 'center',
              }}
            >
              <p style={{ fontSize: 'var(--text-body-sm)', fontWeight: 600, marginBottom: 6 }}>
                {t(`joinPage.proofTitle.${proofBadgeKey}`)}
              </p>
              <p style={{ fontSize: 'var(--text-body)', color: 'var(--muted)', marginBottom: 20, lineHeight: 1.5 }}>
                {effectiveProofType === 'google_workspace'
                  ? t('joinPage.proofBody.googleWorkspace', { domainSuffix })
                  : effectiveProofType === 'microsoft_365'
                  ? t('joinPage.proofBody.microsoft365', { domainSuffix })
                  : effectiveProofType === 'workspace'
                  ? t('joinPage.proofBody.workspace', { domainSuffix })
                  : t(`joinPage.proofBody.${proofBadgeKey}`)}
              </p>

              {/* Provider chooser for workspace (either) topics */}
              {effectiveProofType === 'workspace' && (
                <div style={{ marginBottom: 'var(--space-4)' }}>
                  <p style={{ fontSize: 'var(--text-body-sm)', color: 'var(--muted)', marginBottom: 'var(--space-2)' }}>
                    {t('joinPage.verifyWith')}
                  </p>
                  <div style={{ display: 'flex', gap: 'var(--space-3)', justifyContent: 'center' }}>
                    {([
                      { value: 'google' as const, label: t('joinPage.providerGoogle') },
                      { value: 'microsoft' as const, label: t('joinPage.providerMicrosoft') },
                    ]).map((opt) => (
                      <label key={opt.value} style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 'var(--space-2)',
                        padding: '8px 14px',
                        background: joinProvider === opt.value ? 'color-mix(in srgb, var(--color-brand-primary) 6%, transparent)' : 'var(--color-bg-secondary)',
                        border: `1px solid ${joinProvider === opt.value ? 'color-mix(in srgb, var(--color-brand-primary) 30%, transparent)' : 'var(--border)'}`,
                        borderRadius: 'var(--radius-control)',
                        cursor: 'pointer',
                        transition: 'all 0.12s',
                        fontSize: 'var(--text-body-sm)',
                        minHeight: 'var(--touch-target-min)',
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
                    effectiveProofType === 'kyc' ? t('joinPage.scan.kyc') :
                    effectiveProofType === 'country' ? t('joinPage.scan.country') :
                    effectiveProofType === 'workspace' ? t('joinPage.scan.workspace', { provider: joinProvider === 'microsoft' ? t('joinPage.providerMicrosoft') : t('joinPage.providerGoogle') }) :
                    t('joinPage.scan.default')
                  }
                  onProofData={({ proof, publicInputs }) => {
                    setProofData({ proof, publicInputs });
                    setProofDone(true);
                  }}
                />
              )}
              {effectiveProofType === 'workspace' && !joinProvider && (
                <p style={{ fontSize: 'var(--text-body-sm)', color: 'var(--muted)', textAlign: 'center', margin: '16px 0 0' }}>
                  {t('joinPage.selectProviderHint')}
                </p>
              )}
            </div>
          )}

          {needsProof && proofDone && (
            <div
              style={{
                padding: '14px 18px',
                background: 'color-mix(in srgb, var(--color-brand-accent) 8%, transparent)',
                border: '1px solid color-mix(in srgb, var(--color-brand-accent) 25%, transparent)',
                borderRadius: 'var(--radius-card)',
                marginBottom: 20,
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--space-2)',
              }}
            >
              <span style={{ color: 'var(--color-brand-accent)', fontSize: 18 }}>✓</span>
              <span style={{ fontSize: 'var(--text-body-sm)', color: 'var(--color-brand-accent)', fontWeight: 500 }}>
                {t('joinPage.verificationComplete')}
              </span>
            </div>
          )}

          {/* Privacy notice for proof-gated topics */}
          {needsProof && (
            <div
              style={{
                padding: 'var(--space-3) var(--space-4)',
                background: 'color-mix(in srgb, var(--color-brand-primary) 5%, transparent)',
                border: '1px solid color-mix(in srgb, var(--color-brand-primary) 15%, transparent)',
                borderRadius: 'var(--radius-control)',
                marginBottom: 'var(--space-4)',
                fontSize: 'var(--text-caption)',
                color: 'var(--muted)',
                lineHeight: 1.5,
              }}
            >
              <span style={{ fontWeight: 600, color: 'var(--foreground)' }}>{t('joinPage.privacyLabel')}</span>{' '}
              {t('joinPage.privacyBody')}
            </div>
          )}

          {error && (
            <p
              style={{
                fontSize: 'var(--text-body)',
                color: 'var(--color-status-danger)',
                fontFamily: 'var(--font-mono)',
                background: 'color-mix(in srgb, var(--color-status-danger) 8%, transparent)',
                border: '1px solid color-mix(in srgb, var(--color-status-danger) 20%, transparent)',
                borderRadius: 'var(--radius-control)',
                padding: 'var(--space-2) var(--space-3)',
                marginBottom: 'var(--space-4)',
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
              color: canJoin ? 'var(--color-text-inverted)' : 'var(--muted)',
              border: 'none',
              borderRadius: 'var(--radius-card)',
              padding: '14px',
              fontSize: 'var(--text-body)',
              fontWeight: 600,
              cursor: canJoin ? 'pointer' : 'not-allowed',
              transition: 'all 0.15s',
              letterSpacing: '-0.01em',
              minHeight: 'var(--touch-target-min)',
            }}
          >
            {joining ? t('joinPage.joining') : needsProof && !proofDone ? t('joinPage.completeVerificationToJoin') : t('joinPage.joinTopic')}
          </button>

          <div style={{ textAlign: 'center', marginTop: 'var(--space-4)' }}>
            <Link href="/topics" style={{ fontSize: 'var(--text-body)', color: 'var(--muted)', textDecoration: 'none' }}>
              {t('joinPage.browseAllTopics')}
            </Link>
          </div>
        </div>
      </div>
    </CommunityLayout>
  );
}
