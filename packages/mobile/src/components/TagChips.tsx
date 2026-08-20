import React, { useState } from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useThemeColors } from '../theme/ThemeContext';
import type { ThemeColors } from '../theme/colors';
import { RADIUS, TYPE_SCALE } from '../theme/tokens';

export interface TagChip {
  slug: string | null;
  label: string;
}

export interface TagChipsProps {
  chips: TagChip[];
  value: string | null;
  onChange: (slug: string | null) => void;
  /**
   * Render behind a header that folds the chips away.
   *
   * For a row that is long, rarely changed, and third in a stack of filters —
   * the Topics screen's categories — a permanently open scroller costs a row
   * of a phone screen to show one answer that is usually "All". Folded, the
   * header states the current answer, so nothing is hidden, only quietened.
   *
   * Off by default: a caller whose chips ARE the point (the feed's tags) keeps
   * them open.
   */
  collapsible?: boolean;
  /** Header label when collapsible, e.g. "Category". Required for a11y then. */
  title?: string;
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
      borderRadius: RADIUS.pill,
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
      fontSize: TYPE_SCALE.label,
      fontWeight: '500',
    },
    labelIdle: {
      color: colors.text.secondary,
    },
    labelSelected: {
      color: colors.brand.primary,
      fontWeight: '700',
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingHorizontal: 16,
      // 44 so the fold is a real touch target, not a line of text you have to
      // aim at.
      minHeight: 44,
    },
    headerTitle: {
      fontSize: TYPE_SCALE.label,
      fontWeight: '600',
      color: colors.text.tertiary,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
    },
    headerValue: {
      flex: 1,
      fontSize: TYPE_SCALE.label,
      fontWeight: '600',
      color: colors.text.primary,
    },
    headerCaret: {
      fontSize: TYPE_SCALE.body,
      color: colors.text.tertiary,
    },
  });
}

/**
 * Horizontal scrollable filter chips. The first chip can pass `slug=null`
 * to act as the "All" reset. Multi-select is intentionally avoided here
 * to keep the mobile filter row simple — a single tap commits the
 * selection.
 */
export function TagChips({ chips, value, onChange, collapsible = false, title }: TagChipsProps) {
  const { colors } = useThemeColors();
  const styles = makeStyles(colors);
  /*
   * Folded until asked for, but never while it is doing something.
   *
   * Hiding a filter that is actively narrowing the list would hide the reason
   * the list is short, so a non-default selection opens it. Otherwise the
   * header states the current answer and the row costs one line instead of
   * three.
   */
  const [open, setOpen] = useState(value !== null);
  const selectedLabel = (chips.find((c) => c.slug === value) ?? chips[0])?.label ?? '';

  const scroller = (
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
            accessibilityRole="button"
            accessibilityState={{ selected }}
            style={[styles.chip, selected ? styles.chipSelected : styles.chipIdle]}
          >
            <Text style={[styles.label, selected ? styles.labelSelected : styles.labelIdle]}>
              {chip.label}
            </Text>
          </TouchableOpacity>
        );
      })}
    </ScrollView>
  );

  if (!collapsible) {
    return <View style={styles.wrapper}>{scroller}</View>;
  }

  return (
    <View style={styles.wrapper}>
      <TouchableOpacity
        onPress={() => setOpen((wasOpen) => !wasOpen)}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        // Reads as one sentence to a screen reader: what this is, and what it
        // currently says. The chevron alone conveys neither.
        accessibilityLabel={title ? `${title}: ${selectedLabel}` : selectedLabel}
        testID="tag-chips-toggle"
        style={styles.header}
      >
        <Text style={styles.headerTitle}>{title}</Text>
        <Text style={styles.headerValue} numberOfLines={1}>
          {selectedLabel}
        </Text>
        {/* A caret, not an icon font: this component has no icon dependency
            and one glyph is not worth adding it. */}
        <Text style={styles.headerCaret}>{open ? '\u2303' : '\u2304'}</Text>
      </TouchableOpacity>
      {open ? scroller : null}
    </View>
  );
}
