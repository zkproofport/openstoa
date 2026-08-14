import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { useThemeColors } from '../theme/ThemeContext';
import type { ThemeColors } from '../theme/colors';
import { RADIUS, TYPE_SCALE } from '../theme/tokens';
import { useOpenStoaClient } from '../hooks/useOpenStoaClient';
import { useHost } from '@openstoa/miniapp-bridge';
import { getTakSessionStore, createTakTransport } from '../crypto/mobileTransport';
import {
  chatTierOf,
  inviteHistoryEpochs,
  INVITE_HISTORY_EPOCHS_DEFAULT,
  INVITE_HISTORY_EPOCHS_MAX,
} from '../lib/chatTierPolicy';
import { buildInviteUrl, summarizeInviteHistory, type InviteArchiveRow } from '../lib/inviteLink';

/**
 * Sharing a way into a topic from the mini-app — and, for the invite-only
 * tiers, deciding how much chat history goes with it.
 *
 * The mobile invite used to share a bare CODE. That works for getting someone
 * in, and it cannot carry history at all: the epoch keys ride in a URL
 * FRAGMENT, which is the one part of a link that never reaches the server. So
 * this shares a link, and the choice of how much it carries is made here,
 * before it is sent — the same choice, in the same words, as the web dialog.
 */

export interface InviteShareModalProps {
  visible: boolean;
  onClose: () => void;
  topicId: string;
  /** Topic visibility; anything unrecognised is treated as `public`. */
  visibility?: string | null;
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    backdrop: {
      flex: 1,
      // Same scrim as InvitePromptModal — the mobile theme has no token for it.
      backgroundColor: 'rgba(0,0,0,0.5)',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 20,
    },
    card: {
      width: '100%',
      maxWidth: 380,
      backgroundColor: colors.background.primary,
      borderRadius: RADIUS.modal,
      padding: 20,
      gap: 12,
    },
    title: {
      fontSize: TYPE_SCALE.bodyLarge,
      fontWeight: '700',
      color: colors.text.primary,
    },
    label: {
      fontSize: TYPE_SCALE.bodySmall,
      fontWeight: '600',
      color: colors.text.primary,
    },
    body: {
      fontSize: TYPE_SCALE.bodySmall,
      color: colors.text.secondary,
      lineHeight: 20,
    },
    caption: {
      fontSize: TYPE_SCALE.caption,
      color: colors.text.tertiary,
      lineHeight: 18,
    },
    options: {
      gap: 8,
      maxHeight: 180,
    },
    option: {
      paddingVertical: 10,
      paddingHorizontal: 14,
      borderRadius: RADIUS.control,
      borderWidth: 1,
      borderColor: colors.border.default,
      minHeight: 44,
      justifyContent: 'center',
    },
    optionSelected: {
      borderColor: colors.brand.primary,
      backgroundColor: colors.background.secondary,
    },
    optionLabel: {
      fontSize: TYPE_SCALE.bodySmall,
      color: colors.text.primary,
    },
    actions: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      gap: 8,
      marginTop: 4,
    },
    cancelBtn: {
      minWidth: 72,
      minHeight: 44,
      paddingHorizontal: 14,
      borderRadius: RADIUS.card,
      alignItems: 'center',
      justifyContent: 'center',
    },
    cancelLabel: {
      fontSize: TYPE_SCALE.bodySmall,
      fontWeight: '600',
      color: colors.text.secondary,
    },
    shareBtn: {
      minWidth: 100,
      minHeight: 44,
      paddingHorizontal: 18,
      borderRadius: RADIUS.card,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.brand.primary,
    },
    shareBtnDisabled: { opacity: 0.5 },
    shareLabel: {
      fontSize: TYPE_SCALE.bodySmall,
      fontWeight: '700',
      color: colors.text.inverted,
    },
    error: {
      fontSize: TYPE_SCALE.bodySmall,
      color: colors.status.danger,
    },
  });
}

export function InviteShareModal({ visible, onClose, topicId, visibility }: InviteShareModalProps) {
  const { t, i18n } = useTranslation();
  const { colors } = useThemeColors();
  const styles = makeStyles(colors);
  const client = useOpenStoaClient();
  const host = useHost();

  const tier = chatTierOf(visibility, false);
  // 0 for public and DM — their history does not travel in a link, so there is
  // no control to offer rather than one that does nothing.
  const offersHistory = inviteHistoryEpochs(tier, undefined) > 0;

  const [held, setHeld] = useState<Record<number, string>>({});
  const [rows, setRows] = useState<InviteArchiveRow[]>([]);
  const [chosen, setChosen] = useState(INVITE_HISTORY_EPOCHS_DEFAULT);
  const [loading, setLoading] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) {
      setError(null);
      return;
    }
    if (!offersHistory) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      // Bounded by what this device HOLDS: a member who joined last week
      // cannot hand over the month before it.
      const tak = getTakSessionStore(client, host.secureStore, host.localStore);
      const taks = await tak
        .exportInviteHistory(topicId, INVITE_HISTORY_EPOCHS_MAX)
        .catch(() => ({} as Record<number, string>));
      const archive = await createTakTransport(client)
        .getArchive(topicId)
        .catch(() => [] as InviteArchiveRow[]);
      if (cancelled) return;
      setHeld(taks);
      setRows(archive.map((r) => ({ takVersion: r.takVersion, createdAt: r.createdAt })));
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [visible, offersHistory, topicId, client, host]);

  const heldEpochs = useMemo(
    () =>
      Object.keys(held)
        .map(Number)
        .sort((a, b) => b - a),
    [held],
  );
  const sharedEpochs = offersHistory ? heldEpochs.slice(0, chosen) : [];
  const offer = summarizeInviteHistory(rows, sharedEpochs);

  const formatDate = useCallback(
    (iso: string) => new Date(iso).toLocaleDateString(i18n.language, { month: 'long', day: 'numeric' }),
    [i18n.language],
  );

  const handleShare = useCallback(async () => {
    if (sharing) return;
    setSharing(true);
    setError(null);
    try {
      const res = await client.post<{ token: string; expiresAt: string }>(`/api/topics/${topicId}/invite`);
      const base = `${client.getBaseUrl()}/topics/join/${res.token}`;
      const taks: Record<number, string> = {};
      for (const e of sharedEpochs) taks[e] = held[e];
      const url = buildInviteUrl(base, taks, topicId);
      await Share.share({
        // The keys are IN this string, deliberately — it is the only channel
        // they travel by. Nothing here is logged; `stripInviteHistory` is what
        // any display or log of a link must go through.
        message: t('openstoa.topics.invite.shareBody', { link: url }),
        title: t('openstoa.topics.invite.shareSubject'),
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('openstoa.topics.invite.joinFailedTitle'));
    } finally {
      setSharing(false);
    }
  }, [sharing, client, topicId, sharedEpochs, held, t, onClose]);

  const historySentence = !offersHistory
    ? t('openstoa.topics.invite.historyPublic')
    : heldEpochs.length === 0
    ? t('openstoa.topics.invite.historyUnavailable')
    : chosen === 0
    ? t('openstoa.topics.invite.historyNoneSummary')
    : offer.messages === 0
    ? t('openstoa.topics.invite.historyEmptySummary', { sessions: sharedEpochs.length })
    : offer.since
    ? t('openstoa.topics.invite.historySummary', { messages: offer.messages, date: formatDate(offer.since) })
    : t('openstoa.topics.invite.historySummaryNoDate', { messages: offer.messages });

  const choices = [0, ...Array.from({ length: Math.min(heldEpochs.length, INVITE_HISTORY_EPOCHS_MAX) }, (_, i) => i + 1)];

  return (
    <Modal visible={visible} animationType="fade" transparent onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.card} onPress={() => undefined}>
          <Text style={styles.title}>{t('openstoa.topics.invite.shareTitle')}</Text>

          {offersHistory && heldEpochs.length > 0 && (
            <>
              <Text style={styles.label}>{t('openstoa.topics.invite.historyHeading')}</Text>
              <ScrollView style={styles.options} contentContainerStyle={{ gap: 8 }}>
                {choices.map((n) => (
                  <TouchableOpacity
                    key={n}
                    style={[styles.option, chosen === n && styles.optionSelected]}
                    onPress={() => setChosen(n)}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: chosen === n }}
                  >
                    <Text style={styles.optionLabel}>
                      {/* Sharing nothing is a real choice, listed first. */}
                      {n === 0
                        ? t('openstoa.topics.invite.historyNone')
                        : t('openstoa.topics.invite.historySessions', { count: n })}
                    </Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </>
          )}

          <Text style={styles.body}>
            {loading ? t('openstoa.topics.invite.historyLoading') : historySentence}
          </Text>

          {offersHistory && chosen > 0 && heldEpochs.length > 0 && (
            <Text style={styles.caption}>{t('openstoa.topics.invite.keysWarning')}</Text>
          )}

          {error && <Text style={styles.error}>{error}</Text>}

          <View style={styles.actions}>
            <TouchableOpacity style={styles.cancelBtn} onPress={onClose} activeOpacity={0.7}>
              <Text style={styles.cancelLabel}>{t('openstoa.common.cancel')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.shareBtn, (sharing || loading) && styles.shareBtnDisabled]}
              onPress={handleShare}
              disabled={sharing || loading}
              activeOpacity={0.8}
            >
              {sharing ? (
                <ActivityIndicator size="small" color={colors.text.inverted} />
              ) : (
                <Text style={styles.shareLabel}>{t('openstoa.topics.invite.shareCta')}</Text>
              )}
            </TouchableOpacity>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
