import { userFacingError } from '../i18n/userFacingError';
import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useThemeColors } from '../theme/ThemeContext';
import type { ThemeColors } from '../theme/colors';
import { RADIUS, TOUCH_TARGET_MIN, TYPE_SCALE } from '../theme/tokens';

export interface QueryErrorStateProps {
  /** What failed to load, in the reader's terms — "Couldn't load topics". */
  title: string;
  /** The thrown error, translated before display. */
  error: unknown;
  /** Fetch again. Usually react-query's `refetch`. */
  onRetry: () => void;
  testID?: string;
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    center: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 32,
      paddingVertical: 60,
    },
    title: {
      fontSize: TYPE_SCALE.body,
      fontWeight: '600',
      color: colors.status.danger,
      textAlign: 'center',
    },
    body: {
      fontSize: TYPE_SCALE.bodySmall,
      color: colors.text.secondary,
      marginTop: 6,
      textAlign: 'center',
    },
    retryBtn: {
      marginTop: 16,
      paddingHorizontal: 18,
      minHeight: TOUCH_TARGET_MIN,
      justifyContent: 'center',
      borderRadius: RADIUS.pill,
      backgroundColor: colors.brand.primary,
    },
    retryLabel: {
      color: colors.text.inverted,
      fontWeight: '600',
    },
  });
}

/**
 * What a screen shows when the thing it exists to display would not load.
 *
 * A failed LOAD is not a failed action, and the two want opposite treatments.
 * An action the person took — saving a nickname — is reported in the host's
 * error modal: the screen behind it is intact and only the action needs
 * acknowledging. A load that failed leaves nothing on screen at all, so a modal
 * would be the wrong shape twice over: dismissing it reveals an empty page, and
 * the one control that matters — try again — would have gone with it.
 *
 * The reason this is a component rather than a pattern: three chat screens had
 * hand-rolled the same block, and eleven others had nothing, so a list that
 * failed to load was indistinguishable from a list that was genuinely empty.
 * "No topics found" while the phone is in aeroplane mode is not a missing error
 * message — it is a false statement about the world.
 */
export function QueryErrorState({ title, error, onRetry, testID }: QueryErrorStateProps) {
  const { t } = useTranslation();
  const { colors } = useThemeColors();
  const styles = makeStyles(colors);

  return (
    <View style={styles.center} testID={testID ?? 'query-error-state'}>
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.body}>{userFacingError(error, t)}</Text>
      <TouchableOpacity
        style={styles.retryBtn}
        onPress={onRetry}
        accessibilityRole="button"
        testID="query-error-retry"
      >
        <Text style={styles.retryLabel}>{t('openstoa.common.retry')}</Text>
      </TouchableOpacity>
    </View>
  );
}
