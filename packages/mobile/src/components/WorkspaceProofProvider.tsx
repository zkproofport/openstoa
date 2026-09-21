import React from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useThemeColors } from '../theme/ThemeContext';
import { RADIUS } from '../theme/tokens';

/** Either-provider topics still need a concrete provider for this person's proof. */
export function WorkspaceProofProvider({ value, onChange, disabled = false }: {
  value: 'google' | 'microsoft' | null;
  onChange: (provider: 'google' | 'microsoft') => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const { colors } = useThemeColors();
  const providers = [
    { id: 'google' as const, label: 'openstoa.topicCreate.proofTypes.googleWorkspace' },
    { id: 'microsoft' as const, label: 'openstoa.topicCreate.proofTypes.microsoft365' },
  ];
  return <View style={{ flexDirection: 'row', gap: 8, marginVertical: 12 }}>
    {providers.map(provider => <TouchableOpacity
      key={provider.id}
      disabled={disabled}
      accessibilityRole="radio"
      accessibilityState={{ selected: value === provider.id, disabled }}
      onPress={() => onChange(provider.id)}
      style={{ padding: 12, borderWidth: 1, borderColor: value === provider.id ? colors.brand.primary : colors.text.tertiary, borderRadius: RADIUS.control }}
    ><Text style={{ color: colors.text.primary }}>{t(provider.label)}</Text></TouchableOpacity>)}
  </View>;
}
