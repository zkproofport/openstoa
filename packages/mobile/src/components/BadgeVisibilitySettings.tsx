import React, { useEffect, useMemo } from 'react';
import { ActivityIndicator, Text, TouchableOpacity, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useHost } from '@openstoa/miniapp-bridge';
import { updateIdentityBadgeCaches } from '../lib/identityBadges';
import { useOpenStoaSession } from '../stores/sessionStore';
import { topicKeys, sessionKeys, type PublicBadge, type VerificationBadge } from '@openstoa/api-types';
import { useOpenStoaClient } from '../hooks/useOpenStoaClient';
import { useOpenStoaMutation } from '../hooks/useOpenStoaMutation';
import { reportFailure } from '../api/failure';
import { useThemeColors } from '../theme/ThemeContext';
import { RADIUS, TOUCH_TARGET_MIN, TYPE_SCALE } from '../theme/tokens';

const BADGES_KEY = ['profile', 'badges'] as const;
type BadgeResponse = { userId: string; publicBadges: PublicBadge[]; badges: VerificationBadge[] };

/** Owner controls include hidden verifications; public chips are a separate view. */
export function BadgeVisibilitySettings() {
  const { t } = useTranslation();
  const { colors } = useThemeColors();
  const client = useOpenStoaClient();
  const host = useHost();
  const queryClient = useQueryClient();
  const accountId = useOpenStoaSession(state => state.userId);
  const accountKey = useMemo(() => [...BADGES_KEY, accountId], [accountId]);
  const query = useQuery({
    queryKey: accountKey,
    enabled: !!accountId,
    queryFn: async ({ signal }) => {
      const result = await client.get<BadgeResponse>('/api/profile/badges', { signal });
      if (result.userId !== accountId || useOpenStoaSession.getState().userId !== accountId) throw new Error('Account changed');
      return result;
    },
  });
  // No cache writes inside queryFn: a canceled, delayed response must have no
  // side effects after the owner confirms a newer visibility preference.
  useEffect(() => {
    if (!accountId || query.data?.userId !== accountId || !query.data.publicBadges) return;
    if (useOpenStoaSession.getState().userId !== accountId) return;
    updateIdentityBadgeCaches(queryClient, accountId, query.data.publicBadges);
  }, [query.data, queryClient, accountId]);
  const mutation = useOpenStoaMutation({
    mutationFn: (change: Pick<VerificationBadge, 'type' | 'visible'> & { accountId: string }) => {
      if (useOpenStoaSession.getState().userId !== change.accountId) throw new Error('Account changed');
      return client.patch<{
        success: boolean;
        userId: string;
        publicBadges: PublicBadge[];
        type: VerificationBadge['type'];
        visible: boolean;
      }>('/api/profile/badges', { type: change.type, visible: change.visible });
    },
    onMutate: async () => {
      await Promise.all([
        queryClient.cancelQueries({ queryKey: BADGES_KEY }),
        queryClient.cancelQueries({ queryKey: sessionKeys.current() }),
      ]);
    },
    onSuccess: async (result, change) => {
      const accountId = change.accountId;
      if (!accountId || result.userId !== accountId || useOpenStoaSession.getState().userId !== accountId) return;
      await Promise.all([
        queryClient.cancelQueries({ queryKey: BADGES_KEY }),
        queryClient.cancelQueries({ queryKey: sessionKeys.current() }),
      ]);
      // Cancel completion itself is async; the account could change while waiting.
      if (useOpenStoaSession.getState().userId !== accountId) return;
      updateIdentityBadgeCaches(queryClient, accountId, result.publicBadges);
      queryClient.setQueryData<BadgeResponse>([...BADGES_KEY, accountId], previous => previous ? {
        ...previous,
        ...(result.userId && result.publicBadges ? { userId: result.userId, publicBadges: result.publicBadges } : {}),
        badges: previous.badges.map(badge => badge.type === result.type ? { ...badge, visible: result.visible } : badge),
      } : previous);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: BADGES_KEY }),
        queryClient.invalidateQueries({
          queryKey: ['profile', 'domain-badge'],
        }),
        queryClient.invalidateQueries({ queryKey: ['feed'] }),
        queryClient.invalidateQueries({ queryKey: ['my'] }),
        queryClient.invalidateQueries({ queryKey: topicKeys.all() }),
        queryClient.invalidateQueries({ queryKey: topicKeys.chatAll() }),
        ...['session', 'post', 'post-records', 'dm-list', 'dm-candidates'].map(key => queryClient.invalidateQueries({ queryKey: [key] })),
      ]);
    },
    onError: (error, change) => {
      if (useOpenStoaSession.getState().userId === change.accountId) reportFailure(host, error, 'E9004', t);
    },
  });

  return (
    <View
      style={{
        backgroundColor: colors.background.primary,
        padding: 16,
        marginTop: 8,
      }}
    >
      <Text
        style={{
          color: colors.text.primary,
          fontSize: TYPE_SCALE.body,
          fontWeight: '600',
        }}
      >
        {t('openstoa.profile.badges')}
      </Text>
      <Text
        style={{
          color: colors.text.secondary,
          fontSize: TYPE_SCALE.bodySmall,
          marginVertical: 8,
        }}
      >
        {t('openstoa.profile.badgeVisibility.description')}
      </Text>
      {query.isPending ? (
        <ActivityIndicator color={colors.brand.primary} />
      ) : query.isError ? (
        <View>
          <Text style={{ color: colors.status.danger }}>
            {t('openstoa.profile.badgeVisibility.loadFailed')}
          </Text>
          <TouchableOpacity
            onPress={() => void query.refetch()}
            style={{ minHeight: TOUCH_TARGET_MIN, justifyContent: 'center' }}
          >
            <Text style={{ color: colors.brand.primary }}>
              {t('openstoa.common.retry')}
            </Text>
          </TouchableOpacity>
        </View>
      ) : query.data?.badges.length ? (
        query.data.badges.map((badge) => {
          const label = t(
            `openstoa.profile.badgeVisibility.types.${badge.type}`,
          );
          const busy = mutation.isPending;
          return (
            <View
              key={badge.type}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 12,
                paddingVertical: 8,
              }}
            >
              <View style={{ flex: 1 }}>
                <Text
                  style={{
                    color: colors.text.primary,
                    fontSize: TYPE_SCALE.bodySmall,
                  }}
                >
                  {label}
                </Text>
                {badge.domain ? (
                  <Text
                    style={{
                      color: colors.text.secondary,
                      fontSize: TYPE_SCALE.caption,
                    }}
                  >
                    {badge.domain}
                  </Text>
                ) : null}
              </View>
              <TouchableOpacity
                accessibilityRole="switch"
                accessibilityState={{ checked: badge.visible, disabled: busy }}
                accessibilityLabel={t(
                  `openstoa.profile.badgeVisibility.${badge.visible ? 'hideLabel' : 'showLabel'}`,
                  { badge: label },
                )}
                disabled={busy}
                onPress={() =>
                  accountId && mutation.mutate({ type: badge.type, visible: !badge.visible, accountId })
                }
                style={{
                  minHeight: TOUCH_TARGET_MIN,
                  minWidth: 72,
                  justifyContent: 'center',
                  alignItems: 'center',
                  paddingHorizontal: 12,
                  borderRadius: RADIUS.control,
                  backgroundColor: badge.visible
                    ? colors.brand.primaryMuted
                    : colors.background.secondary,
                  opacity: busy ? 0.5 : 1,
                }}
              >
                <Text
                  style={{
                    color: badge.visible
                      ? colors.brand.primary
                      : colors.text.secondary,
                  }}
                >
                  {t(
                    `openstoa.profile.badgeVisibility.${badge.visible ? 'visible' : 'hidden'}`,
                  )}
                </Text>
              </TouchableOpacity>
            </View>
          );
        })
      ) : (
        <Text style={{ color: colors.text.secondary }}>
          {t('openstoa.profile.badgeVisibility.empty')}
        </Text>
      )}
    </View>
  );
}
