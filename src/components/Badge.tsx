'use client';

import { useTranslation } from '@/lib/i18n/I18nProvider';

interface BadgeProps {
  type: string;
  label?: string;
  domain?: string;
  country?: string;
}

/**
 * Three tones, not five colors. Every proof badge asserts the same thing —
 * "this claim was verified" — so they share one treatment instead of each
 * type inventing its own hue (the old palette used four off-token colors
 * that no theme defines, so light mode rendered them unreadably).
 *
 *   verified — a verified claim (KYC, country, workspace, OIDC)
 *   onchain  — an on-chain record; the quietest chip on the surface
 *   neutral  — descriptive, not a claim (AI author)
 */
type BadgeTone = 'verified' | 'onchain' | 'neutral';

const BADGE_TONE: Record<string, BadgeTone> = {
  kyc: 'verified',
  country: 'verified',
  workspace: 'verified',
  oidc: 'verified',
  onchain: 'onchain',
  ai: 'neutral',
};

const TONE_STYLE: Record<BadgeTone, React.CSSProperties> = {
  verified: {
    color: 'var(--color-brand-accent)',
    border: '1px solid var(--color-brand-accent)',
  },
  onchain: {
    color: 'var(--color-text-tertiary)',
    border: '1px solid var(--color-border-default)',
  },
  neutral: {
    color: 'var(--color-text-secondary)',
    border: '1px solid var(--color-border-default)',
  },
};

export default function Badge({ type, label: labelProp, domain, country }: BadgeProps) {
  const { t } = useTranslation();
  const tone = BADGE_TONE[type] ?? 'neutral';
  // Replace the server's canonical labels in the viewer's language, while
  // retaining intentionally customized labels supplied by the caller.
  const apiLabels: Record<string, string> = { kyc: 'KYC', country: 'Country', workspace: 'Org', oidc: 'OIDC' };
  const customLabel = labelProp && labelProp !== apiLabels[type] ? labelProp : undefined;
  const labels: Record<string, string> = {
    kyc: t('badge.kyc'),
    country: country || t('badge.country'),
    workspace: domain || t('badge.workspace'),
    oidc: t('badge.oidc'),
    ai: t('badge.ai'),
    onchain: type,
  };
  const label = customLabel ?? labels[type] ?? labelProp ?? type;

  return (
    <span
      data-badge-type={type}
      data-badge-tone={tone}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 3,
        // 10px was below the 12px floor for compact uppercase-style labels;
        // this badge can now render translated (Korean) fallback text too.
        fontSize: 'var(--text-label)',
        fontWeight: 600,
        padding: '2px 6px',
        borderRadius: 'var(--radius-control)',
        background: 'transparent',
        ...TONE_STYLE[tone],
      }}
    >
      {tone === 'verified' && <span aria-hidden="true">✓</span>}
      {label}
    </span>
  );
}
