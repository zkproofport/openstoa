import React, { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import Feather from 'react-native-vector-icons/Feather';
import type { Poll } from '@openstoa/api-types';
import { useThemeColors } from '../theme/ThemeContext';
import type { ThemeColors } from '../theme/colors';
import { useOpenStoaClient } from '../hooks/useOpenStoaClient';
import { useOpenStoaSession } from '../stores/sessionStore';
import { useAuthGuardedAction } from '../auth';
import { useQueryClient } from '@tanstack/react-query';
import { patchPostInAllCaches } from '../utils/postCachePatch';
import { RADIUS, TYPE_SCALE } from '../theme/tokens';

export interface PollRendererProps {
  postId: string;
  poll: Poll;
  /** When true, prevents pointer events on the inner controls so the parent
   *  card's onPress handles the tap (used in compact feed mode). */
  inert?: boolean;
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    wrap: {
      marginTop: 10,
      marginBottom: 6,
      paddingVertical: 12,
      paddingHorizontal: 12,
      borderWidth: 1,
      borderColor: colors.border.default,
      borderRadius: RADIUS.card,
      backgroundColor: colors.background.secondary,
      gap: 8,
    },
    question: {
      fontSize: TYPE_SCALE.bodySmall,
      fontWeight: '600',
      color: colors.text.primary,
      marginBottom: 4,
    },
    optionRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingVertical: 8,
      paddingHorizontal: 10,
      borderWidth: 1,
      borderColor: colors.border.default,
      borderRadius: RADIUS.control,
      backgroundColor: colors.background.primary,
    },
    optionRowSelected: {
      borderColor: colors.brand.primary,
      backgroundColor: colors.brand.primaryMuted,
    },
    optionLabel: {
      flex: 1,
      fontSize: TYPE_SCALE.bodySmall,
      color: colors.text.primary,
    },
    optionCheck: {
      width: 18,
      height: 18,
      borderRadius: RADIUS.pill,
      borderWidth: 1.5,
      borderColor: colors.text.tertiary,
      alignItems: 'center',
      justifyContent: 'center',
    },
    optionCheckActive: {
      borderColor: colors.brand.primary,
      backgroundColor: colors.brand.primary,
    },
    // Result-bar variant
    resultRow: {
      paddingVertical: 8,
      paddingHorizontal: 10,
      borderRadius: RADIUS.control,
      backgroundColor: colors.background.primary,
      overflow: 'hidden',
      position: 'relative',
    },
    resultBar: {
      position: 'absolute',
      top: 0,
      bottom: 0,
      left: 0,
      backgroundColor: colors.brand.primaryMuted,
    },
    resultBarSelected: {
      backgroundColor: colors.brand.primary,
      opacity: 0.35,
    },
    resultInner: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    resultLabel: {
      flex: 1,
      fontSize: TYPE_SCALE.bodySmall,
      color: colors.text.primary,
      fontWeight: '500',
    },
    resultPct: {
      fontSize: TYPE_SCALE.label,
      color: colors.text.secondary,
      fontVariantNumeric: 'tabular-nums',
      fontWeight: '600',
    },
    resultCount: {
      fontSize: TYPE_SCALE.label,
      color: colors.text.tertiary,
      fontVariantNumeric: 'tabular-nums',
    },
    footerRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      marginTop: 4,
    },
    footerMeta: {
      fontSize: TYPE_SCALE.label,
      color: colors.text.tertiary,
      flex: 1,
    },
    voteBtn: {
      paddingVertical: 9,
      paddingHorizontal: 14,
      borderRadius: RADIUS.control,
      backgroundColor: colors.brand.primary,
      alignItems: 'center',
      justifyContent: 'center',
      marginTop: 4,
    },
    voteBtnDisabled: {
      opacity: 0.5,
    },
    voteBtnLabel: {
      color: '#FFFFFF',
      fontSize: TYPE_SCALE.bodySmall,
      fontWeight: '700',
    },
    unvoteBtn: {
      paddingVertical: 4,
      paddingHorizontal: 8,
    },
    unvoteLabel: {
      fontSize: TYPE_SCALE.label,
      color: colors.brand.primary,
      fontWeight: '600',
    },
  });
}

function formatTimeLeft(closesAtIso: string | null | undefined, t: (k: string, o?: object) => string): string {
  if (!closesAtIso) return '';
  const diff = new Date(closesAtIso).getTime() - Date.now();
  if (diff <= 0) return t('openstoa.poll.closed');
  const minutes = Math.floor(diff / 60000);
  if (minutes < 60) return t('openstoa.poll.closesInMinutes', { n: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('openstoa.poll.closesInHours', { n: hours });
  const days = Math.floor(hours / 24);
  return t('openstoa.poll.closesInDays', { n: days });
}

export function PollRenderer({ postId, poll, inert }: PollRendererProps) {
  const { t } = useTranslation();
  const { colors } = useThemeColors();
  const styles = makeStyles(colors);
  const client = useOpenStoaClient();
  const session = useOpenStoaSession();
  const queryClient = useQueryClient();

  const [pendingIds, setPendingIds] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);

  const hasVoted = poll.userVotedOptionIds.length > 0;
  const showResults = hasVoted || poll.isClosed;
  const totalVotes = poll.totalVotes;

  const togglePending = useCallback(
    (optionId: string) => {
      setPendingIds((prev) => {
        if (poll.multipleChoice) {
          return prev.includes(optionId)
            ? prev.filter((id) => id !== optionId)
            : [...prev, optionId];
        }
        return prev[0] === optionId ? [] : [optionId];
      });
    },
    [poll.multipleChoice],
  );

  const patchPoll = useCallback(
    (next: Poll | null) => {
      patchPostInAllCaches(queryClient, postId, (post) => ({ ...post, poll: next ?? undefined }));
    },
    [queryClient, postId],
  );

  const submitVote = useAuthGuardedAction(async () => {
    if (pendingIds.length === 0) return;
    setSubmitting(true);
    try {
      const res = await client.post<{ poll: Poll }>(
        `/api/posts/${postId}/poll/vote`,
        { optionIds: pendingIds },
      );
      patchPoll(res.poll);
      setPendingIds([]);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      Alert.alert(t('openstoa.poll.voteFailed'), msg);
    } finally {
      setSubmitting(false);
    }
  });

  const submitUnvote = useAuthGuardedAction(async () => {
    setSubmitting(true);
    try {
      const res = await client.delete<{ poll: Poll }>(
        `/api/posts/${postId}/poll/vote`,
      );
      patchPoll(res.poll);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      Alert.alert(t('openstoa.poll.voteFailed'), msg);
    } finally {
      setSubmitting(false);
    }
  });

  const timeLeftLabel = useMemo(() => formatTimeLeft(poll.closesAt, t), [poll.closesAt, t]);

  return (
    <View style={styles.wrap} pointerEvents={inert ? 'none' : 'auto'}>
      {poll.question ? <Text style={styles.question}>{poll.question}</Text> : null}
      {showResults
        ? poll.options.map((opt) => {
            const pct = totalVotes > 0 ? Math.round((opt.voteCount / totalVotes) * 100) : 0;
            const selectedByMe = poll.userVotedOptionIds.includes(opt.id);
            return (
              <View key={opt.id} style={styles.resultRow}>
                <View
                  style={[
                    styles.resultBar,
                    { width: `${pct}%` },
                    selectedByMe ? styles.resultBarSelected : null,
                  ]}
                />
                <View style={styles.resultInner}>
                  <Text style={styles.resultLabel} numberOfLines={2}>
                    {selectedByMe ? '✓ ' : ''}
                    {opt.text}
                  </Text>
                  <Text style={styles.resultPct}>{pct}%</Text>
                  <Text style={styles.resultCount}>{opt.voteCount}</Text>
                </View>
              </View>
            );
          })
        : poll.options.map((opt) => {
            const isSelected = pendingIds.includes(opt.id);
            return (
              <Pressable
                key={opt.id}
                style={[styles.optionRow, isSelected ? styles.optionRowSelected : null]}
                onPress={() => togglePending(opt.id)}
                disabled={submitting}
              >
                <View style={[styles.optionCheck, isSelected ? styles.optionCheckActive : null]}>
                  {isSelected ? <Feather name="check" size={11} color="#FFFFFF" /> : null}
                </View>
                <Text style={styles.optionLabel} numberOfLines={2}>
                  {opt.text}
                </Text>
              </Pressable>
            );
          })}
      <View style={styles.footerRow}>
        <Text style={styles.footerMeta}>
          {t('openstoa.poll.totalVotes', { n: totalVotes })}
          {timeLeftLabel ? ` · ${timeLeftLabel}` : ''}
          {poll.multipleChoice ? ` · ${t('openstoa.poll.multipleChoice')}` : ''}
        </Text>
        {showResults && hasVoted && !poll.isClosed ? (
          <Pressable style={styles.unvoteBtn} onPress={submitUnvote} disabled={submitting}>
            <Text style={styles.unvoteLabel}>{t('openstoa.poll.unvote')}</Text>
          </Pressable>
        ) : null}
      </View>
      {!showResults ? (
        <Pressable
          style={[
            styles.voteBtn,
            (pendingIds.length === 0 || submitting) && styles.voteBtnDisabled,
          ]}
          onPress={submitVote}
          disabled={pendingIds.length === 0 || submitting}
        >
          {submitting ? (
            <ActivityIndicator size="small" color="#FFFFFF" />
          ) : (
            <Text style={styles.voteBtnLabel}>{t('openstoa.poll.vote')}</Text>
          )}
        </Pressable>
      ) : null}
    </View>
  );
}
