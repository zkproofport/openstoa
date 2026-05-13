import React from 'react';
import { Text, View } from 'react-native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Feather from 'react-native-vector-icons/Feather';
import { ZKProofportMarkIcon } from '../components/icons';
import { useHost } from '@openstoa/miniapp-bridge';
import { useTranslation } from 'react-i18next';
import { FeedStack } from './stacks/FeedStack';
import { TopicsStack } from './stacks/TopicsStack';
import { ChatStack } from './stacks/ChatStack';
import { ProfileStack } from './stacks/ProfileStack';
import { useThemeColors } from '../theme/ThemeContext';

export type OpenStoaTabParamList = {
  FeedTab: undefined;
  TopicsTab: undefined;
  ChatTab: undefined;
  ProfileTab: undefined;
  ExitToHostTab: undefined;
};

const Tab = createBottomTabNavigator<OpenStoaTabParamList>();

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

  return (
    <Tab.Navigator
      key={i18n.language}
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: colors.background.primary,
          borderTopWidth: 1,
          borderTopColor: colors.border.default,
          paddingTop: 8,
          paddingBottom: insets.bottom,
          height: 60 + insets.bottom,
        },
        tabBarActiveTintColor: colors.brand.primary,
        tabBarInactiveTintColor: colors.text.tertiary,
        tabBarLabelStyle: {
          fontSize: 11,
          fontWeight: '600',
          marginTop: 2,
        },
      }}
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
