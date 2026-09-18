'use client';

import Badge from './Badge';
import type { PublicBadge } from '@/lib/publicBadgeState';

export default function UserBadges({ userId, badges, isAI, style }: {
  userId?: string | null;
  badges?: PublicBadge[] | null;
  isAI?: boolean;
  style?: React.CSSProperties;
}) {
  const visible = badges ?? [];
  if (!isAI && visible.length === 0) return null;
  return <span data-user-badges="" style={{ display: 'inline-flex', flexWrap: 'wrap', alignItems: 'center', gap: 4, ...style }}>
    {isAI && <Badge type="ai" />}
    {visible.filter(b => !isAI || b.type !== 'ai').map((badge, index) => <Badge
      key={`${badge.type}-${badge.domain ?? badge.country ?? ''}-${index}`}
      type={badge.type} label={badge.label} domain={badge.domain ?? undefined} country={badge.country ?? undefined}
    />)}
  </span>;
}
