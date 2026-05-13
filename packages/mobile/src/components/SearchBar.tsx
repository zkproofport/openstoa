import React from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import Feather from 'react-native-vector-icons/Feather';
import { useThemeColors } from '../theme/ThemeContext';

export interface SearchBarProps {
  value: string;
  onChangeText: (next: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
}

/**
 * Compact search input used at the top of any post / topic list screen.
 * Pure controlled-input component — caller owns the state and applies
 * the filter however it wants (client-side for now; if we ever add a
 * `?q=` endpoint the markup doesn't have to change).
 */
export function SearchBar({ value, onChangeText, placeholder, autoFocus }: SearchBarProps) {
  const { colors } = useThemeColors();
  return (
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
        placeholder={placeholder}
        placeholderTextColor={colors.text.tertiary}
        autoCorrect={false}
        autoCapitalize="none"
        autoFocus={autoFocus}
        returnKeyType="search"
        clearButtonMode="while-editing"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginHorizontal: 16,
    marginTop: 10,
    marginBottom: 6,
  },
  input: {
    flex: 1,
    fontSize: 14,
    paddingVertical: 4,
  },
});
