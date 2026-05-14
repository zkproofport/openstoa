import React, { type ReactNode } from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import { GuestSignInCard } from '../components/SignInSheet';
import { useThemeColors } from '../theme/ThemeContext';
import { useRequireAuth } from './useRequireAuth';

// Re-exported via the auth barrel — used directly by screens that need
// guest fallback without wrapping the whole subtree in <AuthGate>.

/**
 * The default "you're a guest, sign in to continue" fallback layout —
 * exported on its own so individual screens (Profile, Chat, …) that
 * already manage their own data hooks can drop it in directly without
 * wrapping themselves in `<AuthGate>`. Using this helper everywhere
 * guarantees the guest UX has identical padding / width / safe-area
 * handling across tabs (the user kept noticing inconsistent card sizes
 * when each screen rolled its own wrapper).
 */
export function GuestFallbackView() {
  const { colors } = useThemeColors();
  return (
    <ScrollView
      style={[styles.root, { backgroundColor: colors.background.secondary }]}
      contentContainerStyle={styles.content}
    >
      <GuestSignInCard />
    </ScrollView>
  );
}

interface AuthGateProps {
  children: ReactNode;
  /**
   * Optional override for the guest fallback. Defaults to the standard
   * `<GuestSignInCard />` inside a scrollable padded container so the CTA
   * stays comfortable on small screens.
   */
  fallback?: ReactNode;
}

/**
 * Wraps a screen body that should only render for authenticated users.
 * Guests see a sign-in card (or the supplied `fallback`) instead.
 *
 * Use for full-screen tabs like Profile / Chat. For individual buttons
 * inside an otherwise-public screen, use `useAuthGuardedAction` instead.
 */
export function AuthGate({ children, fallback }: AuthGateProps) {
  const { isGuest } = useRequireAuth();

  if (isGuest) {
    return <>{fallback ?? <GuestFallbackView />}</>;
  }

  return <>{children}</>;
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  content: {
    paddingTop: 64,
    paddingBottom: 32,
  },
});
