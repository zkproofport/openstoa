import React from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import type { Topic, ProofType } from '@openstoa/api-types';
import { useThemeColors } from '../theme/ThemeContext';
import type { ThemeColors } from '../theme/colors';
import { RADIUS, TYPE_SCALE } from '../theme/tokens';

const PROOF_TYPE_LABEL: Record<ProofType, string | null> = {
  none: null,
  kyc: 'KYC',
  country: 'Country',
  google_workspace: 'Google WS',
  microsoft_365: 'MS 365',
  workspace: 'Workspace',
};

interface TopicCardProps {
  topic: Topic;
  onPress: () => void;
  isJoined?: boolean;
  onJoin?: () => void;
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    card: {
      backgroundColor: colors.background.primary,
      borderRadius: RADIUS.card,
      padding: 16,
      marginHorizontal: 16,
      marginVertical: 6,
      borderWidth: 1,
      borderColor: colors.border.default,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      marginBottom: 4,
    },
    title: {
      flex: 1,
      fontSize: TYPE_SCALE.body,
      fontWeight: '600',
      color: colors.text.primary,
    },
    badge: {
      backgroundColor: colors.brand.primaryMuted,
      borderRadius: RADIUS.control,
      paddingHorizontal: 8,
      paddingVertical: 3,
    },
    badgeText: {
      fontSize: TYPE_SCALE.label,
      fontWeight: '600',
      color: colors.brand.primary,
    },
    joinedBadge: {
      backgroundColor: colors.status.success + '22', // soft tint
      borderRadius: RADIUS.control,
      paddingHorizontal: 8,
      paddingVertical: 3,
    },
    joinedBadgeText: {
      fontSize: TYPE_SCALE.label,
      fontWeight: '600',
      color: colors.status.success,
    },
    description: {
      fontSize: TYPE_SCALE.bodySmall,
      color: colors.text.secondary,
      marginBottom: 10,
    },
    footer: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginTop: 4,
    },
    memberCount: {
      fontSize: TYPE_SCALE.label,
      color: colors.text.tertiary,
    },
    inviteOnlyBadge: {
      fontSize: TYPE_SCALE.label,
      color: colors.text.tertiary,
    },
    joinButton: {
      backgroundColor: colors.brand.primary,
      borderRadius: RADIUS.control,
      paddingHorizontal: 14,
      paddingVertical: 6,
    },
    joinButtonText: {
      fontSize: TYPE_SCALE.bodySmall,
      fontWeight: '600',
      color: colors.text.inverted,
    },
  });
}

export function TopicCard({ topic, onPress, isJoined, onJoin }: TopicCardProps) {
  const { t } = useTranslation();
  const { colors } = useThemeColors();
  const styles = makeStyles(colors);
  const proofLabel = topic.proofType ? PROOF_TYPE_LABEL[topic.proofType] : null;

  return (
    <TouchableOpacity style={styles.card} onPress={onPress} activeOpacity={0.7}>
      <View style={styles.header}>
        <Text style={styles.title} numberOfLines={1}>
          {topic.title}
        </Text>
        {isJoined ? (
          <View style={styles.joinedBadge}>
            <Text style={styles.joinedBadgeText}>{t('openstoa.topics.joinedBadge')}</Text>
          </View>
        ) : null}
        {proofLabel ? (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{proofLabel}</Text>
          </View>
        ) : null}
      </View>

      {topic.description ? (
        <Text style={styles.description} numberOfLines={1}>
          {topic.description}
        </Text>
      ) : null}

      <View style={styles.footer}>
        <Text style={styles.memberCount}>
          {t('openstoa.topics.members', { count: topic.memberCount ?? 0 })}
        </Text>
        {!isJoined && onJoin && topic.visibility && topic.visibility !== 'public' ? (
          // The card's "Join" opens the detail screen rather than joining, but
          // the WORD is still a promise this topic cannot keep: it is
          // invite-only, and the detail screen now says so too.
          <Text style={styles.inviteOnlyBadge} testID="card-invite-only">
            {t('openstoa.topics.inviteOnly')}
          </Text>
        ) : !isJoined && onJoin ? (
          <TouchableOpacity
            style={styles.joinButton}
            onPress={onJoin}
            activeOpacity={0.8}
            // Named so a test can ask for THIS control: the whole card is
            // pressable and the joined badge's i18n key contains the join
            // key, so a text search finds a button that is not there.
            testID="card-join"
          >
            <Text style={styles.joinButtonText}>{t('openstoa.topics.join')}</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    </TouchableOpacity>
  );
}
