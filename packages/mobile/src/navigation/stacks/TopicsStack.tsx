import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useTranslation } from 'react-i18next';
import { TopicsHomeScreen } from '../../screens/topics/TopicsHomeScreen';
import { TopicDetailScreen } from '../../screens/topics/TopicDetailScreen';
import { TopicCreateScreen } from '../../screens/topics/TopicCreateScreen';
import { PostCreateScreen } from '../../screens/topics/PostCreateScreen';
import { PostDetailScreen } from '../../screens/feed/PostDetailScreen';
import { TopicMembersScreen } from '../../screens/topics/TopicMembersScreen';
import { TopicEditScreen } from '../../screens/topics/TopicEditScreen';
import { TopicRequestsScreen } from '../../screens/topics/TopicRequestsScreen';
import { InAppBrowserScreen } from '../../screens/common/InAppBrowserScreen';
import { useMiniAppStackScreenOptions } from '../shared';

export type TopicsStackParamList = {
  TopicsHome: undefined;
  TopicDetail: { topicId: string };
  TopicCreate: undefined;
  PostCreate: { topicId: string; topicTitle?: string; editPostId?: string };
  PostDetail: { postId: string };
  TopicMembers: { topicId: string };
  TopicEdit: { topicId: string };
  TopicRequests: { topicId: string };
  // Outbound URL target — record tx links, post content URLs, OG
  // cards. Anything http(s) goes through here, never Linking.openURL.
  InAppBrowser: { url: string; title?: string };
};

const Stack = createNativeStackNavigator<TopicsStackParamList>();

export function TopicsStack() {
  const { t, i18n } = useTranslation();
  const screenOptions = useMiniAppStackScreenOptions();
  return (
    <Stack.Navigator key={i18n.language} screenOptions={screenOptions}>
      <Stack.Screen name="TopicsHome" component={TopicsHomeScreen} options={{ title: t('openstoa.tabs.topics') }} />
      <Stack.Screen name="TopicDetail" component={TopicDetailScreen} options={{ title: t('openstoa.topics.detailTitle') }} />
      <Stack.Screen name="TopicCreate" component={TopicCreateScreen} options={{ title: t('openstoa.topics.createTitle') }} />
      <Stack.Screen name="PostCreate" component={PostCreateScreen} options={{ title: t('openstoa.topics.newPostTitle') }} />
      <Stack.Screen name="PostDetail" component={PostDetailScreen} options={{ title: t('openstoa.feed.postTitle') }} />
      <Stack.Screen name="TopicMembers" component={TopicMembersScreen} options={{ title: t('openstoa.members.title') }} />
      <Stack.Screen name="TopicEdit" component={TopicEditScreen} options={{ title: t('openstoa.topicEdit.title') }} />
      <Stack.Screen name="TopicRequests" component={TopicRequestsScreen} options={{ title: t('openstoa.requests.title') }} />
      <Stack.Screen
        name="InAppBrowser"
        component={InAppBrowserScreen}
        options={({ route }: { route: { params: TopicsStackParamList['InAppBrowser'] } }) => ({
          title: route.params.title ?? (() => {
            try { return new URL(route.params.url).host; } catch { return route.params.url; }
          })(),
          presentation: 'fullScreenModal', animation: 'slide_from_bottom',
        })}
      />
    </Stack.Navigator>
  );
}
