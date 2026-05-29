import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useTranslation } from 'react-i18next';
import { FeedHomeScreen } from '../../screens/feed/FeedHomeScreen';
import { PostDetailScreen } from '../../screens/feed/PostDetailScreen';
import { PostCreateScreen } from '../../screens/topics/PostCreateScreen';
import { InAppBrowserScreen } from '../../screens/common/InAppBrowserScreen';
import { useMiniAppStackScreenOptions } from '../shared';

export type FeedStackParamList = {
  FeedHome: undefined;
  PostDetail: { postId: string };
  // PostCreate doubles as the post-edit screen — pass `editPostId` to
  // hydrate the form and switch the submit action to PATCH.
  PostCreate: { topicId: string; topicTitle?: string; editPostId?: string };
  // External-URL routing target. Every outbound link surfaced by a
  // feed-stack screen (record tx links, post content URLs, OG cards)
  // navigates here instead of bouncing to Safari.
  InAppBrowser: { url: string; title?: string };
};

const Stack = createNativeStackNavigator<FeedStackParamList>();

export function FeedStack() {
  const { t, i18n } = useTranslation();
  const screenOptions = useMiniAppStackScreenOptions();
  return (
    <Stack.Navigator key={i18n.language} screenOptions={screenOptions}>
      <Stack.Screen name="FeedHome" component={FeedHomeScreen} options={{ title: t('openstoa.tabs.feed') }} />
      <Stack.Screen name="PostDetail" component={PostDetailScreen} options={{ title: t('openstoa.feed.postTitle') }} />
      <Stack.Screen name="PostCreate" component={PostCreateScreen} options={{ title: t('openstoa.topics.newPostTitle') }} />
      <Stack.Screen
        name="InAppBrowser"
        component={InAppBrowserScreen}
        options={({ route }: { route: { params: FeedStackParamList['InAppBrowser'] } }) => ({
          title: route.params.title ?? (() => {
            try { return new URL(route.params.url).host; } catch { return route.params.url; }
          })(),
          presentation: 'modal',
        })}
      />
    </Stack.Navigator>
  );
}
