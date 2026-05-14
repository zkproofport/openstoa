import React from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import Feather from 'react-native-vector-icons/Feather';
import { useThemeColors } from '../theme/ThemeContext';

export interface SearchBarProps {
  /** The current draft text the user is typing — controlled. */
  value: string;
  onChangeText: (next: string) => void;
  /**
   * Called when the user explicitly submits the search — either by
   * pressing the keyboard "search" key or tapping the inline Search
   * button. Backend search is keyword-triggered, not real-time, so
   * callers should NOT fire requests on `onChangeText`.
   */
  onSubmit: (value: string) => void;
  /** Optional: called when the user clears (X button) to reset to no-filter state. */
  onClear?: () => void;
  placeholder?: string;
  autoFocus?: boolean;
  /** Button label, defaults to "Search". */
  submitLabel?: string;
}

/**
 * Compact search bar with an explicit "Search" submit button.
 *
 * Backend search is intentionally NOT real-time: typing into the input
 * only updates the local draft. The query only goes to the server when
 * `onSubmit` fires (Enter / "search" key on keyboard, or the inline
 * button). This is the pattern the user enforced — typing should never
 * be a per-character network call.
 */
export function SearchBar({
  value,
  onChangeText,
  onSubmit,
  onClear,
  placeholder,
  autoFocus,
  submitLabel = 'Search',
}: SearchBarProps) {
  const { colors } = useThemeColors();
  const trimmed = value.trim();
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
        <Feather name="search" size={14} color={colors.text.tertiary} />
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
          <Pressable onPress={handleClear} hitSlop={8}>
            <Feather name="x" size={14} color={colors.text.tertiary} />
          </Pressable>
        )}
      </View>
      <Pressable
        onPress={() => onSubmit(trimmed)}
        disabled={trimmed.length === 0}
        style={({ pressed }) => [
          styles.submitButton,
          {
            backgroundColor: trimmed.length === 0
              ? colors.background.tertiary
              : pressed
                ? colors.accent.pressed
                : colors.accent.default,
            opacity: trimmed.length === 0 ? 0.6 : 1,
          },
        ]}
      >
        <Text
          style={[
            styles.submitLabel,
            { color: trimmed.length === 0 ? colors.text.tertiary : '#fff' },
          ]}
        >
          {submitLabel}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 6,
  },
  wrap: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  input: {
    flex: 1,
    fontSize: 14,
    paddingVertical: 4,
  },
  submitButton: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 10,
  },
  submitLabel: {
    fontSize: 13,
    fontWeight: '600',
  },
});
