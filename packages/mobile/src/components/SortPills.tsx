import React from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useThemeColors } from '../theme/ThemeContext';
import type { ThemeColors } from '../theme/colors';
import { RADIUS, TYPE_SCALE } from '../theme/tokens';

export interface SortPillsItem<T extends string> {
  key: T;
  label: string;
}

export interface SortPillsProps<T extends string, L extends string = string> {
  items: SortPillsItem<T>[];
  value: T;
  onChange: (value: T) => void;
  /**
   * A second, independent group of pills shown before the sort ones, with a
   * rule between the two.
   *
   * The Topics screen asks two questions — which topics, and in what order —
   * and they were stacked as two rows, which cost a whole row of a phone
   * screen to say something no wider than four words. They belong on one line.
   *
   * The rule is not decoration. Two selected pills side by side with nothing
   * between them read as one radio group with a broken selection; the rule is
   * what says "two questions, one answer each". Callers with a single group
   * omit this and get exactly what they had.
   */
  leading?: {
    items: SortPillsItem<L>[];
    value: L;
    onChange: (value: L) => void;
    /** Announced to assistive tech, since a rule is invisible to it. */
    accessibilityLabel?: string;
  };
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    wrapper: {
      paddingVertical: 10,
      backgroundColor: colors.background.primary,
    },
    content: {
      paddingHorizontal: 16,
      gap: 8,
      alignItems: 'center',
    },
    /** One question's worth of pills, so the rule falls between groups. */
    group: {
      flexDirection: 'row',
      gap: 8,
    },
    divider: {
      width: StyleSheet.hairlineWidth,
      alignSelf: 'stretch',
      marginVertical: 4,
      backgroundColor: colors.border.default,
    },
    pill: {
      paddingHorizontal: 14,
      minHeight: 32,
      borderRadius: RADIUS.pill,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 1,
    },
    pillIdle: {
      backgroundColor: colors.background.primary,
      borderColor: colors.border.default,
    },
    pillSelected: {
      backgroundColor: colors.brand.primary,
      borderColor: colors.brand.primary,
    },
    label: {
      fontSize: TYPE_SCALE.caption,
      fontWeight: '600',
    },
    labelIdle: {
      color: colors.text.secondary,
    },
    labelSelected: {
      color: colors.text.inverted,
    },
  });
}

export function SortPills<T extends string, L extends string = string>({
  items,
  value,
  onChange,
  leading,
}: SortPillsProps<T, L>) {
  const { colors } = useThemeColors();
  const styles = makeStyles(colors);

  const pill = <K extends string>(
    item: SortPillsItem<K>,
    selected: boolean,
    press: (key: K) => void,
  ) => (
    <TouchableOpacity
      key={item.key}
      onPress={() => press(item.key)}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      style={[styles.pill, selected ? styles.pillSelected : styles.pillIdle]}
    >
      <Text style={[styles.label, selected ? styles.labelSelected : styles.labelIdle]}>
        {item.label}
      </Text>
    </TouchableOpacity>
  );

  return (
    <View style={styles.wrapper}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.content}
      >
        {leading ? (
          <>
            <View
              style={styles.group}
              accessibilityRole="radiogroup"
              accessibilityLabel={leading.accessibilityLabel}
            >
              {leading.items.map((item) =>
                pill(item, leading.value === item.key, leading.onChange),
              )}
            </View>
            <View style={styles.divider} testID="sort-pills-divider" />
          </>
        ) : null}
        <View style={styles.group} accessibilityRole="radiogroup">
          {items.map((item) => pill(item, value === item.key, onChange))}
        </View>
      </ScrollView>
    </View>
  );
}
