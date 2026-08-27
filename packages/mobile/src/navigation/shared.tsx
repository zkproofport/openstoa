import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackHeaderProps, NativeStackNavigationOptions } from '@react-navigation/native-stack';
import { useTranslation } from 'react-i18next';
import { useThemeColors } from '../theme/ThemeContext';
import { TYPE_SCALE } from '../theme/tokens';

// Modern openstoa header — mirrors the host app's
// proofport-app/src/navigation/shared.tsx so a navigated screen on the
// mini-app reads the same as the host:
//   • No "Feed" / "Topics" label next to the back arrow
//   • No rounded background pill around the chevron
//   • Large thin '‹' centered in a transparent hit area
//   • Background fills the same colour as the screen content

const HEADER_HEIGHT = 44;

function MiniAppHeader({ navigation, options, back }: NativeStackHeaderProps) {
  const insets = useSafeAreaInsets();
  const { colors } = useThemeColors();
  const { t } = useTranslation();
  const title = options.title ?? '';
  const showBack = !!back && options.headerBackVisible !== false;
  const HeaderRight = options.headerRight;
  return (
    <View
      style={[
        styles.container,
        { paddingTop: insets.top, backgroundColor: colors.background.primary },
      ]}
    >
      <View style={styles.row}>
        {showBack ? (
          <Pressable
            onPress={() => navigation.goBack()}
            style={styles.backButton}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            accessibilityRole="button"
            accessibilityLabel={t('openstoa.common.back')}
          >
            <Text style={[styles.backChevron, { color: colors.text.primary }]}>{'‹'}</Text>
          </Pressable>
        ) : (
          <View style={styles.spacer} />
        )}
        <Text style={[styles.title, { color: colors.text.primary }]} numberOfLines={1}>
          {title}
        </Text>
        {HeaderRight ? (
          <View style={styles.right}>{HeaderRight({ canGoBack: !!back })}</View>
        ) : (
          <View style={styles.spacer} />
        )}
      </View>
    </View>
  );
}

export function useMiniAppStackScreenOptions(): NativeStackNavigationOptions {
  const { colors } = useThemeColors();
  return {
    header: (props) => <MiniAppHeader {...props} />,
    contentStyle: { backgroundColor: colors.background.primary },
  };
}

const styles = StyleSheet.create({
  container: {},
  row: {
    height: HEADER_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
  },
  backButton: {
    width: 32,
    height: HEADER_HEIGHT,
    justifyContent: 'center',
  },
  backChevron: {
    fontSize: TYPE_SCALE.headingLarge,
    fontWeight: '300',
    marginTop: -2,
  },
  title: {
    flex: 1,
    fontSize: TYPE_SCALE.bodyLarge,
    fontWeight: '600',
    textAlign: 'center',
  },
  spacer: {
    width: 32,
  },
  right: {
    minWidth: 32,
    alignItems: 'flex-end',
    justifyContent: 'center',
    height: HEADER_HEIGHT,
  },
});
