import React, { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n from 'i18next';
import { useHost } from '@openstoa/miniapp-bridge';
import { OpenStoaTabNavigator } from './navigation/OpenStoaTabNavigator';
import { useOpenStoaSession } from './stores/sessionStore';
import { ThemeProvider, useThemeColors } from './theme/ThemeContext';
// Register OpenStoa translation bundles into the shared i18next instance.
import './i18n';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 30_000,
    },
  },
});

export interface OpenStoaAppProps {
  /**
   * Optional override for the OpenStoa server URL. Defaults to whatever the
   * host's `getEnvironment().openstoaBaseUrl` returns.
   */
  baseUrl?: string;
}

type Phase = 'checking' | 'authenticating' | 'ready' | 'error' | 'loggedOut';

function OpenStoaAppInner(_props: OpenStoaAppProps) {
  const host = useHost();
  const session = useOpenStoaSession();
  const { colors } = useThemeColors();
  const [phase, setPhase] = useState<Phase>('checking');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [loginAttempt, setLoginAttempt] = useState(0);

  // The host and mini-app share the SAME i18next default instance (resolved
  // via Metro module deduplication). Re-calling `i18n.changeLanguage(lang)`
  // here from the host's onLanguageChange listener creates an infinite
  // emit→listen→emit loop and crashes with "Maximum call stack size
  // exceeded". Since the instance is shared, mini-app components already
  // see the new language as soon as the host changes it — no extra sync
  // required.

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const existing = await host.getOpenStoaToken();
        if (!cancelled && existing) {
          // Token is hydrated by the host; the session store is in-memory
          // only so on a fresh app start `session.userId` is null even when
          // we have a valid token. Hit /api/auth/session once to recover
          // the userId — leaving it empty makes vote/bookmark/record
          // buttons appear disabled across the app (they gate on
          // sessionUserId being truthy).
          if (!session.token || !session.userId) {
            try {
              const meRes = await fetch(`${host.getEnvironment().openstoaBaseUrl.replace(/\/$/, '')}/api/auth/session`, {
                headers: { Authorization: `Bearer ${existing}` },
              });
              if (meRes.ok) {
                const me = (await meRes.json()) as { userId?: string; nickname?: string };
                session.setSession({
                  token: existing,
                  userId: me.userId ?? '',
                  nickname: me.nickname,
                });
              } else {
                session.setSession({ token: existing, userId: session.userId ?? '' });
              }
            } catch {
              session.setSession({ token: existing, userId: session.userId ?? '' });
            }
          }
          setPhase('ready');
          return;
        }
        if (cancelled) return;
        setPhase('authenticating');
        // Use force=true on explicit retry attempts so the host bypasses
        // the LOGGED_OUT marker and runs a fresh login.
        const auth = await host.loginToOpenStoa(
          loginAttempt > 0 ? { force: true } : undefined,
        );
        if (cancelled) return;
        session.setSession({
          token: auth.token,
          userId: auth.userId,
          needsNickname: auth.needsNickname,
        });
        setPhase('ready');
      } catch (err) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        // Sentinel from zkProofportHostApi when LOGGED_OUT marker is set.
        // Show a logged-out UI with a "Sign in" CTA instead of an error.
        if (msg === 'LOGGED_OUT') {
          setPhase('loggedOut');
          return;
        }
        setErrorMsg(msg);
        setPhase('error');
      }
    })();
    return () => {
      cancelled = true;
    };
    // host instance is stable; loginAttempt drives explicit re-login.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loginAttempt]);

  // If we're already in 'ready' phase but the session token has been cleared
  // (e.g. user just logged out from inside ProfileHomeScreen and re-entered
  // the OpenStoa tab without an app restart), drop back to the logged-out
  // screen instead of staying on the cached authenticated view.
  if (phase === 'ready' && !session.token) {
    setPhase('loggedOut');
  }

  if (phase === 'ready') {
    return (
      <QueryClientProvider client={queryClient}>
        <OpenStoaTabNavigator />
      </QueryClientProvider>
    );
  }

  if (phase === 'loggedOut') {
    return (
      <View style={[styles.center, { backgroundColor: colors.background.primary }]}>
        <Text style={[styles.heading, { color: colors.text.primary }]}>
          Signed out
        </Text>
        <Text style={[styles.label, { color: colors.text.secondary }]}>
          You have been signed out of OpenStoa. Sign in to continue.
        </Text>
        <TouchableOpacity
          style={[styles.signInButton, { backgroundColor: colors.brand.primary }]}
          onPress={() => setLoginAttempt((n) => n + 1)}
          activeOpacity={0.8}
        >
          <Text style={styles.signInButtonText}>Sign in</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={[styles.center, { backgroundColor: colors.background.primary }]}>
      <ActivityIndicator color={colors.brand.primary} />
      <Text style={[styles.label, { color: colors.text.secondary }]}>
        {phase === 'authenticating' ? 'Preparing your anonymous identity…' :
         phase === 'error' ? `Login failed${errorMsg ? `: ${errorMsg}` : ''}` :
         'Loading OpenStoa…'}
      </Text>
    </View>
  );
}

export function OpenStoaApp(props: OpenStoaAppProps) {
  return (
    <ThemeProvider>
      <OpenStoaAppInner {...props} />
    </ThemeProvider>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  heading: {
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 8,
  },
  label: {
    marginTop: 16,
    fontSize: 14,
    textAlign: 'center',
  },
  signInButton: {
    marginTop: 24,
    paddingHorizontal: 28,
    paddingVertical: 12,
    borderRadius: 999,
  },
  signInButtonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
  },
});
