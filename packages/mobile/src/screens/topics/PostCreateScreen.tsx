import React, { useCallback, useState } from 'react';
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  Image,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
// expo-image-picker is a native module — lazy-load to avoid crashing on
// stale Metro reloads where the native binary hasn't been rebuilt yet.
type ImagePickerModule = typeof import('expo-image-picker');
function loadImagePicker(): ImagePickerModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('expo-image-picker') as ImagePickerModule;
  } catch {
    return null;
  }
}
import { useTranslation } from 'react-i18next';
import { useNavigation, useRoute } from '@react-navigation/native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { NativeStackNavigationProp, NativeStackScreenProps } from '@react-navigation/native-stack';
import type { Post } from '@openstoa/api-types';
import { useOpenStoaClient } from '../../hooks/useOpenStoaClient';
import { useThemeColors } from '../../theme/ThemeContext';
import type { ThemeColors } from '../../theme/colors';
import type { TopicsStackParamList } from '../../navigation/stacks/TopicsStack';

type Props = NativeStackScreenProps<TopicsStackParamList, 'PostCreate'>;
type Nav = NativeStackNavigationProp<TopicsStackParamList, 'PostCreate'>;

const MAX_TAGS = 5;
const NICKNAME_RE = /^[a-zA-Z0-9_]{1,30}$/;

interface CreatePostBody {
  title: string;
  content: string;
  tags?: string[];
  media?: { images?: string[] };
}

interface CreatePostResponse {
  post: Post;
}

interface TagSuggestion {
  name: string;
  slug: string;
  postCount: number;
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
    topicLabel: {
      fontSize: 12,
      fontWeight: '600',
      color: colors.brand.primary,
      marginBottom: 16,
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
    bodyInput: {
      minHeight: 200,
      paddingTop: 12,
    },
    // Tag chips
    tagRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 6,
      borderWidth: 1,
      borderColor: colors.border.default,
      borderRadius: 10,
      paddingHorizontal: 10,
      paddingVertical: 8,
      backgroundColor: colors.background.secondary,
      minHeight: 44,
      alignItems: 'center',
    },
    tagChip: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: colors.brand.primaryMuted,
      borderRadius: 4,
      paddingHorizontal: 8,
      paddingVertical: 3,
      gap: 4,
    },
    tagChipText: {
      fontSize: 13,
      color: colors.brand.primary,
      fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    },
    tagRemove: {
      fontSize: 14,
      color: colors.text.tertiary,
      lineHeight: 16,
    },
    tagInput: {
      flex: 1,
      minWidth: 80,
      fontSize: 14,
      color: colors.text.primary,
      paddingVertical: 0,
      height: 28,
    },
    tagHint: {
      fontSize: 11,
      color: colors.text.tertiary,
      marginTop: 4,
      fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    },
    // Tag suggestions dropdown
    suggestionsBox: {
      borderWidth: 1,
      borderColor: colors.border.default,
      borderRadius: 8,
      backgroundColor: colors.background.secondary,
      marginTop: 2,
      overflow: 'hidden',
    },
    suggestionRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      paddingHorizontal: 12,
      paddingVertical: 9,
    },
    suggestionName: {
      fontSize: 13,
      color: colors.text.primary,
      fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    },
    suggestionCount: {
      fontSize: 11,
      color: colors.text.tertiary,
      fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    },
    // Image attachments
    imageStrip: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 8,
      marginTop: 8,
    },
    imageThumb: {
      width: 72,
      height: 72,
      borderRadius: 8,
      backgroundColor: colors.background.tertiary,
    },
    imageRemoveBtn: {
      position: 'absolute',
      top: -6,
      right: -6,
      width: 20,
      height: 20,
      borderRadius: 10,
      backgroundColor: colors.status.danger,
      alignItems: 'center',
      justifyContent: 'center',
    },
    imageRemoveText: {
      color: '#FFFFFF',
      fontSize: 12,
      fontWeight: '700',
      lineHeight: 14,
    },
    imageThumbWrap: {
      position: 'relative',
    },
    attachButton: {
      width: 72,
      height: 72,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: colors.border.default,
      borderStyle: 'dashed',
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.background.secondary,
    },
    attachLabel: {
      fontSize: 26,
      color: colors.text.tertiary,
      lineHeight: 30,
    },
    attachHint: {
      fontSize: 10,
      color: colors.text.tertiary,
      marginTop: 2,
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
  });
}

export function PostCreateScreen() {
  const { t } = useTranslation();
  const navigation = useNavigation<Nav>();
  const route = useRoute<Props['route']>();
  const { topicId, topicTitle } = route.params;
  const client = useOpenStoaClient();
  const queryClient = useQueryClient();
  const { colors } = useThemeColors();
  const styles = makeStyles(colors);

  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [images, setImages] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);

  // Tag autocomplete
  const tagQuery = useQuery<{ tags: TagSuggestion[] }>({
    queryKey: ['tags', topicId, tagInput],
    queryFn: () =>
      client.get<{ tags: TagSuggestion[] }>(
        `/api/tags?topicId=${topicId}&q=${encodeURIComponent(tagInput.trim().toLowerCase())}`,
      ),
    enabled: tagInput.trim().length >= 1,
    staleTime: 30_000,
  });

  const suggestions = (tagQuery.data?.tags ?? []).filter(
    (s) => !tags.some((t) => t.toLowerCase() === s.name.toLowerCase()),
  );

  const addTag = useCallback(
    (name: string) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      if (tags.length >= MAX_TAGS) return;
      if (!NICKNAME_RE.test(trimmed)) return;
      if (tags.some((t) => t.toLowerCase() === trimmed.toLowerCase())) return;
      setTags((prev) => [...prev, trimmed]);
      setTagInput('');
      setShowSuggestions(false);
    },
    [tags],
  );

  const removeTag = useCallback((index: number) => {
    setTags((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleTagKeyPress = useCallback(
    (key: string) => {
      if ((key === 'Enter' || key === ',') && tagInput.trim()) {
        addTag(tagInput);
      }
    },
    [tagInput, addTag],
  );

  // Image attach
  const pickFromLibrary = useCallback(async () => {
    const ImagePicker = loadImagePicker();
    if (!ImagePicker) {
      Alert.alert('Image picker unavailable', 'The host app needs to be rebuilt to include expo-image-picker.');
      return;
    }
    const { granted } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!granted) return;
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.8,
      allowsEditing: false,
    });
    if (result.canceled || !result.assets[0]) return;
    const uri = result.assets[0].uri;
    setUploading(true);
    try {
      const publicUrl = await client.uploadFile(uri);
      setImages((prev) => [...prev, publicUrl]);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      Alert.alert('Upload failed', msg);
    } finally {
      setUploading(false);
    }
  }, [client]);

  const openAttachSheet = useCallback(() => {
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        { options: ['Cancel', 'Photo library'], cancelButtonIndex: 0 },
        (buttonIndex) => {
          if (buttonIndex === 1) pickFromLibrary();
        },
      );
    } else {
      Alert.alert('Attach image', undefined, [
        { text: 'Photo library', onPress: pickFromLibrary },
        { text: 'Cancel', style: 'cancel' },
      ]);
    }
  }, [pickFromLibrary]);

  const removeImage = useCallback((index: number) => {
    setImages((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const createMutation = useMutation({
    mutationFn: async () => {
      const body: CreatePostBody = {
        title: title.trim(),
        content: content.trim(),
      };
      if (tags.length > 0) body.tags = tags;
      if (images.length > 0) body.media = { images };
      return client.post<CreatePostResponse>(`/api/topics/${topicId}/posts`, body);
    },
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['topic', topicId, 'posts'] });
      navigation.replace('PostDetail', { postId: res.post.id });
    },
    onError: (err: Error) => {
      Alert.alert(t('openstoa.postCreate.failed'), err.message);
    },
  });

  const canSubmit =
    title.trim().length > 0 &&
    content.trim().length > 0 &&
    !createMutation.isPending &&
    !uploading;

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
        {topicTitle ? (
          <Text style={styles.topicLabel}>{topicTitle}</Text>
        ) : null}

        {/* Title */}
        <Text style={styles.label}>
          {t('openstoa.postCreate.title')} <Text style={styles.required}>*</Text>
        </Text>
        <TextInput
          style={styles.input}
          placeholder={t('openstoa.postCreate.titlePlaceholder')}
          placeholderTextColor={colors.text.tertiary}
          value={title}
          onChangeText={setTitle}
          returnKeyType="next"
        />

        {/* Content */}
        <Text style={[styles.label, styles.labelSpaced]}>
          {t('openstoa.postCreate.body')} <Text style={styles.required}>*</Text>
        </Text>
        <TextInput
          style={[styles.input, styles.bodyInput]}
          placeholder={t('openstoa.postCreate.bodyPlaceholder')}
          placeholderTextColor={colors.text.tertiary}
          value={content}
          onChangeText={setContent}
          multiline
          textAlignVertical="top"
        />

        {/* Tags */}
        <Text style={[styles.label, styles.labelSpaced]}>
          Tags
        </Text>
        <View style={styles.tagRow}>
          {tags.map((tag, i) => (
            <View key={tag} style={styles.tagChip}>
              <Text style={styles.tagChipText}>{tag}</Text>
              <TouchableOpacity onPress={() => removeTag(i)} hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}>
                <Text style={styles.tagRemove}>×</Text>
              </TouchableOpacity>
            </View>
          ))}
          {tags.length < MAX_TAGS ? (
            <TextInput
              style={styles.tagInput}
              value={tagInput}
              onChangeText={(v) => {
                setTagInput(v);
                setShowSuggestions(v.trim().length >= 1);
              }}
              placeholder={tags.length === 0 ? 'Add tags…' : ''}
              placeholderTextColor={colors.text.tertiary}
              onSubmitEditing={() => addTag(tagInput)}
              onKeyPress={({ nativeEvent }) => handleTagKeyPress(nativeEvent.key)}
              blurOnSubmit={false}
              returnKeyType="done"
              autoCapitalize="none"
              autoCorrect={false}
            />
          ) : null}
        </View>
        {showSuggestions && suggestions.length > 0 ? (
          <View style={styles.suggestionsBox}>
            {suggestions.slice(0, 5).map((s) => (
              <TouchableOpacity
                key={s.slug}
                style={styles.suggestionRow}
                onPress={() => addTag(s.name)}
              >
                <Text style={styles.suggestionName}>{s.name}</Text>
                <Text style={styles.suggestionCount}>{s.postCount} posts</Text>
              </TouchableOpacity>
            ))}
          </View>
        ) : null}
        <Text style={styles.tagHint}>
          {tags.length}/{MAX_TAGS} · press Enter or comma to add
        </Text>

        {/* Images */}
        <Text style={[styles.label, styles.labelSpaced]}>
          Images
        </Text>
        <View style={styles.imageStrip}>
          {images.map((uri, i) => (
            <View key={uri} style={styles.imageThumbWrap}>
              <Image source={{ uri }} style={styles.imageThumb} />
              <TouchableOpacity
                style={styles.imageRemoveBtn}
                onPress={() => removeImage(i)}
              >
                <Text style={styles.imageRemoveText}>×</Text>
              </TouchableOpacity>
            </View>
          ))}
          {images.length < 4 ? (
            <TouchableOpacity
              style={styles.attachButton}
              onPress={openAttachSheet}
              disabled={uploading}
              activeOpacity={0.7}
            >
              {uploading ? (
                <ActivityIndicator size="small" color={colors.text.tertiary} />
              ) : (
                <>
                  <Text style={styles.attachLabel}>+</Text>
                  <Text style={styles.attachHint}>photo</Text>
                </>
              )}
            </TouchableOpacity>
          ) : null}
        </View>

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
            <Text style={styles.submitLabel}>{t('openstoa.postCreate.submit')}</Text>
          )}
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
