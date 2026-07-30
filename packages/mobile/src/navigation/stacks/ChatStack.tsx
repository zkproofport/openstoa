import React from 'react';
import { Pressable } from 'react-native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useTranslation } from 'react-i18next';
import Feather from 'react-native-vector-icons/Feather';
import { ChatListScreen } from '../../screens/chat/ChatListScreen';
import { ChatRoomScreen } from '../../screens/chat/ChatRoomScreen';
import { DmListScreen } from '../../screens/chat/DmListScreen';
import { NewConversationScreen } from '../../screens/chat/NewConversationScreen';
import { InAppBrowserScreen } from '../../screens/common/InAppBrowserScreen';
import { useMiniAppStackScreenOptions } from '../shared';
import { useThemeColors } from '../../theme/ThemeContext';

export type ChatStackParamList = {
  ChatList: undefined;
  DmList: undefined;
  NewConversation: undefined;
  ChatRoom: { topicId: string; topicTitle?: string };
  InAppBrowser: { url: string; title?: string };
};

const Stack = createNativeStackNavigator<ChatStackParamList>();

export function ChatStack() {
  const { t, i18n } = useTranslation();
  const screenOptions = useMiniAppStackScreenOptions();
  const { colors } = useThemeColors();
  return (
    <Stack.Navigator key={i18n.language} screenOptions={screenOptions}>
      <Stack.Screen
        name="ChatList"
        component={ChatListScreen}
        options={({ navigation }) => ({
          title: t('openstoa.tabs.chat'),
          // Entry point to 1:1 direct messages (a separate list from topic chats).
          headerRight: () => (
            <Pressable
              onPress={() => navigation.navigate('DmList')}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              accessibilityRole="button"
              accessibilityLabel="Direct messages"
            >
              <Feather name="send" size={20} color={colors.text.primary} />
            </Pressable>
          ),
        })}
      />
      <Stack.Screen name="DmList" component={DmListScreen} options={{ title: t('openstoa.dm.title') }} />
      <Stack.Screen
        name="NewConversation"
        component={NewConversationScreen}
        options={{ title: t('openstoa.dm.newConversation') }}
      />
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
