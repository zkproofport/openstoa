import React from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useThemeColors } from '../theme/ThemeContext';
import type { ThemeColors } from '../theme/colors';
import { RADIUS, TYPE_SCALE } from '../theme/tokens';

export interface SortPillsItem<T extends string> {
  key: T;
  label: string;
}

export interface SortPillsProps<T extends string> {
  items: SortPillsItem<T>[];
  value: T;
  onChange: (value: T) => void;
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

export function SortPills<T extends string>({ items, value, onChange }: SortPillsProps<T>) {
  const { colors } = useThemeColors();
  const styles = makeStyles(colors);

  return (
    <View style={styles.wrapper}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.content}
      >
        {items.map((item) => {
          const selected = value === item.key;
          return (
            <TouchableOpacity
              key={item.key}
              onPress={() => onChange(item.key)}
              activeOpacity={0.7}
              style={[styles.pill, selected ? styles.pillSelected : styles.pillIdle]}
            >
              <Text style={[styles.label, selected ? styles.labelSelected : styles.labelIdle]}>
                {item.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>
    </View>
  );
}
