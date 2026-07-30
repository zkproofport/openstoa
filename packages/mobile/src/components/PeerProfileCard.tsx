import React from 'react';
import {
  ActivityIndicator,
  Image,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  TouchableWithoutFeedback,
  View,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { useThemeColors } from '../theme/ThemeContext';
import type { ThemeColors } from '../theme/colors';
import { canDm, dmUnavailableReason, initialFor, type PeerProfileTarget } from '../lib/peerProfile';

export interface PeerProfileCardProps {
  /** The tapped member/author, or null to render nothing (mirrors the
   * `ImageViewerModal` pattern already used in ChatRoomScreen). */
  target: PeerProfileTarget | null;
  /** Signed-in viewer's own user id — drives DM-button self-exclusion. */
  viewerUserId: string | null;
  onClose: () => void;
  onMessage: (target: PeerProfileTarget) => void;
  /** True while the start-DM mutation is in flight, so a double tap can't
   * fire two `POST /api/dm` calls or navigate twice. */
  messagePending?: boolean;
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    backdrop: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.5)',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 24,
    },
    card: {
      width: '100%',
      maxWidth: 360,
      maxHeight: '80%',
      backgroundColor: colors.background.primary,
      borderRadius: 20,
      paddingHorizontal: 20,
      paddingTop: 28,
      paddingBottom: 20,
      alignItems: 'center',
    },
    avatar: {
      width: 76,
      height: 76,
      borderRadius: 38,
      backgroundColor: colors.brand.primaryMuted,
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: 12,
    },
    avatarImage: {
      width: 76,
      height: 76,
      borderRadius: 38,
      backgroundColor: colors.background.tertiary,
    },
    avatarInitial: {
      fontSize: 30,
      fontWeight: '700',
      color: colors.brand.primary,
    },
    nameRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      maxWidth: '100%',
    },
    nickname: {
      fontSize: 19,
      fontWeight: '700',
      color: colors.text.primary,
      flexShrink: 1,
    },
    aiBadge: {
      fontSize: 10,
      fontWeight: '700',
      color: colors.background.primary,
      backgroundColor: colors.brand.primary,
      overflow: 'hidden',
      borderRadius: 4,
      paddingHorizontal: 5,
      paddingVertical: 2,
      marginLeft: 6,
    },
    badgeScroll: {
      marginTop: 12,
      maxWidth: '100%',
    },
    badgeRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      justifyContent: 'center',
      gap: 6,
      marginTop: 12,
    },
    badgeChip: {
      backgroundColor: colors.brand.primaryMuted,
      borderRadius: 20,
      paddingHorizontal: 12,
      paddingVertical: 5,
    },
    badgeLabel: {
      fontSize: 12,
      fontWeight: '600',
      color: colors.brand.primary,
    },
    note: {
      marginTop: 12,
      fontSize: 12,
      lineHeight: 17,
      color: colors.text.tertiary,
      textAlign: 'center',
    },
    messageButton: {
      marginTop: 20,
      alignSelf: 'stretch',
      paddingVertical: 12,
      borderRadius: 24,
      backgroundColor: colors.brand.primary,
      alignItems: 'center',
      justifyContent: 'center',
    },
    messageButtonDisabled: {
      opacity: 0.6,
    },
    messageButtonText: {
      color: '#FFFFFF',
      fontSize: 15,
      fontWeight: '600',
    },
    closeButton: {
      marginTop: 12,
      paddingVertical: 8,
    },
    closeButtonText: {
      color: colors.text.tertiary,
      fontSize: 13,
      fontWeight: '600',
    },
  });
}

/**
 * Peer profile card — opened by tapping a member's avatar/name in
 * TopicMembersScreen and a message author's name in ChatRoomScreen.
 *
 * Renders nothing when `target` is null (same "controlled by parent state"
 * pattern as `ImageViewerModal`), so every call site owns a single
 * `useState<PeerProfileTarget | null>(null)` rather than this component
 * managing its own visibility.
 */
export function PeerProfileCard({
  target,
  viewerUserId,
  onClose,
  onMessage,
  messagePending,
}: PeerProfileCardProps) {
  const { t } = useTranslation();
  const { colors } = useThemeColors();
  const styles = makeStyles(colors);

  if (!target) return null;

  const showDm = canDm(viewerUserId, target);
  const badges = target.badges ?? [];
  // Three honest end-states, not one blank box: self, no badges, and
  // not-DM-able are independent facts that can combine (your own card is
  // `self` + usually also no badges) — each gets its own line instead of
  // being collapsed into a generic empty area where the DM button isn't.
  const unavailable = dmUnavailableReason(viewerUserId, target);

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <TouchableWithoutFeedback onPress={onClose}>
        <View style={styles.backdrop}>
          <TouchableWithoutFeedback>
            <View style={styles.card}>
              <View style={styles.avatar}>
                {target.profileImage ? (
                  <Image source={{ uri: target.profileImage }} style={styles.avatarImage} />
                ) : (
                  <Text style={styles.avatarInitial}>{initialFor(target.nickname)}</Text>
                )}
              </View>

              <View style={styles.nameRow}>
                <Text style={styles.nickname} numberOfLines={1}>
                  {target.nickname}
                </Text>
                {target.isAI ? <Text style={styles.aiBadge}>AI</Text> : null}
              </View>

              {badges.length > 0 ? (
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  style={styles.badgeScroll}
                  contentContainerStyle={styles.badgeRow}
                >
                  {badges.map((b, i) => (
                    <View key={`${b.type}-${b.domain ?? ''}-${i}`} style={styles.badgeChip}>
                      <Text style={styles.badgeLabel} numberOfLines={1}>
                        {b.domain ? `${b.label} · ${b.domain}` : b.label}
                      </Text>
                    </View>
                  ))}
                </ScrollView>
              ) : (
                <Text style={styles.note}>{t('openstoa.peerProfile.noBadges')}</Text>
              )}

              {unavailable === 'self' ? (
                <Text style={styles.note}>{t('openstoa.peerProfile.self')}</Text>
              ) : unavailable === 'ai' ? (
                <Text style={styles.note}>{t('openstoa.peerProfile.notDmableAi')}</Text>
              ) : null}

              {showDm ? (
                <TouchableOpacity
                  style={[styles.messageButton, messagePending ? styles.messageButtonDisabled : null]}
                  onPress={() => {
                    if (messagePending) return;
                    onMessage(target);
                  }}
                  disabled={messagePending}
                  activeOpacity={0.8}
                  accessibilityRole="button"
                  accessibilityLabel={t('openstoa.peerProfile.message', { nickname: target.nickname })}
                >
                  {messagePending ? (
                    <ActivityIndicator color="#FFFFFF" size="small" />
                  ) : (
                    <Text style={styles.messageButtonText}>{t('openstoa.peerProfile.message', { nickname: target.nickname })}</Text>
                  )}
                </TouchableOpacity>
              ) : null}

              <TouchableOpacity
                style={styles.closeButton}
                onPress={onClose}
                accessibilityRole="button"
                accessibilityLabel={t('openstoa.common.done')}
              >
                <Text style={styles.closeButtonText}>{t('openstoa.common.done')}</Text>
              </TouchableOpacity>
            </View>
          </TouchableWithoutFeedback>
        </View>
      </TouchableWithoutFeedback>
    </Modal>
  );
}
