import React from 'react';
import { Pressable } from 'react-native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useTranslation } from 'react-i18next';
import Feather from 'react-native-vector-icons/Feather';
import { ChatListScreen } from '../../screens/chat/ChatListScreen';
import { ChatRoomScreen } from '../../screens/chat/ChatRoomScreen';
import { TopicMembersScreen } from '../../screens/topics/TopicMembersScreen';
import { DmListScreen } from '../../screens/chat/DmListScreen';
import { NewConversationScreen } from '../../screens/chat/NewConversationScreen';
import { InAppBrowserScreen } from '../../screens/common/InAppBrowserScreen';
import { useHost } from '@openstoa/miniapp-bridge';
import { useMiniAppStackScreenOptions } from '../shared';
import { useThemeColors } from '../../theme/ThemeContext';
import { enterChatRoom, leaveChatRoom } from '../../lib/chatNotifications';

export type ChatStackParamList = {
  ChatList: undefined;
  DmList: undefined;
  NewConversation: undefined;
  // `kind` distinguishes a topic room (member list reachable, see the
  // headerRight Members button in ChatRoomScreen) from a DM (no member list
  // — the two participants are already named in the header). Optional so a
  // caller that genuinely doesn't know defaults to the topic-room chrome
  // (the more common case) rather than crashing on a missing param.
  ChatRoom: { topicId: string; topicTitle?: string; kind?: 'topic' | 'dm' };
  InAppBrowser: { url: string; title?: string };
  /*
   * The member list, hosted HERE as well as under Topics.
   *
   * The room's Members control used to jump to the Topics tab and show it
   * there. On the device that is a dead end: the screen arrives as the only
   * route pushed on a stack it does not belong to, so it draws no back arrow
   * and there is no way out except the tab bar — and the tab bar cannot take
   * you back to the conversation you were reading. Pushed on this stack it
   * behaves the way anyone expects: back returns to the room.
   */
  TopicMembers: { topicId: string };
};

const Stack = createNativeStackNavigator<ChatStackParamList>();

export function ChatStack() {
  const { t, i18n } = useTranslation();
  const screenOptions = useMiniAppStackScreenOptions();
  const { colors } = useThemeColors();
  const host = useHost();
  /*
   * Notifications a conversation already delivered are cleared when the user
   * opens it — see ../../lib/chatNotifications for why it is per conversation
   * and never a whole-tray wipe.
   *
   * Wired HERE, on the navigator, rather than inside ChatRoomScreen: the
   * screen is a large file with several owners, and the fact worth reacting to
   * ("the ChatRoom route is now focused, for this topicId") is a navigation
   * fact that the navigator already has in hand. `screenListeners` as a
   * function receives the route, so `route.params.topicId` is available
   * without the screen having to report it.
   */
  const screenListeners = React.useCallback(
    ({ route }: { route: { name: string; params?: object } }) => ({
      focus: () => {
        if (route.name !== 'ChatRoom') return;
        enterChatRoom(host, (route.params as { topicId?: unknown } | undefined)?.topicId);
      },
      blur: () => {
        if (route.name !== 'ChatRoom') return;
        leaveChatRoom((route.params as { topicId?: unknown } | undefined)?.topicId);
      },
    }),
    [host],
  );
  return (
    <Stack.Navigator key={i18n.language} screenOptions={screenOptions} screenListeners={screenListeners}>
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
              accessibilityLabel={t('openstoa.dm.title')}
            >
              <Feather name="send" size={20} color={colors.text.primary} />
            </Pressable>
          ),
        })}
      />
      <Stack.Screen name="DmList" component={DmListScreen} options={{ title: t('openstoa.dm.title') }} />
      <Stack.Screen
        name="TopicMembers"
        component={TopicMembersScreen}
        options={{ title: t('openstoa.members.title') }}
      />
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
