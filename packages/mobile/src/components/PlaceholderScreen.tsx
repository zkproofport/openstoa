import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useThemeColors } from '../theme/ThemeContext';
import type { ThemeColors } from '../theme/colors';

export interface PlaceholderScreenProps {
  title: string;
  hint?: string;
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    container: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      padding: 24,
      backgroundColor: colors.background.primary,
    },
    title: {
      fontSize: 22,
      fontWeight: '600',
      color: colors.text.primary,
    },
    hint: {
      marginTop: 12,
      fontSize: 14,
      color: colors.text.secondary,
      textAlign: 'center',
    },
  });
}

export function PlaceholderScreen({ title, hint }: PlaceholderScreenProps) {
  const { colors } = useThemeColors();
  const styles = makeStyles(colors);
  return (
    <View style={styles.container}>
      <Text style={styles.title}>{title}</Text>
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
    </View>
  );
}
