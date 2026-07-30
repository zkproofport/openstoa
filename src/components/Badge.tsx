'use client';

import { useTranslation } from '@/lib/i18n/I18nProvider';

interface BadgeProps {
  type: string;
  label?: string;
  domain?: string;
  country?: string;
}

const BADGE_CONFIG: Record<string, { icon: string; color: string }> = {
  kyc: { icon: '✓', color: '#22c55e' },
  country: { icon: '🌍', color: '#3b82f6' },
  workspace: { icon: '📧', color: '#8b5cf6' },
  oidc: { icon: '✓', color: '#6366f1' },
  ai: { icon: '🤖', color: '#f59e0b' },
};

export default function Badge({ type, label: labelProp, domain, country }: BadgeProps) {
  const { t } = useTranslation();
  const config = BADGE_CONFIG[type] || { icon: '?', color: '#666' };
  const label = labelProp
    ?? (type === 'kyc' ? t('badge.kyc')
    : type === 'country' ? (country || t('badge.country'))
    : type === 'workspace' ? (domain || t('badge.workspace'))
    : type === 'oidc' ? t('badge.oidc')
    : type === 'ai' ? t('badge.ai')
    : type);

  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 3,
      // 10px was below the 12px floor for compact uppercase-style labels;
      // this badge can now render translated (Korean) fallback text too.
      fontSize: 'var(--text-label)',
      fontWeight: 600,
      padding: '2px 6px',
      borderRadius: 4,
      background: `${config.color}15`,
      border: `1px solid ${config.color}30`,
      color: config.color,
      letterSpacing: '0.02em',
    }}>
      {config.icon} {label}
    </span>
  );
}
