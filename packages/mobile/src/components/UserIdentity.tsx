import React, { useCallback, useSyncExternalStore } from 'react';
import { Text, View, type StyleProp, type TextStyle } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import type { PublicBadge } from '@openstoa/api-types';
import { identityBadgesKey } from '../lib/identityBadges';
export { identityBadgesKey } from '../lib/identityBadges';
import { useThemeColors } from '../theme/ThemeContext';
import { RADIUS, TYPE_SCALE } from '../theme/tokens';
import { GatedImage } from './GatedImage';
import { initialFor, type PeerProfileTarget } from '../lib/peerProfile';

/** A confirmed visibility change supersedes already-mounted identity snapshots.
 * Subscribe to cached data only: identity rows never create/refetch queries. */
const NO_BADGES: PublicBadge[] = [];
export function usePublicBadges(userId: string, badges?: PublicBadge[]) {
  const queryClient = useQueryClient();
  const subscribe = useCallback((notify: () => void) => queryClient.getQueryCache().subscribe(notify), [queryClient]);
  const snapshot = useCallback(() => {
    const current = queryClient.getQueryState<PublicBadge[]>(identityBadgesKey(userId));
    // Explicit server payloads always win, including [] after another device's
    // OFF or verification expiry. The snapshot only fills missing legacy data.
    return badges ?? current?.data ?? NO_BADGES;
  }, [queryClient, userId, badges]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export function VerificationBadges({ badges }: { badges: PublicBadge[] }) {
  const { t } = useTranslation();
  const { colors } = useThemeColors();
  const types: Record<string, string> = { kyc: 'kyc', country: 'country', workspace: 'oidc_domain', oidc_domain: 'oidc_domain', oidc: 'oidc_login', oidc_login: 'oidc_login' };
  return <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4 }}>
    {badges.map((badge, index) => <View key={`${badge.type}-${badge.domain ?? ''}-${index}`} style={{ backgroundColor: colors.brand.primaryMuted, borderRadius: RADIUS.pill, paddingHorizontal: 7, paddingVertical: 3 }}>
      <Text style={{ color: colors.brand.primary, fontSize: TYPE_SCALE.label, fontWeight: '600' }}>
        {badge.domain || (types[badge.type] ? t(`openstoa.profile.badgeVisibility.types.${types[badge.type]}`) : badge.label)}
      </Text>
    </View>)}
  </View>;
}

/** Every identity surface uses the server's visible-only badges, including OIDC.
 * Surrounding screens own navigation/actions; this module owns avatar/name/badges. */
export function UserIdentity({ identity, size = 32, vertical = false, children, nameStyle }: {
  identity: PeerProfileTarget;
  size?: number;
  vertical?: boolean;
  children?: React.ReactNode;
  nameStyle?: StyleProp<TextStyle>;
}) {
  const { colors } = useThemeColors();
  const badges = usePublicBadges(identity.userId, identity.badges);
  return <View style={{ flexDirection: vertical ? 'column' : 'row', alignItems: vertical ? 'center' : 'flex-start', gap: 8, flexShrink: 1, minWidth: 0 }}>
    {size > 0 && <View style={{ width: size, height: size, borderRadius: RADIUS.pill, overflow: 'hidden', backgroundColor: colors.brand.primaryMuted, alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
      {identity.profileImage ? <GatedImage uri={identity.profileImage} style={{ width: size, height: size }} /> : <Text style={{ fontSize: size * 0.42, fontWeight: '700', color: colors.brand.primary }}>{initialFor(identity.nickname)}</Text>}
    </View>}
    <View style={{ flexShrink: 1, minWidth: 0, gap: 4, alignItems: vertical ? 'center' : 'flex-start' }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
        <Text style={[{ color: colors.text.primary, fontSize: TYPE_SCALE.bodySmall, fontWeight: '600', flexShrink: 1 }, nameStyle]} numberOfLines={1}>{identity.nickname}</Text>
        {identity.isAI && <Text style={{ color: colors.brand.primary, fontSize: TYPE_SCALE.label, fontWeight: '700' }}>AI</Text>}
      </View>
      {badges.length > 0 && <VerificationBadges badges={badges} />}
      {children}
    </View>
  </View>;
}
