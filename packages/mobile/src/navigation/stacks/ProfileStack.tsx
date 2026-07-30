import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useTranslation } from 'react-i18next';
import { ProfileHomeScreen } from '../../screens/profile/ProfileHomeScreen';
import { EditProfileScreen } from '../../screens/profile/EditProfileScreen';
import { AccountRecoveryScreen } from '../../screens/profile/AccountRecoveryScreen';
import { AiPermissionsScreen } from '../../screens/profile/AiPermissionsScreen';
import { NotificationSettingsScreen } from '../../screens/profile/NotificationSettingsScreen';
import { PostDetailScreen } from '../../screens/feed/PostDetailScreen';
import { PostCreateScreen } from '../../screens/topics/PostCreateScreen';
import { TopicDetailScreen } from '../../screens/topics/TopicDetailScreen';
import { InAppBrowserScreen } from '../../screens/common/InAppBrowserScreen';
import { useMiniAppStackScreenOptions } from '../shared';

export type ProfileStackParamList = {
  ProfileHome: undefined;
  EditProfile: undefined;
  AccountRecovery: undefined;
  AiPermissions: undefined;
  NotificationSettings: undefined;
  // Posts/topics opened from Profile (bookmarks, likes, my-posts, my-topics)
  // live INSIDE this stack so the back arrow returns to Profile, not Feed.
  PostDetail: { postId: string };
  // PostCreate doubles as the edit screen for the author-only kebab menu
  // on PostDetail. `editPostId` triggers hydrate + PATCH semantics.
  PostCreate: { topicId: string; topicTitle?: string; editPostId?: string };
  TopicDetail: { topicId: string };
  // Outbound URLs (BaseScan record links from the Recorded → By me sub-tab,
  // post content links, etc.) route here instead of Linking.openURL.
  InAppBrowser: { url: string; title?: string };
};

const Stack = createNativeStackNavigator<ProfileStackParamList>();

export function ProfileStack() {
  const { t, i18n } = useTranslation();
  const screenOptions = useMiniAppStackScreenOptions();
  return (
    <Stack.Navigator key={i18n.language} screenOptions={screenOptions}>
      <Stack.Screen name="ProfileHome" component={ProfileHomeScreen} options={{ title: t('openstoa.tabs.profile') }} />
      <Stack.Screen name="EditProfile" component={EditProfileScreen} options={{ title: t('openstoa.profile.editTitle') }} />
      <Stack.Screen name="AccountRecovery" component={AccountRecoveryScreen} options={{ title: 'Chat recovery' }} />
      <Stack.Screen name="AiPermissions" component={AiPermissionsScreen} options={{ title: 'AI permissions' }} />
      <Stack.Screen name="NotificationSettings" component={NotificationSettingsScreen} options={{ title: 'Notifications' }} />
      <Stack.Screen name="PostDetail" component={PostDetailScreen} options={{ title: t('openstoa.feed.postTitle') }} />
      <Stack.Screen name="PostCreate" component={PostCreateScreen} options={{ title: t('openstoa.topics.newPostTitle') }} />
      <Stack.Screen name="TopicDetail" component={TopicDetailScreen} options={{ title: t('openstoa.topics.detailTitle') }} />
      <Stack.Screen
        name="InAppBrowser"
        component={InAppBrowserScreen}
        options={({ route }: { route: { params: ProfileStackParamList['InAppBrowser'] } }) => ({
          title: route.params.title ?? (() => {
            try { return new URL(route.params.url).host; } catch { return route.params.url; }
          })(),
          presentation: 'fullScreenModal', animation: 'slide_from_bottom',
        })}
      />
    </Stack.Navigator>
  );
}
