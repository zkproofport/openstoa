import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { QueryClientProvider } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useHost } from '@openstoa/miniapp-bridge';
import { OpenStoaTabNavigator } from './navigation/OpenStoaTabNavigator';
import { useOpenStoaSession } from './stores/sessionStore';
import { ThemeProvider, useThemeColors } from './theme/ThemeContext';
import { BootScreen } from './components/BootScreen';
import { WelcomeScreen } from './screens/onboarding/WelcomeScreen';
import { SignInSheetProvider } from './components/SignInSheet';
import { queryClient } from './api/queryClient';
import { initSessionLifecycle, SignInLauncherProvider } from './auth';
import type { SignInLauncher } from './auth';
import { useDeveloperMode } from './hooks/useDeveloperMode';
// Register OpenStoa translation bundles into the shared i18next instance.
import './i18n';

/**
 * Minimum amount of time the BootScreen must stay on screen before any
 * transition to Welcome / Ready. Keeps the entry beat consistent even on
 * fast networks, and gives the queryClient time to prefetch the feed so
 * the first frame of Feed has data instead of an empty spinner.
 */
const BOOT_MIN_DURATION_MS = 3000;

/**
 * Default feed queryKey — must match `FeedHomeScreen`:
 *   useInfiniteQuery({ queryKey: ['feed', sortKey, activeTag, q], ... })
 * where the default sort is 'hot', no tag, empty query.
 */
const DEFAULT_FEED_QUERY_KEY = ['feed', 'hot', null, ''] as const;

export interface OpenStoaAppProps {
  /**
   * Optional override for the OpenStoa server URL. Defaults to whatever the
   * host's `getEnvironment().openstoaBaseUrl` returns.
   */
  baseUrl?: string;
}

type Phase =
  | 'booting' // first beat — checking host for an existing token + prefetching feed
  | 'welcome' // no token + user has not chosen guest yet
  | 'authenticating' // host.loginToOpenStoa() inflight
  | 'ready'; // either authenticated or browsing as guest

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function OpenStoaAppInner(_props: OpenStoaAppProps) {
  const host = useHost();
  const session = useOpenStoaSession();
  const { colors } = useThemeColors();
  const { t } = useTranslation();
  const developerMode = useDeveloperMode();
  const [phase, setPhase] = useState<Phase>('booting');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // The host and mini-app share the SAME i18next default instance (resolved
  // via Metro module deduplication). Re-calling `i18n.changeLanguage(lang)`
  // here from the host's onLanguageChange listener creates an infinite
  // emit→listen→emit loop and crashes with "Maximum call stack size
  // exceeded". Since the instance is shared, mini-app components already
  // see the new language as soon as the host changes it — no extra sync
  // required.

  const hydrateExistingToken = useCallback(
    async (token: string) => {
      // Token is hydrated by the host; the session store is in-memory only,
      // so on a fresh app start `session.userId` is null even when we have a
      // valid token. Hit /api/auth/session once to recover userId — leaving
      // it empty makes vote/bookmark/record buttons disabled across the app
      // (they gate on `mode === 'authenticated'` with a userId).
      const base = host.getEnvironment().openstoaBaseUrl.replace(/\/$/, '');
      try {
        const res = await fetch(`${base}/api/auth/session`, {
          headers: { Authorization: `Bearer ${token}` },
          // Don't trust stale cookies — the host's iOS cookie store
          // outlives our AsyncStorage token and was making the server
          // treat logged-out users as authenticated. Authorization
          // header is the only auth source we trust.
          credentials: 'omit',
        });
        if (res.ok) {
          const me = (await res.json()) as {
            userId?: string;
            nickname?: string;
          };
          session.setSession({
            token,
            userId: me.userId ?? '',
            nickname: me.nickname,
          });
          return true;
        }
      } catch {
        // Network failure during hydrate — fall through to guest so the
        // app stays browsable; the user can sign in from ProfileTab later.
      }
      return false;
    },
    [host, session],
  );

  const prefetchFeed = useCallback(
    async (token: string | null) => {
      const base = host.getEnvironment().openstoaBaseUrl.replace(/\/$/, '');
      const headers: Record<string, string> = {};
      if (token) headers.Authorization = `Bearer ${token}`;
      try {
        await queryClient.prefetchInfiniteQuery({
          queryKey: DEFAULT_FEED_QUERY_KEY,
          initialPageParam: 0,
          queryFn: async () => {
            const params = new URLSearchParams({
              limit: '20',
              offset: '0',
              sort: 'hot',
            });
            const res = await fetch(`${base}/api/feed?${params.toString()}`, {
              headers,
              credentials: 'omit',
            });
            if (!res.ok) {
              // Prefetch failures are non-fatal — FeedHomeScreen will
              // re-query and surface its own error UI.
              return { posts: [], nextCursor: undefined };
            }
            const data = (await res.json()) as { posts: unknown[] };
            return {
              posts: data.posts,
              nextCursor:
                Array.isArray(data.posts) && data.posts.length === 20
                  ? '20'
                  : undefined,
            };
          },
        });
      } catch {
        // Swallow — boot must never block on prefetch.
      }
    },
    [host],
  );

  // Wire all session side-effects (API client mode + queryClient cache
  // invalidation across auth boundaries) once. The lifecycle module
  // subscribes to the session store directly so updates land
  // *synchronously* with the state change — no useEffect lag.
  useEffect(() => {
    initSessionLifecycle(host);
  }, [host]);

  // If we're ready but the session has been cleared (e.g. user just logged
  // out from inside ProfileHomeScreen and re-entered the OpenStoa tab),
  // drop back to Welcome instead of staying on the cached authenticated
  // view.
  useEffect(() => {
    if (phase === 'ready' && session.mode === 'unknown') {
      setPhase('welcome');
    }
  }, [phase, session.mode]);

  useEffect(() => {
    let cancelled = false;
    const startedAt = Date.now();

    (async () => {
      // Always start every boot from a known-clean state. queryClient is
      // a module-level singleton, so it survives hot reloads and even
      // OpenStoaTab unmount/remount cycles — without this, authed data
      // from a previous run leaks into the current (potentially guest)
      // session. The prefetch below then refills the cache with the
      // correct identity's data.
      queryClient.clear();

      // Boot work + the minimum-duration timer run in parallel; we only
      // transition out of `booting` once BOTH have completed. This keeps
      // the boot beat consistent on fast networks and gives the feed
      // prefetch a chance to populate the queryClient cache so the first
      // frame after boot already has content.
      const bootWork = (async () => {
        try {
          const existing = await host.getOpenStoaToken();
          if (existing) {
            const ok = await hydrateExistingToken(existing);
            if (ok) {
              // Authenticated — prefetch the authed feed so the first
              // frame of FeedHomeScreen renders with data.
              await prefetchFeed(existing);
              return 'ready' as const;
            }
            // Token rejected — fall through to Welcome.
          }
          // No valid token: prefetch the public feed in case the user
          // picks "Browse as guest" so the Feed tab opens populated.
          await prefetchFeed(null);
          // Drop any stale in-memory session before showing Welcome.
          session.clear();
          return 'welcome' as const;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg !== 'LOGGED_OUT') setErrorMsg(msg);
          session.clear();
          return 'welcome' as const;
        }
      })();

      const [nextPhase] = await Promise.all([
        bootWork,
        sleep(BOOT_MIN_DURATION_MS),
      ]);
      if (cancelled) return;
      // If the boot work finished early, top up to exactly the minimum
      // duration so the user sees a stable boot beat regardless of network
      // latency.
      const elapsed = Date.now() - startedAt;
      if (elapsed < BOOT_MIN_DURATION_MS) {
        await sleep(BOOT_MIN_DURATION_MS - elapsed);
        if (cancelled) return;
      }
      setPhase(nextPhase);
    })();

    return () => {
      cancelled = true;
    };
    // host instance is stable; we only want this to run on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Race guard: rapid double-taps on the Welcome buttons can spawn two
  // host.loginToOpenStoa() flows in parallel (the second one hits the host's
  // own inflight check, but a thrown 'LOGGED_OUT' from the racing call can
  // overwrite a successful login result). Block re-entry at the OpenStoaApp
  // boundary via a ref so the state-machine stays linear.
  const signInInflightRef = useRef(false);
  const [signInBusy, setSignInBusy] = useState(false);

  // The launcher is the single source of truth for "run the ZK sign-in
  // flow". Both the Welcome "Sign in" CTA and the SignInSheet route
  // through it so that:
  //   1. OpenStoaApp flips to the `'authenticating'` phase (a plain
  //      BootScreen, not a Modal) FIRST. That gives the host's
  //      `<ProofRequestModal>` a clean modal slot to present into; iOS
  //      cannot reliably stack Modal-over-Modal, which is what caused
  //      the user's previous "infinite spinner" report.
  //   2. SignInSheet can dismiss itself immediately before invoking the
  //      launcher, so the user never sees a Modal-over-Modal flicker.
  //   3. Auto-replay still works: the SignInSheet's `pendingActionRef`
  //      is preserved across the dismissal and fires from `onSuccess`.
  const performSignIn = useCallback<SignInLauncher>(
    (onSuccess, method) => {
      if (signInInflightRef.current) return;
      signInInflightRef.current = true;
      setSignInBusy(true);
      setErrorMsg(null);
      setPhase('authenticating');
      void (async () => {
        try {
          // force=true bypasses any LOGGED_OUT marker the host may still hold.
          const auth = await host.loginToOpenStoa({ force: true, method });
          session.setSession({
            token: auth.token,
            userId: auth.userId,
            needsNickname: auth.needsNickname,
          });
          // Warm the authed feed BEFORE landing on the TabNavigator so
          // the Feed tab opens already populated — no second loading
          // flash. The lifecycle subscribe already cleared the (public)
          // feed cache when mode flipped to 'authenticated', so this
          // prefetch fills the empty cache with the user's authed feed.
          await prefetchFeed(auth.token);
          setPhase('ready');
          // Fire the caller's success callback (SignInSheet uses this
          // hook to replay the queued action).
          if (onSuccess) {
            try {
              onSuccess();
            } catch (replayErr) {
              console.warn(
                '[OpenStoaApp] performSignIn onSuccess threw:',
                replayErr,
              );
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn('[OpenStoaApp] performSignIn failed: ' + msg);
          setErrorMsg(msg === 'LOGGED_OUT' ? null : msg);
          setPhase('welcome');
        } finally {
          signInInflightRef.current = false;
          setSignInBusy(false);
        }
      })();
    },
    [host, session, prefetchFeed],
  );

  // Welcome screen "Sign in" CTA — no replay needed, just kicks off the
  // shared launcher.
  const handleSignIn = useCallback(() => {
    performSignIn();
  }, [performSignIn]);
  const handleSignInMdl = useCallback(() => {
    performSignIn(undefined, 'mdl');
  }, [performSignIn]);

  const handleContinueAsGuest = useCallback(() => {
    // Mirror the sign-in guard — don't let a guest-tap during an inflight
    // sign-in skip past authentication into ready phase with a stale auth
    // result about to land.
    if (signInInflightRef.current) return;
    setErrorMsg(null);
    session.setGuest();
    setPhase('ready');
  }, [session]);

  if (phase === 'booting') {
    return <BootScreen />;
  }

  if (phase === 'authenticating') {
    return <BootScreen status={t('openstoa.boot.preparingIdentity')} />;
  }

  if (phase === 'welcome') {
    // mDL sign-in is host-experimental — only surface it when the host has
    // Developer Mode enabled. WelcomeScreen treats an undefined handler
    // as "hide the button".
    return (
      <WelcomeScreen
        onSignIn={handleSignIn}
        onSignInMdl={developerMode ? handleSignInMdl : undefined}
        onContinueAsGuest={handleContinueAsGuest}
        errorMessage={errorMsg}
        busy={signInBusy}
      />
    );
  }

  // phase === 'ready' — either authenticated or guest.
  // SignInLauncherProvider sits OUTSIDE SignInSheetProvider so the sheet
  // can grab `useSignInLauncher()` to delegate the actual proof flow
  // back up to OpenStoaApp (which owns the BootScreen overlay).
  return (
    <SignInLauncherProvider value={performSignIn}>
      <SignInSheetProvider>
        <View
          style={[styles.fill, { backgroundColor: colors.background.primary }]}
        >
          <OpenStoaTabNavigator />
        </View>
      </SignInSheetProvider>
    </SignInLauncherProvider>
  );
}

export function OpenStoaApp(props: OpenStoaAppProps) {
  // QueryClientProvider hoisted above the phase switch so the boot effect
  // can prefetch into the same cache the tab screens read from.
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <OpenStoaAppInner {...props} />
      </ThemeProvider>
    </QueryClientProvider>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
});
