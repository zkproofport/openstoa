import React, { useCallback, useEffect, useRef } from 'react';
import { Text, View } from 'react-native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { getFocusedRouteNameFromRoute } from '@react-navigation/native';
import Feather from 'react-native-vector-icons/Feather';
import { ZKProofportMarkIcon } from '../components/icons';
import { useHost } from '@openstoa/miniapp-bridge';
import { useQuery } from '@tanstack/react-query';
import { useOpenStoaClient } from '../hooks/useOpenStoaClient';
import { useOpenStoaSession } from '../stores/sessionStore';
import { unreadTabBadge, unreadTotal, type UnreadCountable } from '../lib/unreadTotal';

/**
 * How often the badge re-asks while OpenStoa is open.
 *
 * Slower than `ChatListScreen`'s own 30s poll on purpose: this one runs the
 * whole time the mini-app is open, and the reader is usually looking at
 * something other than their rooms. React Query dedupes by key, so when the
 * Chat tab IS open its faster interval takes over and this costs nothing extra.
 */
const UNREAD_BADGE_POLL_MS = 60_000;
import { useTranslation } from 'react-i18next';
import { FeedStack } from './stacks/FeedStack';
import { TopicsStack } from './stacks/TopicsStack';
import { ChatStack } from './stacks/ChatStack';
import { ProfileStack } from './stacks/ProfileStack';
import { useThemeColors } from '../theme/ThemeContext';
import { usePendingChatTopicId } from '../hooks/usePushTapRouting';
import { getPendingChatTopicId } from '../hooks/pushTapRouting';
import { TYPE_SCALE } from '../theme/tokens';

export type OpenStoaTabParamList = {
  FeedTab: undefined;
  TopicsTab: undefined;
  ChatTab: undefined;
  ProfileTab: undefined;
  ExitToHostTab: undefined;
};

const Tab = createBottomTabNavigator<OpenStoaTabParamList>();

// Full-screen modal routes — webviews and similar overlays that should
// cover the viewport. The bottom tab bar is hidden whenever one of these
// is focused. Add a route name here when you register a new modal that
// should hide the tab bar.
const MODAL_ROUTES = new Set(['InAppBrowser']);

function isFullScreenModalRoute(route: any): boolean {
  const focused = getFocusedRouteNameFromRoute(route);
  return !!focused && MODAL_ROUTES.has(focused);
}

// Placeholder component — never actually rendered; the tabPress listener
// preempts navigation and dispatches host.exitToHost() instead.
function NoopExitScreen() {
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
      <Text>Returning to ZKProofport…</Text>
    </View>
  );
}

export function OpenStoaTabNavigator() {
  const host = useHost();
  const env = host.getEnvironment();
  const showExitTab = env.isEmbedded;
  const insets = useSafeAreaInsets();
  const { t, i18n } = useTranslation();
  const { colors } = useThemeColors();

  // Push tap routing, step 1 of 2 (design §13, P-O gap 5): bring the Chat tab
  // into focus. Step 2 — pushing the actual room on top of the chat list — is
  // ChatListScreen's job, which is what leaves the list underneath so Back
  // works instead of stranding the user in a room with no way out.
  //
  // The navigation object we need belongs to THIS navigator, and this component
  // renders it rather than living inside it, so `useNavigation()` here would
  // hand us the HOST's navigation instead. `screenListeners` is invoked with the
  // tab navigator's own navigation object every time the navigator emits an
  // event — including the `state` event it emits on mount — so we capture it
  // from there. Deliberately NOT the `focus` event: a nested navigator does not
  // emit focus on its initial mount (`useFocusEvents` only does that when there
  // is no parent navigator, and here the host's tab navigator is the parent), so
  // on a cold start the tap would be stranded waiting for an event that already
  // fired before this navigator existed.
  /*
   * FETCHES, and shares the fetch with `ChatListScreen`.
   *
   * A first version passed `enabled: false` here, reasoning that the Chat
   * screen owns the query and this navigator should only observe it. That is
   * true and useless: `ChatListScreen` is only mounted once someone opens the
   * Chat tab, so on the Feed tab nobody was fetching and the badge stayed
   * empty with three messages waiting — verified on the device. A badge that
   * appears only after you have gone looking is not a badge.
   *
   * React Query dedupes by key, so the two subscribers share one request and
   * one cache entry. The interval is deliberately slower than the Chat
   * screen's: this one runs the whole time OpenStoa is open, and the reader is
   * usually looking at something else.
   */
  const client = useOpenStoaClient();
  const isGuest = useOpenStoaSession((st: { mode: string }) => st.mode) !== 'authenticated';
  const { data: topicsData } = useQuery<{ topics?: UnreadCountable[] } | UnreadCountable[]>({
    queryKey: ['my-topics'],
    queryFn: () => client.get<{ topics?: UnreadCountable[] } | UnreadCountable[]>('/api/topics'),
    enabled: !isGuest,
    refetchInterval: UNREAD_BADGE_POLL_MS,
    staleTime: UNREAD_BADGE_POLL_MS,
  });
  const rooms = Array.isArray(topicsData) ? topicsData : (topicsData?.topics ?? []);
  const chatBadge = unreadTabBadge(rooms);

  /*
   * Push the same number up to the host, which draws the two badges the
   * mini-app cannot reach: its own tab in the host's tab bar, and the app icon.
   *
   * The mini-app owns the count — it is the only side that knows what has been
   * read — and the host owns the drawing. One call, so the three surfaces
   * cannot disagree; a reader who sees 3 on the icon and 1 on a tab has found a
   * bug they can see and cannot explain.
   */
  const total = unreadTotal(rooms);
  useEffect(() => {
    host.setUnreadBadge?.(total);
  }, [host, total]);

  const pendingChatTopicId = usePendingChatTopicId();
  const tabNavigationRef = useRef<{ navigate: (name: string) => void } | null>(null);
  // The topic we have already switched tabs for, so neither path below jumps
  // twice for the same tap.
  const jumpedForTopicRef = useRef<string | null>(null);

  const jumpToChatTab = useCallback((topicId: string) => {
    if (jumpedForTopicRef.current === topicId) return;
    const navigation = tabNavigationRef.current;
    if (!navigation) return;
    jumpedForTopicRef.current = topicId;
    try {
      navigation.navigate('ChatTab');
    } catch {
      // A tap is never worth crashing a tab switch over. The topic stays
      // latched; ChatListScreen still consumes it if the user goes there.
    }
  }, []);

  const captureTabNavigation = useCallback(
    (navigation: { navigate: (name: string) => void }) => {
      tabNavigationRef.current = navigation;
      // Second path in: the mount-time capture can land after this component's
      // own effect has already run and found no navigation object (the emit
      // happens inside the child navigator's effect, and child effects flush
      // first — but relying on that ordering alone would make a cold-start tap
      // depend on an implementation detail). Deferred a tick because we are
      // inside another navigator's event dispatch.
      const pending = getPendingChatTopicId();
      if (!pending || jumpedForTopicRef.current === pending) return;
      setTimeout(() => jumpToChatTab(pending), 0);
    },
    [jumpToChatTab],
  );

  // First path in: a tap that lands while this navigator is already mounted, and
  // a cold-start tap latched before it existed (the effect also runs on mount).
  useEffect(() => {
    if (!pendingChatTopicId) return;
    jumpToChatTab(pendingChatTopicId);
  }, [pendingChatTopicId, jumpToChatTab]);

  const baseTabBarStyle = {
    backgroundColor: colors.background.primary,
    borderTopWidth: 1,
    borderTopColor: colors.border.default,
    paddingTop: 8,
    paddingBottom: insets.bottom,
    height: 60 + insets.bottom,
  };

  return (
    <Tab.Navigator
      key={i18n.language}
      screenListeners={({ navigation }) => {
        captureTabNavigation(navigation);
        return {};
      }}
      // screenOptions runs per-route on every focus change so we can
      // dynamically swap tabBarStyle when a full-screen modal route is
      // focused. Doing it from inside a screen via setOptions+cleanup
      // leaves the navigator with no idea what the prior style was and
      // falls back to the platform default on dismiss.
      screenOptions={({ route }) => ({
        headerShown: false,
        // Hide the tab bar while the keyboard is up so screens like
        // ChatRoom can dock their composer right on top of the keyboard
        // — otherwise `KeyboardAvoidingView` lifts the input by tab-bar
        // height extra and the user sees a visible gap.
        tabBarHideOnKeyboard: true,
        tabBarStyle: isFullScreenModalRoute(route)
          ? { display: 'none' }
          : baseTabBarStyle,
        tabBarActiveTintColor: colors.brand.primary,
        tabBarInactiveTintColor: colors.text.tertiary,
        tabBarLabelStyle: {
          fontSize: TYPE_SCALE.label,
          fontWeight: '600',
          marginTop: 2,
        },
      })}
    >
      <Tab.Screen
        name="FeedTab"
        component={FeedStack}
        options={{
          tabBarLabel: t('openstoa.tabs.feed'),
          // `layers` reads as "stuff stacked from multiple sources",
          // matching the cross-topic Feed timeline.
          tabBarIcon: ({ size, color }) => (
            <Feather name="layers" size={size} color={color} />
          ),
        }}
      />
      <Tab.Screen
        name="TopicsTab"
        component={TopicsStack}
        options={{
          tabBarLabel: t('openstoa.tabs.topics'),
          tabBarIcon: ({ size, color }) => (
            <Feather name="hash" size={size} color={color} />
          ),
        }}
      />
      <Tab.Screen
        name="ChatTab"
        component={ChatStack}
        options={{
          tabBarLabel: t('openstoa.tabs.chat'),
          tabBarIcon: ({ size, color }) => (
            <Feather name="message-circle" size={size} color={color} />
          ),
          /*
           * The waiting-messages count, on the tab itself.
           *
           * Until this there was no badge anywhere: not on the app icon, not on
           * the host's OpenStoa tab, and not here — so the only way to discover
           * a message was to open this tab and look. The per-room counts had
           * existed for a while, which is what made the gap easy to miss; the
           * number was there, it just never travelled up.
           *
           * `undefined` when there is nothing, never 0 or '': React Navigation
           * draws a literal "0" for the first and a bare dot for the second,
           * and a badge with nothing behind it is worse than no badge.
           */
          tabBarBadge: chatBadge,
        }}
      />
      <Tab.Screen
        name="ProfileTab"
        component={ProfileStack}
        options={{
          tabBarLabel: t('openstoa.tabs.profile'),
          tabBarIcon: ({ size, color }) => (
            <Feather name="user" size={size} color={color} />
          ),
        }}
      />
      {showExitTab ? (
        <Tab.Screen
          name="ExitToHostTab"
          component={NoopExitScreen}
          options={{
            tabBarLabel: t('openstoa.tabs.zkproofport'),
            // Brand-specific shield-with-tick instead of a generic
            // external-link arrow — the tab returns to the host so it
            // should read as the host's identity.
            tabBarIcon: ({ size, color }) => (
              <ZKProofportMarkIcon size={size} color={color} />
            ),
          }}
          listeners={() => ({
            tabPress: (e) => {
              e.preventDefault();
              host.exitToHost();
            },
          })}
        />
      ) : null}
    </Tab.Navigator>
  );
}
