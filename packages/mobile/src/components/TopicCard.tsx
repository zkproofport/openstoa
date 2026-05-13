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
      borderRadius: 12,
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
      fontSize: 16,
      fontWeight: '600',
      color: colors.text.primary,
    },
    badge: {
      backgroundColor: colors.brand.primaryMuted,
      borderRadius: 6,
      paddingHorizontal: 8,
      paddingVertical: 3,
    },
    badgeText: {
      fontSize: 11,
      fontWeight: '600',
      color: colors.brand.primary,
    },
    joinedBadge: {
      backgroundColor: colors.status.success + '22', // soft tint
      borderRadius: 6,
      paddingHorizontal: 8,
      paddingVertical: 3,
    },
    joinedBadgeText: {
      fontSize: 11,
      fontWeight: '600',
      color: colors.status.success,
    },
    description: {
      fontSize: 13,
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
      fontSize: 12,
      color: colors.text.tertiary,
    },
    joinButton: {
      backgroundColor: colors.brand.primary,
      borderRadius: 8,
      paddingHorizontal: 14,
      paddingVertical: 6,
    },
    joinButtonText: {
      fontSize: 13,
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
        {!isJoined && onJoin ? (
          <TouchableOpacity style={styles.joinButton} onPress={onJoin} activeOpacity={0.8}>
            <Text style={styles.joinButtonText}>{t('openstoa.topics.join')}</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    </TouchableOpacity>
  );
}
