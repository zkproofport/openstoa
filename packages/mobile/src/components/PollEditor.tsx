import React, { useCallback } from 'react';
import { Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import Feather from 'react-native-vector-icons/Feather';
import { useThemeColors } from '../theme/ThemeContext';
import type { ThemeColors } from '../theme/colors';

export interface PollEditorValue {
  question?: string;
  options: string[];
  multipleChoice: boolean;
  /** ISO 8601 timestamp when the poll closes, or null for never. */
  closesAt: string | null;
}

export interface PollEditorProps {
  value: PollEditorValue;
  onChange: (next: PollEditorValue) => void;
  /** Called when the user dismisses the poll entirely — parent should set
   *  the poll state to null. */
  onRemove: () => void;
}

const DURATIONS: { key: 'off' | '1d' | '3d' | '7d'; ms: number | null }[] = [
  { key: 'off', ms: null },
  { key: '1d', ms: 24 * 60 * 60 * 1000 },
  { key: '3d', ms: 3 * 24 * 60 * 60 * 1000 },
  { key: '7d', ms: 7 * 24 * 60 * 60 * 1000 },
];

const MIN_OPTIONS = 2;
const MAX_OPTIONS = 4;
const MAX_OPTION_LEN = 80;

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    wrap: {
      marginTop: 12,
      padding: 12,
      borderWidth: 1,
      borderColor: colors.border.default,
      borderRadius: 10,
      backgroundColor: colors.background.secondary,
      gap: 10,
    },
    headerRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    headerLabel: {
      flex: 1,
      fontSize: 13,
      fontWeight: '700',
      color: colors.text.primary,
    },
    closeBtn: { padding: 4 },
    input: {
      borderWidth: 1,
      borderColor: colors.border.default,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 10,
      fontSize: 14,
      color: colors.text.primary,
      backgroundColor: colors.background.primary,
    },
    optionRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
    },
    optionInput: { flex: 1 },
    removeBtn: { padding: 6 },
    addBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      paddingVertical: 6,
      paddingHorizontal: 10,
      alignSelf: 'flex-start',
      borderRadius: 8,
      backgroundColor: colors.background.primary,
      borderWidth: 1,
      borderColor: colors.border.default,
    },
    addBtnLabel: {
      fontSize: 12,
      color: colors.text.secondary,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    rowLabel: {
      flex: 1,
      fontSize: 13,
      color: colors.text.secondary,
    },
    durationRow: {
      flexDirection: 'row',
      gap: 6,
    },
    durationChip: {
      paddingVertical: 6,
      paddingHorizontal: 10,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: colors.border.default,
      backgroundColor: colors.background.primary,
    },
    durationChipActive: {
      borderColor: colors.brand.primary,
      backgroundColor: colors.brand.primaryMuted,
    },
    durationChipLabel: {
      fontSize: 12,
      color: colors.text.secondary,
    },
    durationChipLabelActive: {
      color: colors.brand.primary,
      fontWeight: '700',
    },
  });
}

export function PollEditor({ value, onChange, onRemove }: PollEditorProps) {
  const { t } = useTranslation();
  const { colors } = useThemeColors();
  const styles = makeStyles(colors);

  const setOption = useCallback(
    (index: number, text: string) => {
      const next = [...value.options];
      next[index] = text.slice(0, MAX_OPTION_LEN);
      onChange({ ...value, options: next });
    },
    [value, onChange],
  );

  const addOption = useCallback(() => {
    if (value.options.length >= MAX_OPTIONS) return;
    onChange({ ...value, options: [...value.options, ''] });
  }, [value, onChange]);

  const removeOption = useCallback(
    (index: number) => {
      if (value.options.length <= MIN_OPTIONS) return;
      onChange({ ...value, options: value.options.filter((_, i) => i !== index) });
    },
    [value, onChange],
  );

  const setDuration = useCallback(
    (key: 'off' | '1d' | '3d' | '7d') => {
      const cfg = DURATIONS.find((d) => d.key === key);
      const closesAt = cfg && cfg.ms ? new Date(Date.now() + cfg.ms).toISOString() : null;
      onChange({ ...value, closesAt });
    },
    [value, onChange],
  );

  const activeDuration: 'off' | '1d' | '3d' | '7d' = useMemoActiveDuration(value.closesAt);

  return (
    <View style={styles.wrap}>
      <View style={styles.headerRow}>
        <Feather name="bar-chart-2" size={14} color={colors.brand.primary} />
        <Text style={styles.headerLabel}>{t('openstoa.pollEditor.title')}</Text>
        <Pressable style={styles.closeBtn} onPress={onRemove} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Feather name="x" size={16} color={colors.text.tertiary} />
        </Pressable>
      </View>

      <TextInput
        style={styles.input}
        placeholder={t('openstoa.pollEditor.questionPlaceholder')}
        placeholderTextColor={colors.text.tertiary}
        value={value.question ?? ''}
        onChangeText={(q) => onChange({ ...value, question: q })}
        maxLength={140}
      />

      {value.options.map((opt, i) => (
        <View key={i} style={styles.optionRow}>
          <TextInput
            style={[styles.input, styles.optionInput]}
            placeholder={t('openstoa.pollEditor.optionPlaceholder', { n: i + 1 })}
            placeholderTextColor={colors.text.tertiary}
            value={opt}
            onChangeText={(v) => setOption(i, v)}
            maxLength={MAX_OPTION_LEN}
          />
          {value.options.length > MIN_OPTIONS ? (
            <Pressable
              style={styles.removeBtn}
              onPress={() => removeOption(i)}
              hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
            >
              <Feather name="x" size={16} color={colors.text.tertiary} />
            </Pressable>
          ) : null}
        </View>
      ))}

      {value.options.length < MAX_OPTIONS ? (
        <Pressable style={styles.addBtn} onPress={addOption}>
          <Feather name="plus" size={12} color={colors.text.secondary} />
          <Text style={styles.addBtnLabel}>{t('openstoa.pollEditor.addOption')}</Text>
        </Pressable>
      ) : null}

      <View style={styles.row}>
        <Text style={styles.rowLabel}>{t('openstoa.pollEditor.multipleChoice')}</Text>
        <Switch
          value={value.multipleChoice}
          onValueChange={(v) => onChange({ ...value, multipleChoice: v })}
          trackColor={{ true: colors.brand.primary, false: colors.background.tertiary }}
        />
      </View>

      <Text style={styles.rowLabel}>{t('openstoa.pollEditor.duration')}</Text>
      <View style={styles.durationRow}>
        {DURATIONS.map((d) => {
          const active = activeDuration === d.key;
          return (
            <Pressable
              key={d.key}
              style={[styles.durationChip, active ? styles.durationChipActive : null]}
              onPress={() => setDuration(d.key)}
            >
              <Text style={[styles.durationChipLabel, active ? styles.durationChipLabelActive : null]}>
                {t(`openstoa.pollEditor.duration_${d.key}`)}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

// Tiny inline helper so the file is self-contained — picks the chip that
// best matches the current closesAt (within ±1h tolerance).
function useMemoActiveDuration(closesAt: string | null): 'off' | '1d' | '3d' | '7d' {
  if (!closesAt) return 'off';
  const diff = new Date(closesAt).getTime() - Date.now();
  if (diff <= 0) return 'off';
  const day = 24 * 60 * 60 * 1000;
  if (Math.abs(diff - 7 * day) < 60 * 60 * 1000) return '7d';
  if (Math.abs(diff - 3 * day) < 60 * 60 * 1000) return '3d';
  if (Math.abs(diff - 1 * day) < 60 * 60 * 1000) return '1d';
  // No exact match (e.g. resumed draft) — fall back to "off" so the chip
  // row stays predictable.
  return 'off';
}
