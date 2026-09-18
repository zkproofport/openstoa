'use client';

import Avatar from './Avatar';
import UserCard from './UserCard';
import UserBadges from './UserBadges';
import { useTranslation } from '@/lib/i18n/I18nProvider';
import type { PublicBadge } from '@/lib/publicBadgeState';

/** One person row. Public badges come from its parent response, never a row fetch. */
export default function UserIdentity({
  userId, nickname, profileImage, badges, isAI, viewerUserId,
  avatarSize = 32, showAvatar = true, showName = true, interactive = true,
  onAvatarClick, avatarStyle, nameStyle, style, className, children,
  nameTestId, nameAs: Name = 'span', layout = 'row',
}: {
  userId?: string | null;
  nickname: string;
  profileImage?: string | null;
  badges?: PublicBadge[] | null;
  isAI?: boolean;
  viewerUserId?: string | null;
  avatarSize?: number;
  showAvatar?: boolean;
  showName?: boolean;
  interactive?: boolean;
  onAvatarClick?: () => void;
  avatarStyle?: React.CSSProperties;
  nameStyle?: React.CSSProperties;
  style?: React.CSSProperties;
  className?: string;
  children?: React.ReactNode;
  nameTestId?: string;
  nameAs?: 'span' | 'h1';
  layout?: 'row' | 'column';
}) {
  const { t } = useTranslation();
  const publicUserId = userId && !userId.startsWith('withdrawn:') ? userId : undefined;
  const avatar = <Avatar src={profileImage} name={nickname} size={avatarSize} style={avatarStyle} />;
  const Root = Name === 'h1' ? 'div' : 'span';
  const Content = Name === 'h1' ? 'div' : 'span';
  const name = <Name data-testid={nameTestId} style={{ margin: 0, fontSize: 'inherit', fontWeight: 600, overflowWrap: 'anywhere', minWidth: 0, ...nameStyle }}>{nickname}</Name>;
  return <Root className={className} data-user-identity={publicUserId ?? ''} style={{
    display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0,
    flexDirection: layout, ...style,
  }}>
    {showAvatar && (onAvatarClick ? <span role="button" tabIndex={0} aria-label={t('webUi.viewProfileImage', { nickname })}
      onClick={onAvatarClick} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onAvatarClick(); } }}
      style={{ display: 'inline-flex', cursor: 'pointer' }}
    >{avatar}</span> : publicUserId && interactive ? <UserCard
      userId={publicUserId!} nickname={nickname} profileImage={profileImage} badges={badges ?? undefined} viewerUserId={viewerUserId}
    >{avatar}</UserCard> : avatar)}
    <Content style={{ display: 'inline-flex', flexDirection: 'column', minWidth: 0, gap: 2, alignItems: layout === 'column' ? 'center' : undefined }}>
      <Content style={{ display: 'inline-flex', alignItems: 'center', flexWrap: 'wrap', gap: 6, minWidth: 0, justifyContent: layout === 'column' ? 'center' : undefined }}>
        {showName && (interactive && publicUserId ? <UserCard userId={publicUserId!} nickname={nickname} profileImage={profileImage} badges={badges ?? undefined} viewerUserId={viewerUserId}>{name}</UserCard> : name)}
        <UserBadges userId={publicUserId} badges={publicUserId ? badges : []} isAI={!!publicUserId && isAI} />
      </Content>
      {children}
    </Content>
  </Root>;
}
