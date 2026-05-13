import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import Feather from 'react-native-vector-icons/Feather';
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
import { PostContent } from '../../components/PostContent';
import { MediaGallery } from '../../components/MediaGallery';
import { PollEditor, type PollEditorValue } from '../../components/PollEditor';
import { useDraft } from '../../hooks/useDraft';

type Props = NativeStackScreenProps<TopicsStackParamList, 'PostCreate'>;
type Nav = NativeStackNavigationProp<TopicsStackParamList, 'PostCreate'>;

const MAX_TAGS = 5;
const MAX_IMAGES = 4;
const MAX_VIDEOS = 4;
// Tags accept Korean, Latin letters, digits, and underscore. The server-side
// slug pipeline (api/topics/[topicId]/posts) downcases and rewrites the
// remainder, so we don't need to be strict here — just bound the length and
// reject anything that's pure whitespace.
const TAG_MAX_LEN = 30;

interface CreatePostBody {
  title: string;
  content: string;
  tags?: string[];
  media?: { images?: string[]; videos?: string[] };
  poll?: {
    question?: string;
    options: string[];
    multipleChoice?: boolean;
    closesAt?: string;
  };
}

interface CreatePostResponse {
  post: Post;
}

interface TagSuggestion {
  name: string;
  slug: string;
  postCount: number;
}

interface DraftState {
  title: string;
  content: string;
  tags: string[];
  images: string[];
  videos: string[];
  poll: PollEditorValue | null;
}

interface VideoMeta {
  url: string;
  type: 'youtube' | 'vimeo';
  videoId: string;
  label: string;
}

const YOUTUBE_PATTERNS = [
  /^(?:https?:\/\/)?(?:www\.|m\.)?youtube\.com\/watch\?[^\s]*v=([a-zA-Z0-9_-]{11})/,
  /^(?:https?:\/\/)?youtu\.be\/([a-zA-Z0-9_-]{11})/,
  /^(?:https?:\/\/)?(?:www\.|m\.)?youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/,
];
const VIMEO_PATTERN = /^(?:https?:\/\/)?(?:www\.)?vimeo\.com\/(\d+)/;

function parseVideoUrl(raw: string): VideoMeta | null {
  const url = raw.trim();
  if (!url) return null;
  for (const re of YOUTUBE_PATTERNS) {
    const m = re.exec(url);
    if (m) {
      return { url, type: 'youtube', videoId: m[1], label: `YouTube · ${m[1]}` };
    }
  }
  const vm = VIMEO_PATTERN.exec(url);
  if (vm) {
    return { url, type: 'vimeo', videoId: vm[1], label: `Vimeo · ${vm[1]}` };
  }
  return null;
}

function videosToMeta(urls: string[]): VideoMeta[] {
  return urls.map((u) => parseVideoUrl(u)).filter((v): v is VideoMeta => v !== null);
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    flex: { flex: 1, backgroundColor: colors.background.primary },
    scroll: { flex: 1 },
    content: { padding: 20, paddingBottom: 40 },
    topicLabel: {
      fontSize: 12,
      fontWeight: '600',
      color: colors.brand.primary,
      marginBottom: 12,
    },
    // Segmented control
    segmentRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      marginBottom: 18,
    },
    segment: {
      flex: 1,
      flexDirection: 'row',
      borderWidth: 1,
      borderColor: colors.border.default,
      borderRadius: 10,
      overflow: 'hidden',
    },
    resetBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      paddingHorizontal: 10,
      paddingVertical: 8,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: colors.border.default,
      backgroundColor: colors.background.secondary,
    },
    resetBtnLabel: {
      fontSize: 12,
      color: colors.text.tertiary,
    },
    segmentItem: {
      flex: 1,
      paddingVertical: 9,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.background.secondary,
    },
    segmentItemActive: {
      backgroundColor: colors.brand.primary,
    },
    segmentLabel: {
      fontSize: 13,
      fontWeight: '600',
      color: colors.text.secondary,
    },
    segmentLabelActive: {
      color: '#FFFFFF',
    },
    label: {
      fontSize: 13,
      fontWeight: '600',
      color: colors.text.secondary,
      marginBottom: 6,
    },
    labelSpaced: { marginTop: 20 },
    required: { color: colors.status.danger },
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
    // Bottom toolbar under body
    bodyToolbar: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      marginTop: 8,
    },
    toolbarBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      paddingHorizontal: 10,
      paddingVertical: 6,
      borderRadius: 8,
      backgroundColor: colors.background.secondary,
      borderWidth: 1,
      borderColor: colors.border.default,
    },
    toolbarBtnLabel: {
      fontSize: 12,
      color: colors.text.secondary,
    },
    toolbarFlex: { flex: 1 },
    charCount: {
      fontSize: 11,
      color: colors.text.tertiary,
      fontVariantNumeric: 'tabular-nums',
    },
    draftSaved: {
      fontSize: 11,
      color: colors.text.tertiary,
      marginRight: 8,
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
    tagRemove: { fontSize: 14, color: colors.text.tertiary, lineHeight: 16 },
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
    imageThumbWrap: { position: 'relative' },
    // Video chips
    videoChipRow: {
      flexDirection: 'column',
      gap: 6,
      marginTop: 8,
    },
    videoChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingHorizontal: 10,
      paddingVertical: 8,
      borderRadius: 8,
      backgroundColor: colors.background.secondary,
      borderWidth: 1,
      borderColor: colors.border.default,
    },
    videoChipLabel: {
      fontSize: 12,
      color: colors.text.secondary,
      flex: 1,
      fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    },
    videoChipRemove: {
      paddingHorizontal: 4,
    },
    submitButton: {
      marginTop: 32,
      backgroundColor: colors.brand.primary,
      borderRadius: 12,
      paddingVertical: 14,
      alignItems: 'center',
    },
    submitButtonDisabled: { opacity: 0.5 },
    submitLabel: { fontSize: 16, fontWeight: '700', color: '#FFFFFF' },
    // Modal
    modalOverlay: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.6)',
      justifyContent: 'center',
      paddingHorizontal: 24,
    },
    modalCard: {
      backgroundColor: colors.background.primary,
      borderRadius: 14,
      padding: 20,
      gap: 12,
    },
    modalTitle: {
      fontSize: 16,
      fontWeight: '700',
      color: colors.text.primary,
    },
    modalInput: {
      borderWidth: 1,
      borderColor: colors.border.default,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 10,
      fontSize: 14,
      color: colors.text.primary,
      backgroundColor: colors.background.secondary,
    },
    modalError: {
      fontSize: 12,
      color: colors.status.danger,
    },
    modalButtons: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      gap: 10,
      marginTop: 4,
    },
    modalBtnText: {
      paddingHorizontal: 14,
      paddingVertical: 8,
      borderRadius: 8,
    },
    modalBtnCancel: {
      backgroundColor: colors.background.secondary,
    },
    modalBtnAdd: {
      backgroundColor: colors.brand.primary,
    },
    modalBtnCancelLabel: {
      color: colors.text.secondary,
      fontSize: 13,
      fontWeight: '600',
    },
    modalBtnAddLabel: {
      color: '#FFFFFF',
      fontSize: 13,
      fontWeight: '700',
    },
    // Preview
    previewTitle: {
      fontSize: 22,
      fontWeight: '700',
      color: colors.text.primary,
      marginBottom: 10,
    },
    previewPollCard: {
      marginTop: 12,
      padding: 12,
      borderWidth: 1,
      borderColor: colors.border.default,
      borderRadius: 10,
      backgroundColor: colors.background.secondary,
      gap: 8,
    },
    previewPollQuestion: {
      fontSize: 14,
      fontWeight: '600',
      color: colors.text.primary,
    },
    previewPollOption: {
      paddingVertical: 8,
      paddingHorizontal: 10,
      borderWidth: 1,
      borderColor: colors.border.default,
      borderRadius: 8,
      backgroundColor: colors.background.primary,
    },
    previewPollOptionText: {
      fontSize: 13,
      color: colors.text.primary,
    },
    previewPollMeta: {
      fontSize: 11,
      color: colors.text.tertiary,
      marginTop: 4,
    },
    previewTagsRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 6,
      marginTop: 18,
    },
    previewTagChip: {
      backgroundColor: colors.brand.primaryMuted,
      borderRadius: 4,
      paddingHorizontal: 8,
      paddingVertical: 3,
    },
    previewTagChipText: {
      fontSize: 12,
      color: colors.brand.primary,
      fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    },
    previewEmpty: {
      fontSize: 13,
      color: colors.text.tertiary,
      paddingVertical: 40,
      textAlign: 'center',
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

  const [mode, setMode] = useState<'write' | 'preview'>('write');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [images, setImages] = useState<string[]>([]);
  const [videos, setVideos] = useState<string[]>([]);
  const [poll, setPoll] = useState<PollEditorValue | null>(null);
  const [uploading, setUploading] = useState(false);
  const [showVideoModal, setShowVideoModal] = useState(false);
  const [videoInput, setVideoInput] = useState('');
  const [videoError, setVideoError] = useState('');

  // Draft persistence. Hydrate on first mount; never overwrite after.
  const draftKey = `openstoa.postCreate.${topicId}`;
  const { loaded: loadedDraft, hydrated, saved: draftSaved, save: persistDraft, clear: clearDraft } =
    useDraft<DraftState>(draftKey);
  const hydratedOnce = useRef(false);
  useEffect(() => {
    if (!hydrated || hydratedOnce.current) return;
    hydratedOnce.current = true;
    if (loadedDraft) {
      setTitle(loadedDraft.title ?? '');
      setContent(loadedDraft.content ?? '');
      setTags(loadedDraft.tags ?? []);
      setImages(loadedDraft.images ?? []);
      setVideos(loadedDraft.videos ?? []);
      setPoll(loadedDraft.poll ?? null);
    }
  }, [hydrated, loadedDraft]);

  // Persist draft whenever any of the user-editable fields change.
  useEffect(() => {
    if (!hydrated) return;
    persistDraft({ title, content, tags, images, videos, poll });
  }, [hydrated, title, content, tags, images, videos, poll, persistDraft]);

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
      const trimmed = name.trim().slice(0, TAG_MAX_LEN);
      if (!trimmed) return;
      if (tags.length >= MAX_TAGS) return;
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

  // Video attach
  const openVideoModal = useCallback(() => {
    if (videos.length >= MAX_VIDEOS) return;
    setVideoInput('');
    setVideoError('');
    setShowVideoModal(true);
  }, [videos.length]);

  const submitVideo = useCallback(() => {
    const meta = parseVideoUrl(videoInput);
    if (!meta) {
      setVideoError(t('openstoa.postCreate.videoInvalid'));
      return;
    }
    if (videos.some((v) => v === meta.url)) {
      setShowVideoModal(false);
      return;
    }
    setVideos((prev) => [...prev, meta.url]);
    setShowVideoModal(false);
  }, [videoInput, videos, t]);

  const removeVideo = useCallback((index: number) => {
    setVideos((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const createMutation = useMutation({
    mutationFn: async () => {
      const body: CreatePostBody = {
        title: title.trim(),
        content: content.trim(),
      };
      if (tags.length > 0) body.tags = tags;
      if (images.length > 0 || videos.length > 0) {
        body.media = {};
        if (images.length > 0) body.media.images = images;
        if (videos.length > 0) body.media.videos = videos;
      }
      if (poll && poll.options.filter((o) => o.trim().length > 0).length >= 2) {
        body.poll = {
          question: poll.question?.trim() || undefined,
          options: poll.options.map((o) => o.trim()).filter((o) => o.length > 0),
          multipleChoice: poll.multipleChoice,
          closesAt: poll.closesAt ?? undefined,
        };
      }
      return client.post<CreatePostResponse>(`/api/topics/${topicId}/posts`, body);
    },
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['topic', topicId, 'posts'] });
      clearDraft();
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

  const videoMetas = useMemo(() => videosToMeta(videos), [videos]);

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
        {topicTitle ? <Text style={styles.topicLabel}>{topicTitle}</Text> : null}

        {/* Write / Preview segment + Reset button */}
        <View style={styles.segmentRow}>
          <View style={styles.segment}>
            <Pressable
              style={[styles.segmentItem, mode === 'write' && styles.segmentItemActive]}
              onPress={() => setMode('write')}
            >
              <Text style={[styles.segmentLabel, mode === 'write' && styles.segmentLabelActive]}>
                {t('openstoa.postCreate.write')}
              </Text>
            </Pressable>
            <Pressable
              style={[styles.segmentItem, mode === 'preview' && styles.segmentItemActive]}
              onPress={() => {
                // Commit any half-typed tag so the user's last keystrokes
                // before tapping Preview don't get dropped.
                if (tagInput.trim()) addTag(tagInput);
                setMode('preview');
              }}
            >
              <Text style={[styles.segmentLabel, mode === 'preview' && styles.segmentLabelActive]}>
                {t('openstoa.postCreate.preview')}
              </Text>
            </Pressable>
          </View>
          <TouchableOpacity
            style={styles.resetBtn}
            onPress={() => {
              const hasContent =
                title.trim() || content.trim() || tags.length > 0 ||
                images.length > 0 || videos.length > 0 || !!poll;
              if (!hasContent) return;
              Alert.alert(
                t('openstoa.postCreate.resetTitle'),
                t('openstoa.postCreate.resetMessage'),
                [
                  { text: t('openstoa.common.cancel'), style: 'cancel' },
                  {
                    text: t('openstoa.postCreate.resetConfirm'),
                    style: 'destructive',
                    onPress: () => {
                      setTitle('');
                      setContent('');
                      setTags([]);
                      setTagInput('');
                      setImages([]);
                      setVideos([]);
                      setPoll(null);
                      void clearDraft();
                    },
                  },
                ],
              );
            }}
            hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
          >
            <Feather name="refresh-ccw" size={14} color={colors.text.tertiary} />
            <Text style={styles.resetBtnLabel}>{t('openstoa.postCreate.reset')}</Text>
          </TouchableOpacity>
        </View>

        {mode === 'write' ? (
          <>
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

            {/* Body */}
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

            {/* Bottom toolbar — photo, video, char counter */}
            <View style={styles.bodyToolbar}>
              <TouchableOpacity
                style={styles.toolbarBtn}
                onPress={openAttachSheet}
                disabled={uploading || images.length >= MAX_IMAGES}
                activeOpacity={0.7}
              >
                {uploading ? (
                  <ActivityIndicator size="small" color={colors.text.tertiary} />
                ) : (
                  <Feather name="image" size={14} color={colors.text.secondary} />
                )}
                <Text style={styles.toolbarBtnLabel}>{t('openstoa.postCreate.addPhoto')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.toolbarBtn}
                onPress={openVideoModal}
                disabled={videos.length >= MAX_VIDEOS}
                activeOpacity={0.7}
              >
                <Feather name="video" size={14} color={colors.text.secondary} />
                <Text style={styles.toolbarBtnLabel}>{t('openstoa.postCreate.addVideo')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.toolbarBtn}
                onPress={() => {
                  if (poll) {
                    setPoll(null);
                  } else {
                    setPoll({ options: ['', ''], multipleChoice: false, closesAt: null });
                  }
                }}
                activeOpacity={0.7}
              >
                <Feather name="bar-chart-2" size={14} color={poll ? colors.brand.primary : colors.text.secondary} />
                <Text style={[styles.toolbarBtnLabel, poll ? { color: colors.brand.primary } : null]}>
                  {t('openstoa.postCreate.addPoll')}
                </Text>
              </TouchableOpacity>
              <View style={styles.toolbarFlex} />
              {draftSaved ? (
                <Text style={styles.draftSaved}>{t('openstoa.postCreate.draftSaved')}</Text>
              ) : null}
              <Text style={styles.charCount}>
                {t('openstoa.postCreate.charCount', { n: content.length })}
              </Text>
            </View>

            {/* Image strip */}
            {images.length > 0 ? (
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
              </View>
            ) : null}

            {/* Video chips */}
            {videoMetas.length > 0 ? (
              <View style={styles.videoChipRow}>
                {videoMetas.map((v, i) => (
                  <View key={v.url} style={styles.videoChip}>
                    <Feather
                      name={v.type === 'youtube' ? 'youtube' : 'video'}
                      size={14}
                      color={colors.text.secondary}
                    />
                    <Text style={styles.videoChipLabel} numberOfLines={1}>
                      {v.label}
                    </Text>
                    <TouchableOpacity
                      style={styles.videoChipRemove}
                      onPress={() => removeVideo(i)}
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    >
                      <Feather name="x" size={14} color={colors.text.tertiary} />
                    </TouchableOpacity>
                  </View>
                ))}
              </View>
            ) : null}

            {/* Poll editor */}
            {poll ? (
              <PollEditor value={poll} onChange={setPoll} onRemove={() => setPoll(null)} />
            ) : null}

            {/* Tags */}
            <Text style={[styles.label, styles.labelSpaced]}>Tags</Text>
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
                    // Detect comma from the text itself rather than from
                    // onKeyPress — RN's onKeyPress closure on iOS lags one
                    // keystroke behind the state, so relying on it was
                    // missing the just-typed comma's value.
                    if (v.includes(',')) {
                      const parts = v.split(',');
                      const head = parts.slice(0, -1).join(',').trim();
                      if (head) addTag(head);
                      setTagInput(parts[parts.length - 1].trim());
                      return;
                    }
                    setTagInput(v);
                    setShowSuggestions(v.trim().length >= 1);
                  }}
                  placeholder={tags.length === 0 ? 'Add tags…' : ''}
                  placeholderTextColor={colors.text.tertiary}
                  onSubmitEditing={() => {
                    if (tagInput.trim()) addTag(tagInput);
                  }}
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

          </>
        ) : (
          <PreviewBlock
            title={title}
            content={content}
            images={images}
            videos={videoMetas}
            poll={poll}
            tags={tags}
            styles={styles}
            colors={colors}
            emptyLabel={t('openstoa.postCreate.previewEmpty')}
          />
        )}

        {/* Submit lives outside the Write/Preview switch so the user can
            post directly from the Preview screen too — no round-trip back
            to Write just to tap submit. */}
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

      <Modal
        animationType="fade"
        transparent
        visible={showVideoModal}
        onRequestClose={() => setShowVideoModal(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>{t('openstoa.postCreate.videoLink')}</Text>
            <TextInput
              style={styles.modalInput}
              placeholder={t('openstoa.postCreate.videoUrlPlaceholder')}
              placeholderTextColor={colors.text.tertiary}
              value={videoInput}
              onChangeText={(v) => {
                setVideoInput(v);
                if (videoError) setVideoError('');
              }}
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus
              keyboardType="url"
              onSubmitEditing={submitVideo}
            />
            {videoError ? <Text style={styles.modalError}>{videoError}</Text> : null}
            <View style={styles.modalButtons}>
              <TouchableOpacity
                style={[styles.modalBtnText, styles.modalBtnCancel]}
                onPress={() => setShowVideoModal(false)}
              >
                <Text style={styles.modalBtnCancelLabel}>{t('openstoa.postCreate.videoCancel')}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.modalBtnText, styles.modalBtnAdd]} onPress={submitVideo}>
                <Text style={styles.modalBtnAddLabel}>{t('openstoa.postCreate.videoAdd')}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </KeyboardAvoidingView>
  );
}

interface PreviewBlockProps {
  title: string;
  content: string;
  images: string[];
  videos: VideoMeta[];
  poll: PollEditorValue | null;
  tags: string[];
  styles: ReturnType<typeof makeStyles>;
  emptyLabel: string;
  colors: ThemeColors;
}

function PreviewBlock({ title, content, images, videos, poll, tags, styles, emptyLabel, colors }: PreviewBlockProps) {
  const hasAny =
    title.trim() ||
    content.trim() ||
    images.length > 0 ||
    videos.length > 0 ||
    tags.length > 0 ||
    !!poll;
  if (!hasAny) {
    return <Text style={styles.previewEmpty}>{emptyLabel}</Text>;
  }
  const pollOptions = poll
    ? poll.options.map((o) => o.trim()).filter((o) => o.length > 0)
    : [];
  return (
    <View>
      {/* Order picked by the user: Title → Body → Media → Poll → Tags
          (Twitter/X model). The same ordering is mirrored in the feed
          PostCard and PostDetailScreen so what the user sees in Preview
          matches the live post pixel-for-pixel. */}
      {title.trim() ? <Text style={styles.previewTitle}>{title}</Text> : null}
      {content.trim() ? <PostContent content={content} /> : null}
      <MediaGallery
        images={images}
        videos={videos.map((v) => v.url)}
        mode="detail"
      />
      {poll && pollOptions.length >= 2 ? (
        <View style={styles.previewPollCard}>
          {poll.question ? (
            <Text style={styles.previewPollQuestion}>{poll.question}</Text>
          ) : null}
          {pollOptions.map((opt, i) => (
            <View key={`${opt}-${i}`} style={styles.previewPollOption}>
              <Text style={styles.previewPollOptionText} numberOfLines={2}>
                {opt}
              </Text>
            </View>
          ))}
          <Text style={styles.previewPollMeta}>
            {poll.multipleChoice ? '복수 선택 · ' : ''}
            {poll.closesAt
              ? `마감: ${new Date(poll.closesAt).toLocaleString()}`
              : '무제한'}
          </Text>
        </View>
      ) : null}
      {tags.length > 0 ? (
        <View style={styles.previewTagsRow}>
          {tags.map((tag) => (
            <View key={tag} style={styles.previewTagChip}>
              <Text style={styles.previewTagChipText}>#{tag}</Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}
