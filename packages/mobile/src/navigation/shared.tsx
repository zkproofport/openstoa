import React, { useState } from 'react';
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
/** The back arrow's width — the least that is kept clear on either side. */
const SIDE_MIN = 32;

function MiniAppHeader({ navigation, options, back }: NativeStackHeaderProps) {
  const insets = useSafeAreaInsets();
  const { colors } = useThemeColors();
  const { t } = useTranslation();
  const title = options.title ?? '';
  const showBack = !!back && options.headerBackVisible !== false;
  const HeaderRight = options.headerRight;

  /*
   * How wide the controls on the right turned out to be.
   *
   * The title used to be a flexible box BETWEEN the back arrow and those
   * controls, centred inside whatever space was left over — so a chat room with
   * four controls on the right (the lock, the member list, the mute and the
   * presence dot) had its name sitting visibly left of centre. Centred in the
   * leftover space is not centred in the header.
   *
   * Measured rather than guessed: the controls are supplied by each screen and
   * there is no way to know from here how many there are. Until the first
   * measurement lands the back arrow's width stands in, which is what the
   * header did before and is right for the many screens with nothing on the
   * right at all.
   */
  const [rightWidth, setRightWidth] = useState(SIDE_MIN);
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
        <View style={styles.flexible} />
        {HeaderRight ? (
          <View
            style={styles.right}
            onLayout={(e) => setRightWidth(Math.max(SIDE_MIN, e.nativeEvent.layout.width))}
          >
            {HeaderRight({ canGoBack: !!back })}
          </View>
        ) : (
          <View style={styles.spacer} />
        )}
        {/*
          The name sits in its own layer across the WHOLE header, so it is
          centred on the header rather than on the gap left between the
          controls. `pointerEvents` is off so every tap still reaches the arrow
          and the controls underneath it.

          The same side width is kept clear on BOTH sides, so a long name runs
          out of room before it reaches either — it ellipsises, as it did
          before, and never slides under an icon.
        */}
        <View style={styles.titleLayer} pointerEvents="none">
          <Text
            style={[styles.title, { color: colors.text.primary, marginHorizontal: rightWidth + 8 }]}
            numberOfLines={1}
            ellipsizeMode="tail"
          >
            {title}
          </Text>
        </View>
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
  flexible: {
    flex: 1,
  },
  titleLayer: {
    // Spelled out rather than spread from `absoluteFillObject`: the spread is
    // one token that either works or silently contributes nothing, and when it
    // contributed nothing the header still LOOKED right in a test while the
    // name was no longer in a layer at all.
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
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
