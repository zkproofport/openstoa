import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Alert,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { useNavigation } from '@react-navigation/native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { Topic } from '@openstoa/api-types';

interface Category {
  id: string;
  name: string;
  slug: string;
  icon?: string | null;
  sortOrder: number;
}
import { useOpenStoaClient } from '../../hooks/useOpenStoaClient';
import { useThemeColors } from '../../theme/ThemeContext';
import type { ThemeColors } from '../../theme/colors';
import type { TopicsStackParamList } from '../../navigation/stacks/TopicsStack';

type Nav = NativeStackNavigationProp<TopicsStackParamList, 'TopicCreate'>;

type ProofType = 'none' | 'kyc' | 'country' | 'google_workspace' | 'microsoft_365' | 'workspace';
type Visibility = 'public' | 'private' | 'secret';

interface CreateTopicBody {
  title: string;
  description?: string;
  proofType: ProofType;
  categoryId: string;
  visibility?: Visibility;
  allowedCountries?: string[];
  countryMode?: 'include' | 'exclude';
  requiredDomain?: string;
}

interface CreateTopicResponse {
  topic: Topic;
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    flex: {
      flex: 1,
      backgroundColor: colors.background.primary,
    },
    scroll: {
      flex: 1,
    },
    content: {
      padding: 20,
      paddingBottom: 40,
    },
    label: {
      fontSize: 13,
      fontWeight: '600',
      color: colors.text.secondary,
      marginBottom: 6,
    },
    labelSpaced: {
      marginTop: 20,
    },
    required: {
      color: colors.status.danger,
    },
    input: {
      borderWidth: 1,
      borderColor: colors.border.default,
      borderRadius: 10,
      paddingHorizontal: 14,
      paddingVertical: 12,
      fontSize: 15,
      color: colors.text.primary,
      backgroundColor: colors.background.secondary,
    },
    multilineInput: {
      minHeight: 100,
      paddingTop: 12,
    },
    charCount: {
      fontSize: 11,
      color: colors.text.tertiary,
      textAlign: 'right',
      marginTop: 4,
    },
    pickerGroup: {
      gap: 8,
    },
    pickerOption: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      borderWidth: 1,
      borderColor: colors.border.default,
      borderRadius: 10,
      paddingHorizontal: 14,
      paddingVertical: 12,
      backgroundColor: colors.background.secondary,
    },
    pickerOptionSelected: {
      borderColor: colors.brand.primary,
      backgroundColor: colors.brand.primaryMuted,
    },
    pickerOptionText: {
      fontSize: 15,
      color: colors.text.primary,
    },
    pickerOptionTextSelected: {
      color: colors.brand.primary,
      fontWeight: '600',
    },
    wipBadge: {
      fontSize: 10,
      fontWeight: '700',
      color: colors.text.tertiary,
      backgroundColor: colors.background.tertiary,
      paddingHorizontal: 6,
      paddingVertical: 2,
      borderRadius: 4,
    },
    submitButton: {
      marginTop: 32,
      backgroundColor: colors.brand.primary,
      borderRadius: 12,
      paddingVertical: 14,
      alignItems: 'center',
    },
    submitButtonDisabled: {
      opacity: 0.5,
    },
    submitLabel: {
      fontSize: 16,
      fontWeight: '700',
      color: '#FFFFFF',
    },
    extraInput: {
      borderWidth: 1,
      borderColor: colors.border.default,
      borderRadius: 10,
      paddingHorizontal: 14,
      paddingVertical: 10,
      fontSize: 14,
      color: colors.text.primary,
      backgroundColor: colors.background.secondary,
      fontVariant: ['tabular-nums' as const],
    },
    modeRow: {
      flexDirection: 'row' as const,
      gap: 8,
    },
    modeBtn: {
      flex: 1,
      paddingVertical: 10,
      borderRadius: 8,
      alignItems: 'center' as const,
      borderWidth: 1,
    },
    modeBtnActive: {
      backgroundColor: colors.brand.primaryMuted,
      borderColor: colors.brand.primary,
    },
    modeBtnInactive: {
      backgroundColor: colors.background.secondary,
      borderColor: colors.border.default,
    },
    modeBtnText: {
      fontSize: 14,
      fontWeight: '600' as const,
    },
    infoBox: {
      marginTop: 10,
      padding: 12,
      backgroundColor: colors.background.tertiary,
      borderRadius: 8,
    },
    infoText: {
      fontSize: 12,
      color: colors.text.tertiary,
      lineHeight: 18,
    },
  });
}

export function TopicCreateScreen() {
  const { t } = useTranslation();
  const navigation = useNavigation<Nav>();
  const client = useOpenStoaClient();
  const queryClient = useQueryClient();
  const { colors } = useThemeColors();
  const styles = makeStyles(colors);

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [proofType, setProofType] = useState<ProofType>('none');
  const [categoryId, setCategoryId] = useState<string>('');
  const [visibility, setVisibility] = useState<Visibility>('public');
  const [countryCodes, setCountryCodes] = useState('');
  const [countryMode, setCountryMode] = useState<'include' | 'exclude'>('include');
  const [requiredDomain, setRequiredDomain] = useState('');

  const PROOF_TYPE_OPTIONS: { value: ProofType; label: string; wip?: boolean }[] = [
    { value: 'none', label: t('openstoa.topicCreate.proofTypes.none') },
    { value: 'kyc', label: t('openstoa.topicCreate.proofTypes.kyc') },
    { value: 'country', label: t('openstoa.topicCreate.proofTypes.country') },
    { value: 'google_workspace', label: t('openstoa.topicCreate.proofTypes.googleWorkspace') },
    { value: 'microsoft_365', label: t('openstoa.topicCreate.proofTypes.microsoft365') },
    { value: 'workspace', label: t('openstoa.topicCreate.proofTypes.workspace') },
  ];

  const categoriesQuery = useQuery<{ categories: Category[] }>({
    queryKey: ['categories'],
    queryFn: () => client.get<{ categories: Category[] }>('/api/categories'),
  });

  const categories = categoriesQuery.data?.categories ?? [];

  // Default to the first category once they load
  React.useEffect(() => {
    if (!categoryId && categories.length > 0) {
      setCategoryId(categories[0].id);
    }
  }, [categories, categoryId]);

  const createMutation = useMutation({
    mutationFn: async () => {
      const body: CreateTopicBody = {
        title: title.trim(),
        proofType,
        categoryId,
        visibility,
      };
      if (description.trim()) {
        body.description = description.trim();
      }
      if (proofType === 'country' && countryCodes.trim()) {
        body.allowedCountries = countryCodes
          .split(',')
          .map((s) => s.trim().toUpperCase())
          .filter((s) => s.length === 2);
        body.countryMode = countryMode;
      }
      if ((proofType === 'google_workspace' || proofType === 'microsoft_365' || proofType === 'workspace') && requiredDomain.trim()) {
        body.requiredDomain = requiredDomain.trim();
      }
      return client.post<CreateTopicResponse>('/api/topics', body);
    },
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['topics'] });
      navigation.replace('TopicDetail', { topicId: res.topic.id });
    },
    onError: (err: Error) => {
      Alert.alert(t('openstoa.topicCreate.createFailed'), err.message);
    },
  });

  const handleProofTypePress = (value: ProofType) => {
    setProofType(value);
  };

  const canSubmit =
    title.trim().length > 0 && !!categoryId && !createMutation.isPending;

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 88 : 0}
    >
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        {/* Title */}
        <Text style={styles.label}>
          {t('openstoa.topicCreate.title')} <Text style={styles.required}>*</Text>
        </Text>
        <TextInput
          style={styles.input}
          placeholder={t('openstoa.topicCreate.titlePlaceholder')}
          placeholderTextColor={colors.text.tertiary}
          value={title}
          onChangeText={(txt) => setTitle(txt.slice(0, 100))}
          maxLength={100}
          returnKeyType="next"
        />
        <Text style={styles.charCount}>{title.length}/100</Text>

        {/* Description */}
        <Text style={[styles.label, styles.labelSpaced]}>{t('openstoa.topicCreate.descriptionOptional')}</Text>
        <TextInput
          style={[styles.input, styles.multilineInput]}
          placeholder={t('openstoa.topicCreate.descriptionPlaceholder')}
          placeholderTextColor={colors.text.tertiary}
          value={description}
          onChangeText={setDescription}
          multiline
          textAlignVertical="top"
        />

        {/* Category picker */}
        <Text style={[styles.label, styles.labelSpaced]}>
          {t('openstoa.topicCreate.category')} <Text style={styles.required}>*</Text>
        </Text>
        {categoriesQuery.isLoading ? (
          <ActivityIndicator size="small" color={colors.brand.primary} />
        ) : (
          <View style={styles.pickerGroup}>
            {categories.map((cat) => {
              const isSelected = categoryId === cat.id;
              return (
                <TouchableOpacity
                  key={cat.id}
                  style={[styles.pickerOption, isSelected && styles.pickerOptionSelected]}
                  onPress={() => setCategoryId(cat.id)}
                  activeOpacity={0.7}
                >
                  <Text
                    style={[
                      styles.pickerOptionText,
                      isSelected && styles.pickerOptionTextSelected,
                    ]}
                  >
                    {cat.icon ? `${cat.icon}  ` : ''}{cat.name}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        )}

        {/* Visibility picker */}
        <Text style={[styles.label, styles.labelSpaced]}>{t('openstoa.topicCreate.visibility')}</Text>
        <View style={styles.pickerGroup}>
          {([
            { value: 'public' as const, label: t('openstoa.topicCreate.visibilityOptions.public'), desc: t('openstoa.topicCreate.visibilityOptions.publicDesc') },
            { value: 'private' as const, label: t('openstoa.topicCreate.visibilityOptions.private'), desc: t('openstoa.topicCreate.visibilityOptions.privateDesc'), wip: true },
            { value: 'secret' as const, label: t('openstoa.topicCreate.visibilityOptions.secret'), desc: t('openstoa.topicCreate.visibilityOptions.secretDesc'), wip: true },
          ]).map((opt) => {
            const isSelected = visibility === opt.value;
            return (
              <TouchableOpacity
                key={opt.value}
                style={[styles.pickerOption, isSelected && styles.pickerOptionSelected, opt.wip && { opacity: 0.55 }]}
                onPress={() => { if (!opt.wip) setVisibility(opt.value); }}
                activeOpacity={opt.wip ? 1 : 0.7}
              >
                <View style={{ flex: 1 }}>
                  <Text style={[styles.pickerOptionText, isSelected && styles.pickerOptionTextSelected]}>
                    {opt.label}
                  </Text>
                  <Text style={{ fontSize: 12, color: colors.text.tertiary, marginTop: 2 }}>{opt.desc}</Text>
                </View>
                {opt.wip ? (
                  <Text style={styles.wipBadge}>{t('openstoa.topicCreate.comingSoonShort')}</Text>
                ) : isSelected ? (
                  <Text style={{ fontSize: 14, color: colors.brand.primary }}>✓</Text>
                ) : null}
              </TouchableOpacity>
            );
          })}
        </View>

        {/* Proof type picker */}
        <Text style={[styles.label, styles.labelSpaced]}>{t('openstoa.topicCreate.proofType')}</Text>
        <View style={styles.pickerGroup}>
          {PROOF_TYPE_OPTIONS.map((opt) => {
            const isSelected = proofType === opt.value;
            return (
              <TouchableOpacity
                key={opt.value}
                style={[styles.pickerOption, isSelected && styles.pickerOptionSelected]}
                onPress={() => handleProofTypePress(opt.value)}
                activeOpacity={0.7}
              >
                <Text
                  style={[
                    styles.pickerOptionText,
                    isSelected && styles.pickerOptionTextSelected,
                  ]}
                >
                  {opt.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* Country-specific extra fields */}
        {proofType === 'country' && (
          <View style={{ marginTop: 12, gap: 10 }}>
            <Text style={styles.label}>{t('openstoa.topicCreate.countryMode')}</Text>
            <View style={styles.modeRow}>
              {(['include', 'exclude'] as const).map((mode) => (
                <TouchableOpacity
                  key={mode}
                  style={[styles.modeBtn, countryMode === mode ? styles.modeBtnActive : styles.modeBtnInactive]}
                  onPress={() => setCountryMode(mode)}
                  activeOpacity={0.7}
                >
                  <Text style={[styles.modeBtnText, { color: countryMode === mode ? colors.brand.primary : colors.text.secondary }]}>
                    {mode === 'include' ? t('openstoa.topicCreate.countryInclude') : t('openstoa.topicCreate.countryExclude')}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
            <Text style={[styles.label, { marginTop: 4 }]}>{t('openstoa.topicCreate.countryCodes')}</Text>
            <TextInput
              style={styles.extraInput}
              placeholder="US, KR, JP"
              placeholderTextColor={colors.text.tertiary}
              value={countryCodes}
              onChangeText={setCountryCodes}
              autoCapitalize="characters"
            />
          </View>
        )}

        {/* Workspace-specific extra fields */}
        {(proofType === 'google_workspace' || proofType === 'microsoft_365' || proofType === 'workspace') && (
          <View style={{ marginTop: 12, gap: 8 }}>
            <Text style={styles.label}>{t('openstoa.topicCreate.requiredDomain')}</Text>
            <TextInput
              style={styles.extraInput}
              placeholder="company.com"
              placeholderTextColor={colors.text.tertiary}
              value={requiredDomain}
              onChangeText={setRequiredDomain}
              autoCapitalize="none"
              keyboardType="url"
            />
            <Text style={styles.infoText}>{t('openstoa.topicCreate.domainHint')}</Text>
          </View>
        )}

        {/* Submit */}
        <TouchableOpacity
          style={[styles.submitButton, !canSubmit && styles.submitButtonDisabled]}
          onPress={() => createMutation.mutate()}
          disabled={!canSubmit}
          activeOpacity={0.8}
        >
          {createMutation.isPending ? (
            <ActivityIndicator size="small" color="#FFFFFF" />
          ) : (
            <Text style={styles.submitLabel}>{t('openstoa.topicCreate.submit')}</Text>
          )}
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
