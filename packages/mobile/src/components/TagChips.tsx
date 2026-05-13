import React from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useThemeColors } from '../theme/ThemeContext';
import type { ThemeColors } from '../theme/colors';

export interface TagChip {
  slug: string | null;
  label: string;
}

export interface TagChipsProps {
  chips: TagChip[];
  value: string | null;
  onChange: (slug: string | null) => void;
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    wrapper: {
      paddingVertical: 8,
      backgroundColor: colors.background.primary,
    },
    content: {
      paddingHorizontal: 16,
      gap: 8,
    },
    chip: {
      paddingHorizontal: 12,
      minHeight: 30,
      borderRadius: 14,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 1,
    },
    chipIdle: {
      backgroundColor: colors.background.primary,
      borderColor: colors.border.default,
    },
    chipSelected: {
      backgroundColor: colors.brand.primaryMuted,
      borderColor: colors.brand.primary,
    },
    label: {
      fontSize: 12,
      fontWeight: '500',
    },
    labelIdle: {
      color: colors.text.secondary,
    },
    labelSelected: {
      color: colors.brand.primary,
      fontWeight: '700',
    },
  });
}

/**
 * Horizontal scrollable filter chips. The first chip can pass `slug=null`
 * to act as the "All" reset. Multi-select is intentionally avoided here
 * to keep the mobile filter row simple — a single tap commits the
 * selection.
 */
export function TagChips({ chips, value, onChange }: TagChipsProps) {
  const { colors } = useThemeColors();
  const styles = makeStyles(colors);

  return (
    <View style={styles.wrapper}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.content}
      >
        {chips.map((chip) => {
          const selected = chip.slug === value;
          return (
            <TouchableOpacity
              key={chip.slug ?? '__all__'}
              onPress={() => onChange(chip.slug)}
              activeOpacity={0.7}
              style={[styles.chip, selected ? styles.chipSelected : styles.chipIdle]}
            >
              <Text style={[styles.label, selected ? styles.labelSelected : styles.labelIdle]}>
                {chip.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>
    </View>
  );
}
