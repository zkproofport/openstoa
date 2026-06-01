import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useTranslation } from 'react-i18next';
import { ChatListScreen } from '../../screens/chat/ChatListScreen';
import { ChatRoomScreen } from '../../screens/chat/ChatRoomScreen';
import { InAppBrowserScreen } from '../../screens/common/InAppBrowserScreen';
import { useMiniAppStackScreenOptions } from '../shared';

export type ChatStackParamList = {
  ChatList: undefined;
  ChatRoom: { topicId: string; topicTitle?: string };
  InAppBrowser: { url: string; title?: string };
};

const Stack = createNativeStackNavigator<ChatStackParamList>();

export function ChatStack() {
  const { t, i18n } = useTranslation();
  const screenOptions = useMiniAppStackScreenOptions();
  return (
    <Stack.Navigator key={i18n.language} screenOptions={screenOptions}>
      <Stack.Screen name="ChatList" component={ChatListScreen} options={{ title: t('openstoa.tabs.chat') }} />
      <Stack.Screen
        name="ChatRoom"
        component={ChatRoomScreen}
        options={({ route }: { route: { params: ChatStackParamList['ChatRoom'] } }) => ({
          title: route.params.topicTitle ?? t('openstoa.tabs.chat'),
        })}
      />
      <Stack.Screen
        name="InAppBrowser"
        component={InAppBrowserScreen}
        options={({ route }: { route: { params: ChatStackParamList['InAppBrowser'] } }) => ({
          title: route.params.title ?? (() => {
            try { return new URL(route.params.url).host; } catch { return route.params.url; }
          })(),
          presentation: 'fullScreenModal', animation: 'slide_from_bottom',
        })}
      />
    </Stack.Navigator>
  );
}
