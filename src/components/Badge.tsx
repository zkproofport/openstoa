'use client';

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
};

export default function Badge({ type, label: labelProp, domain, country }: BadgeProps) {
  const config = BADGE_CONFIG[type] || { icon: '?', color: '#666' };
  const label = labelProp
    ?? (type === 'kyc' ? 'KYC'
    : type === 'country' ? (country || 'Country')
    : type === 'workspace' ? (domain || 'Org Verified')
    : type === 'oidc' ? 'OIDC Verified'
    : type);

  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 3,
      fontSize: 10,
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
