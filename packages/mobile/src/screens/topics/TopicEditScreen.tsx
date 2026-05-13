import React, { useEffect, useLayoutEffect, useState } from 'react';
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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigation, useRoute } from '@react-navigation/native';
import type { NativeStackNavigationProp, NativeStackScreenProps } from '@react-navigation/native-stack';
import type { Topic } from '@openstoa/api-types';
import { useOpenStoaClient } from '../../hooks/useOpenStoaClient';
import { useThemeColors } from '../../theme/ThemeContext';
import type { ThemeColors } from '../../theme/colors';
import type { TopicsStackParamList } from '../../navigation/stacks/TopicsStack';

type Props = NativeStackScreenProps<TopicsStackParamList, 'TopicEdit'>;
type Nav = NativeStackNavigationProp<TopicsStackParamList, 'TopicEdit'>;

interface TopicDetailResponse {
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
    centered: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.background.primary,
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
    input: {
      borderWidth: 1,
      borderColor: colors.border.default,
      borderRadius: 10,
      paddingHorizontal: 14,
      paddingVertical: 12,
      fontSize: 15,
      color: colors.text.primary,
      backgroundColor: colors.background.secondary,
      minHeight: 44,
    },
    multilineInput: {
      minHeight: 120,
      paddingTop: 12,
    },
    charCount: {
      fontSize: 11,
      color: colors.text.tertiary,
      textAlign: 'right',
      marginTop: 4,
    },
    submitButton: {
      marginTop: 32,
      backgroundColor: colors.brand.primary,
      borderRadius: 12,
      paddingVertical: 14,
      alignItems: 'center',
      minHeight: 48,
      justifyContent: 'center',
    },
    submitButtonDisabled: {
      opacity: 0.5,
    },
    submitLabel: {
      fontSize: 16,
      fontWeight: '700',
      color: '#FFFFFF',
    },
    deleteButton: {
      marginTop: 16,
      borderWidth: 1,
      borderColor: colors.status.danger,
      borderRadius: 12,
      paddingVertical: 14,
      alignItems: 'center',
      minHeight: 48,
      justifyContent: 'center',
    },
    deleteLabel: {
      fontSize: 16,
      fontWeight: '600',
      color: colors.status.danger,
    },
  });
}

export function TopicEditScreen() {
  const { t } = useTranslation();
  const route = useRoute<Props['route']>();
  const navigation = useNavigation<Nav>();
  const { topicId } = route.params;
  const client = useOpenStoaClient();
  const queryClient = useQueryClient();
  const { colors } = useThemeColors();
  const styles = makeStyles(colors);

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [hydrated, setHydrated] = useState(false);

  useLayoutEffect(() => {
    navigation.setOptions({ title: t('openstoa.topicEdit.title') });
  }, [navigation, t]);

  const topicQuery = useQuery<TopicDetailResponse>({
    queryKey: ['topic', topicId],
    queryFn: () => client.get<TopicDetailResponse>(`/api/topics/${topicId}`),
  });

  useEffect(() => {
    if (topicQuery.data && !hydrated) {
      setTitle(topicQuery.data.topic.title);
      setDescription(topicQuery.data.topic.description ?? '');
      setHydrated(true);
    }
  }, [topicQuery.data, hydrated]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      return client.patch<TopicDetailResponse>(`/api/topics/${topicId}`, {
        title: title.trim(),
        description: description.trim() ? description.trim() : null,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['topic', topicId] });
      queryClient.invalidateQueries({ queryKey: ['topics'] });
      navigation.goBack();
    },
    onError: (err: Error) => {
      Alert.alert(t('openstoa.topicEdit.saveFailed'), err.message);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      return client.delete(`/api/topics/${topicId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['topics'] });
      queryClient.removeQueries({ queryKey: ['topic', topicId] });
      // Navigate back to topics home
      navigation.navigate('TopicsHome');
    },
    onError: (err: Error) => {
      Alert.alert(t('openstoa.topicEdit.saveFailed'), err.message);
    },
  });

  const handleDelete = () => {
    Alert.alert(
      t('openstoa.topicEdit.deleteTopic'),
      t('openstoa.topicEdit.deleteConfirm'),
      [
        { text: t('openstoa.common.cancel'), style: 'cancel' },
        {
          text: t('openstoa.common.delete'),
          style: 'destructive',
          onPress: () => deleteMutation.mutate(),
        },
      ],
    );
  };

  const canSubmit = title.trim().length > 0 && !saveMutation.isPending && hydrated;

  if (topicQuery.isLoading || !hydrated) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={colors.brand.primary} />
      </View>
    );
  }

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
        <Text style={styles.label}>{t('openstoa.topicEdit.titleField')}</Text>
        <TextInput
          style={styles.input}
          value={title}
          onChangeText={(txt) => setTitle(txt.slice(0, 100))}
          maxLength={100}
          returnKeyType="next"
          placeholderTextColor={colors.text.tertiary}
        />
        <Text style={styles.charCount}>{title.length}/100</Text>

        <Text style={[styles.label, styles.labelSpaced]}>{t('openstoa.topicEdit.descriptionField')}</Text>
        <TextInput
          style={[styles.input, styles.multilineInput]}
          value={description}
          onChangeText={setDescription}
          multiline
          textAlignVertical="top"
          placeholderTextColor={colors.text.tertiary}
        />

        <TouchableOpacity
          style={[styles.submitButton, !canSubmit && styles.submitButtonDisabled]}
          onPress={() => saveMutation.mutate()}
          disabled={!canSubmit}
          activeOpacity={0.8}
        >
          {saveMutation.isPending ? (
            <ActivityIndicator size="small" color="#FFFFFF" />
          ) : (
            <Text style={styles.submitLabel}>{t('openstoa.topicEdit.save')}</Text>
          )}
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.deleteButton}
          onPress={handleDelete}
          disabled={deleteMutation.isPending}
          activeOpacity={0.8}
        >
          {deleteMutation.isPending ? (
            <ActivityIndicator size="small" color={colors.status.danger} />
          ) : (
            <Text style={styles.deleteLabel}>{t('openstoa.topicEdit.deleteTopic')}</Text>
          )}
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
