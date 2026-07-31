'use client';

/**
 * Shared topic-room member list treatment — extracted from `ChatRail.tsx`
 * (its former inline `MembersList`) so the popped-out `/chat/[topicId]` page
 * (`src/app/chat/[topicId]/page.tsx`) can offer the exact same members
 * affordance instead of a second bespoke one. Both call sites render this
 * as an OVERLAY over a still-mounted `ChatPanel` rather than replacing it —
 * swapping the panel out would drop the SSE stream and re-run the initial
 * history fetch on every peek at the member list.
 */
import UserCard from './UserCard';
import Avatar from './Avatar';
import Spinner from './Spinner';
import { useTranslation } from '@/lib/i18n/I18nProvider';

export interface TopicMember {
  userId: string;
  nickname: string;
  role: 'owner' | 'admin' | 'member';
  profileImage?: string | null;
  badges?: Array<{ type: string; label: string; domain?: string; country?: string }>;
}

const emptyStateStyle: React.CSSProperties = {
  padding: '32px var(--space-5)',
  textAlign: 'center',
  fontSize: 'var(--text-caption)',
  color: 'var(--muted)',
  lineHeight: 1.6,
};

const memberRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  width: '100%',
  padding: '10px var(--space-4)',
  borderBottom: '1px solid var(--border)',
  minHeight: 'var(--touch-target-min)',
};

export default function TopicMembersList({
  members,
  failed,
  onRetry,
  viewerUserId,
}: {
  members: TopicMember[] | null;
  failed: boolean;
  onRetry: () => void;
  viewerUserId: string | null;
}) {
  const { t } = useTranslation();
  if (members === null && !failed) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: '28px 0' }}>
        <Spinner />
      </div>
    );
  }
  if (failed) {
    return (
      <div style={{ padding: '28px var(--space-5)', textAlign: 'center', color: 'var(--muted)', fontSize: 'var(--text-caption)', lineHeight: 1.6 }}>
        <p style={{ margin: '0 0 12px 0' }}>{t('chatRail.membersLoadError')}</p>
        <button
          type="button"
          onClick={onRetry}
          style={{
            background: 'none',
            border: '1px solid var(--color-border-default)',
            borderRadius: 'var(--radius-pill)',
            padding: '6px var(--space-4)',
            color: 'var(--foreground)',
            fontSize: 'var(--text-caption)',
            cursor: 'pointer',
            minHeight: 'var(--touch-target-min)',
          }}
        >
          {t('chatRail.tryAgain')}
        </button>
      </div>
    );
  }
  if (!members || members.length === 0) {
    return (
      <div style={emptyStateStyle}>
        <p style={{ margin: 0 }}>{t('chatRail.noMembersFound')}</p>
      </div>
    );
  }
  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
      {members.map((m) => (
        <div key={m.userId} style={memberRowStyle} data-testid="rail-member-row">
          <UserCard userId={m.userId} nickname={m.nickname} profileImage={m.profileImage} badges={m.badges} viewerUserId={viewerUserId}>
            <Avatar src={m.profileImage} name={m.nickname} size={32} />
          </UserCard>
          <span
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: 'var(--text-caption)',
              fontWeight: 600,
              color: 'var(--foreground)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {m.nickname}
          </span>
          {m.role !== 'member' && (
            <span
              style={{
                fontSize: 'var(--text-label)',
                fontFamily: 'var(--font-mono)',
                textTransform: 'uppercase',
                letterSpacing: '0.04em',
                color: 'var(--muted)',
                flexShrink: 0,
              }}
            >
              {t(`chatRail.roles.${m.role}`)}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
