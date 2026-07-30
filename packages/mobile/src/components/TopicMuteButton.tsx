import React, { useCallback } from 'react';
import { TouchableOpacity } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Svg, { Line, Path } from 'react-native-svg';
import { useOpenStoaClient } from '../hooks/useOpenStoaClient';
import { useThemeColors } from '../theme/ThemeContext';

/**
 * Per-topic push mute (P-S) — the bell in a chat room header. Mirrors the web
 * client's `TopicMuteToggle`: reads `GET /api/topics/{topicId}/push` and writes
 * with `PATCH`.
 *
 * Renders NOTHING until the state is known (and stays hidden if the read fails,
 * e.g. for a non-member the endpoint 403s) — a bell showing "not muted" while
 * the server says muted is worse than no bell at all. The toggle is optimistic
 * via the query cache and reverts on failure, so the rendered state can never
 * disagree with the server for longer than one round trip.
 */

interface TopicPushState {
  topicId: string;
  muted: boolean;
  globalEnabled: boolean;
  willNotify: boolean;
}

export interface TopicMuteButtonProps {
  topicId: string;
  size?: number;
}

export function TopicMuteButton({ topicId, size = 20 }: TopicMuteButtonProps) {
  const client = useOpenStoaClient();
  const queryClient = useQueryClient();
  const { colors } = useThemeColors();
  const queryKey = ['push', 'topic', topicId];

  const stateQuery = useQuery<TopicPushState>({
    queryKey,
    queryFn: () => client.get<TopicPushState>(`/api/topics/${topicId}/push`),
    enabled: topicId.length > 0,
    // A non-member (403) or a transient failure must not retry-storm the header.
    retry: false,
  });

  const toggle = useMutation({
    mutationFn: (muted: boolean) =>
      client.patch<TopicPushState>(`/api/topics/${topicId}/push`, { muted }),
    onMutate: async (muted) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<TopicPushState>(queryKey);
      if (previous) {
        queryClient.setQueryData<TopicPushState>(queryKey, {
          ...previous,
          muted,
          willNotify: previous.globalEnabled && !muted,
        });
      }
      return { previous };
    },
    onError: (_e, _muted, ctx) => {
      // Revert — never leave a bell in a state the server rejected.
      if (ctx?.previous) queryClient.setQueryData<TopicPushState>(queryKey, ctx.previous);
    },
    onSuccess: (data) => {
      queryClient.setQueryData<TopicPushState>(queryKey, data);
    },
  });

  const muted = stateQuery.data?.muted;
  const onPress = useCallback(() => {
    if (muted === undefined || toggle.isPending) return;
    toggle.mutate(!muted);
  }, [muted, toggle]);

  if (muted === undefined) return null;

  const color = muted ? '#ef4444' : colors.text.secondary;
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={toggle.isPending}
      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      accessibilityRole="button"
      accessibilityState={{ selected: muted }}
      accessibilityLabel={
        muted ? 'Unmute notifications for this topic' : 'Mute notifications for this topic'
      }
      style={{ opacity: toggle.isPending ? 0.5 : 1, marginRight: 4 }}
      activeOpacity={0.7}
    >
      {muted ? (
        <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
          <Path d="M13.73 21a2 2 0 0 1-3.46 0" />
          <Path d="M18.63 13A17.89 17.89 0 0 1 18 8" />
          <Path d="M6.26 6.26A5.86 5.86 0 0 0 6 8c0 7-3 9-3 9h14" />
          <Path d="M18 8a6 6 0 0 0-9.33-5" />
          <Line x1="1" y1="1" x2="23" y2="23" />
        </Svg>
      ) : (
        <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
          <Path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <Path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </Svg>
      )}
    </TouchableOpacity>
  );
}
