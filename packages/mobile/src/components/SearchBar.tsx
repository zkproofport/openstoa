import React from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';
import Feather from 'react-native-vector-icons/Feather';
import { useThemeColors } from '../theme/ThemeContext';
import { RADIUS, TYPE_SCALE } from '../theme/tokens';

export interface SearchBarProps {
  /** The current draft text the user is typing — controlled. */
  value: string;
  onChangeText: (next: string) => void;
  /**
   * Called when the user explicitly submits the search — either by
   * pressing the keyboard "search" key or tapping the trailing magnifier
   * icon button. Backend search is keyword-triggered, not real-time, so
   * callers should NOT fire requests on `onChangeText`.
   */
  onSubmit: (value: string) => void;
  /** Optional: called when the user clears (×) to reset to no-filter state. */
  onClear?: () => void;
  placeholder?: string;
  autoFocus?: boolean;
}

/**
 * Compact search bar with a single trailing magnifier button as the
 * submit affordance. Typing only updates the local draft — the request
 * fires when the user taps the magnifier or hits the keyboard "search"
 * key. The clear (×) button appears while there is text and resets the
 * filter to the no-q state via `onClear`.
 *
 * No leading icon: a left magnifier + right submit button is redundant,
 * so the right magnifier doubles as the submit affordance.
 */
export function SearchBar({
  value,
  onChangeText,
  onSubmit,
  onClear,
  placeholder,
  autoFocus,
}: SearchBarProps) {
  const { colors } = useThemeColors();
  const trimmed = value.trim();
  const canSubmit = trimmed.length > 0;
  const handleClear = () => {
    onChangeText('');
    onClear?.();
  };
  return (
    <View style={styles.row}>
      <View
        style={[
          styles.wrap,
          {
            backgroundColor: colors.background.secondary,
            borderColor: colors.border.default,
          },
        ]}
      >
        <TextInput
          style={[styles.input, { color: colors.text.primary }]}
          value={value}
          onChangeText={onChangeText}
          onSubmitEditing={() => onSubmit(trimmed)}
          placeholder={placeholder}
          placeholderTextColor={colors.text.tertiary}
          autoCorrect={false}
          autoCapitalize="none"
          autoFocus={autoFocus}
          returnKeyType="search"
        />
        {value.length > 0 && (
          <Pressable onPress={handleClear} hitSlop={8} style={styles.iconSlot}>
            <Feather name="x" size={16} color={colors.text.tertiary} />
          </Pressable>
        )}
        <Pressable
          onPress={() => onSubmit(trimmed)}
          disabled={!canSubmit}
          hitSlop={8}
          style={styles.iconSlot}
        >
          <Feather
            name="search"
            size={18}
            color={canSubmit ? colors.brand.primary : colors.text.tertiary}
          />
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 6,
  },
  wrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: RADIUS.control,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  input: {
    flex: 1,
    fontSize: TYPE_SCALE.body,
    paddingVertical: 4,
  },
  iconSlot: {
    paddingHorizontal: 4,
    paddingVertical: 4,
  },
});
