import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { QueryClientProvider } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useHost } from '@openstoa/miniapp-bridge';
import { OpenStoaTabNavigator } from './navigation/OpenStoaTabNavigator';
import { useOpenStoaSession } from './stores/sessionStore';
import { ThemeProvider, useThemeColors } from './theme/ThemeContext';
import { BootScreen } from './components/BootScreen';
import { RecoveryRepairProvider } from './components/RecoveryRepair';
import { WelcomeScreen } from './screens/onboarding/WelcomeScreen';
import { SignInSheetProvider } from './components/SignInSheet';
import { queryClient } from './api/queryClient';
import { DEFAULT_REQUEST_TIMEOUT_MS, fetchWithTimeout } from './api/timeout';
import { initSessionLifecycle, SignInLauncherProvider } from './auth';
import type { SignInLauncher, SignInMethodId } from './auth';
import { useOfferedSignInMethods } from './auth/useOfferedSignInMethods';
import { usePushRegistration } from './hooks/usePushRegistration';
import { usePushTapRouting } from './hooks/usePushTapRouting';
import { useChatNotificationClearing } from './hooks/useChatNotificationClearing';
import { useAccountEvents } from './api/useAccountEvents';
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

/**
 * How long the "Preparing your anonymous identity…" screen waits before it
 * offers a way out.
 *
 * There IS one now because there was not one, and a person on a real device
 * spent the difference force-quitting the app: `phase === 'authenticating'`
 * rendered a plain `BootScreen` with no control on it, so a login that never
 * came back had no exit that did not go through the app switcher.
 *
 * Not zero, because sign-in normally resolves in well under a second and a
 * Cancel that flashes past is worse than none — it reads as a glitch and
 * invites a tap that aborts a login which was about to succeed. Eight seconds
 * is past every fast path and still inside the span where somebody is actively
 * waiting rather than wondering whether the app is dead.
 */
const SIGN_IN_CANCEL_VISIBLE_AFTER_MS = 8_000;

/**
 * The point at which the app stops waiting for the host, whatever the host is
 * doing.
 *
 * Eight minutes, and deliberately NOT the fifteen seconds an HTTP request gets.
 * `loginToOpenStoa` is not one request: on a production build it posts a
 * proof-request, hands the user to the ZK proof flow, and then polls the server
 * for the result 240 times at 1.5s — six minutes of legitimate waiting, most of
 * it on the person tapping through Google sign-in and on-device proving. A
 * deadline inside that window would cancel logins that were going to work.
 *
 * So this is a backstop, not the primary remedy — Cancel above is the primary
 * remedy. What it exists for is the case the try/catch could never handle: a
 * promise that NEVER SETTLES. The HTTP deadline in `api/timeout.ts` does not
 * cover it, because this is a bridge call into the host and its ways of hanging
 * are not all HTTP: a proof modal the user swiped away, a native promise nobody
 * resolves, a deep link that never comes back. Whatever the cause, the app
 * leaves this screen within eight minutes instead of never.
 */
const SIGN_IN_HARD_DEADLINE_MS = 8 * 60 * 1000;

/**
 * The hard deadline above fired.
 *
 * Its own type so the catch can tell it from anything the host threw and say
 * "it did not answer" rather than "it failed" — the same distinction
 * `OpenStoaTimeoutError` draws for HTTP, one layer up.
 */
class SignInTimeoutError extends Error {
  constructor(readonly waitedMs: number) {
    super('SIGN_IN_TIMEOUT');
    this.name = 'SignInTimeoutError';
  }
}

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
  // Which sign-in methods this build offers, Developer Mode already applied.
  // The list itself — including the mDL kill switch for the 1.0.0 beta — lives
  // in `auth/signInMethods.ts`, shared with the SignInSheet.
  const signInMethods = useOfferedSignInMethods();
  const [phase, setPhase] = useState<Phase>('booting');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Phase 6 push (design §13): register this device the moment the session is
  // authenticated, at the ROOT of the mini-app. This used to hang off
  // ChatListScreen, so a user who never opened the chat list never registered
  // and never received a push. Gated on the authenticated mode (guests have no
  // session to bind a token to) and deduped per identity inside the hook, so it
  // fires exactly once per authenticated session rather than per mount.
  usePushRegistration(session.mode === 'authenticated');

  // Tap routing (P-O gap 5). Subscribed unconditionally and from the root: a
  // cold-start tap arrives while this component is still on the BootScreen, and
  // gating it on the session would drop the very tap that launched the app. The
  // topic is latched; `OpenStoaTabNavigator` and `ChatListScreen` consume it.
  usePushTapRouting();

  // Clearing delivered notifications for the room the user is reading. Entry
  // into a room is handled by `ChatStack`'s screenListeners; this covers the
  // case with no focus change in it — the app returning to the foreground with
  // a room already open. Mounted at the root because AppState is a process-wide
  // signal, not a screen's.
  useChatNotificationClearing();

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
        // Deadlined: this one runs during `phase === 'booting'`, and without a
        // deadline a server that accepts the connection and says nothing keeps
        // the boot screen up for as long as the app lives — the same trap as
        // the sign-in hang, one phase earlier and with even less on screen.
        const res = await fetchWithTimeout(
          `${base}/api/auth/session`,
          {
            headers: { Authorization: `Bearer ${token}` },
            // Don't trust stale cookies — the host's iOS cookie store
            // outlives our AsyncStorage token and was making the server
            // treat logged-out users as authenticated. Authorization
            // header is the only auth source we trust.
            credentials: 'omit',
          },
          { path: '/api/auth/session', timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS },
        );
        if (res.ok) {
          const me = (await res.json()) as {
            userId?: string;
            nickname?: string;
            role?: string;
          };
          // Server only includes the `role` field when the account is
          // admin (see openstoa/src/app/api/auth/session/route.ts) — normalise
          // anything else to 'member' so the session store always has a
          // concrete value.
          const role = me.role === 'admin' ? 'admin' : 'member';
          session.setSession({
            token,
            userId: me.userId ?? '',
            nickname: me.nickname,
            role,
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
            // Deadlined for the same reason as the hydrate above: boot waits
            // on this, and `catch` cannot catch a promise that never settles.
            const res = await fetchWithTimeout(
              `${base}/api/feed?${params.toString()}`,
              { headers, credentials: 'omit' },
              { path: '/api/feed', timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS },
            );
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
  /*
   * The account's own event stream, open for the whole session.
   *
   * Deliberately here and not in a chat screen: its job is to let a device that
   * HOLDS chat keys hand them over without anyone opening the room those keys
   * belong to, which is the entire reason a private room's second device used
   * to sit on "Encrypted — this device has no key for it".
   */
  useAccountEvents();

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

  /**
   * Which sign-in attempt is the one still worth listening to.
   *
   * Bumped when an attempt starts AND when one is abandoned, so a login that
   * comes back after the user gave up cannot drive the app anywhere: it finds
   * its own number stale and returns without touching phase, session, or the
   * re-entry guard. Without it, cancelling and immediately retrying would let
   * the abandoned attempt's `finally` release the guard belonging to the NEW
   * attempt, and its `catch` drop the user back to Welcome mid-login.
   */
  const signInAttemptRef = useRef(0);

  /** When the current attempt began, so an abandonment can report the wait. */
  const signInStartedAtRef = useRef(0);

  /**
   * Stop waiting on the current attempt and return to Welcome.
   *
   * Shared by the Cancel control and the hard deadline, because the two need
   * exactly the same four things done and a second copy of them is a second
   * chance to forget one — releasing `signInInflightRef` in particular, which
   * is what stopped every retry when the original hang left it stuck true.
   *
   * The host promise cannot be recalled; it is only stopped being waited on.
   * If the login does finish later the token is written and the next entry into
   * the tab is signed in, which is a better outcome than pretending otherwise.
   */
  const abandonSignIn = useCallback(
    (reason: 'cancelled' | 'timeout', waitedMs: number) => {
      signInAttemptRef.current += 1;
      signInInflightRef.current = false;
      setSignInBusy(false);
      setErrorMsg(reason === 'timeout' ? t('openstoa.welcome.signInTimedOut') : null);
      setPhase('welcome');
      console.warn(
        `[OpenStoaApp] sign-in ${reason} after ${waitedMs}ms — ` +
          'leaving authenticating phase; any late result will be ignored',
      );
    },
    [t],
  );

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
      const attempt = signInAttemptRef.current + 1;
      signInAttemptRef.current = attempt;
      /** Is this attempt still the one the app is waiting for? */
      const isCurrent = () => signInAttemptRef.current === attempt;
      const startedAt = Date.now();
      signInStartedAtRef.current = startedAt;
      void (async () => {
        /*
         * DIAGNOSTICS. The incident that produced all of this left no trace at
         * all: the code logged a success and logged a rejection, and a login
         * that did neither wrote nothing — which is why what actually triggered
         * it is still unknown. An attempt now announces itself BEFORE it can
         * hang, so the next report has a first line, a method, and a start time
         * to measure the silence from.
         */
        console.log(
          `[OpenStoaApp] sign-in attempt ${attempt} started ` +
            `(method=${method ?? 'oidc'}, deadline=${SIGN_IN_HARD_DEADLINE_MS}ms)`,
        );
        let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
        try {
          // force=true bypasses any LOGGED_OUT marker the host may still hold.
          //
          // Raced against the hard deadline: `await` on its own has no upper
          // bound, and this is a bridge call into the host — a promise it never
          // settles is not an error anything here can catch, it is simply a
          // caller that never resumes. That is what pinned the app on this
          // screen; the race is what unpins it.
          const auth = await Promise.race([
            host.loginToOpenStoa({ force: true, method }),
            new Promise<never>((_resolve, reject) => {
              deadlineTimer = setTimeout(
                () => reject(new SignInTimeoutError(SIGN_IN_HARD_DEADLINE_MS)),
                SIGN_IN_HARD_DEADLINE_MS,
              );
            }),
          ]);
          if (!isCurrent()) {
            console.warn(
              `[OpenStoaApp] sign-in attempt ${attempt} succeeded after being ` +
                `abandoned (${Date.now() - startedAt}ms) — result discarded`,
            );
            return;
          }
          // Pull the platform-wide role from /api/auth/session so admin
          // moderation affordances surface immediately after sign-in. The
          // login payload doesn't include role; fetching once here avoids
          // a "first session post-login is non-admin" race.
          let role: 'admin' | 'member' = 'member';
          try {
            const base = host.getEnvironment().openstoaBaseUrl.replace(/\/$/, '');
            const sessRes = await fetchWithTimeout(
              `${base}/api/auth/session`,
              {
                headers: { Authorization: `Bearer ${auth.token}` },
                credentials: 'omit',
              },
              { path: '/api/auth/session', timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS },
            );
            if (sessRes.ok) {
              const me = (await sessRes.json()) as { role?: string };
              if (me.role === 'admin') role = 'admin';
            }
          } catch {
            // Non-fatal — role stays 'member', user can still use the app.
          }
          session.setSession({
            token: auth.token,
            userId: auth.userId,
            needsNickname: auth.needsNickname,
            role,
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
          const waitedMs = Date.now() - startedAt;
          if (!isCurrent()) {
            // Already abandoned by Cancel; whoever abandoned it has restored
            // the phase and released the guard, and doing either again here
            // would trample a retry the user may already have started.
            console.warn(
              `[OpenStoaApp] sign-in attempt ${attempt} failed after being ` +
                `abandoned (${waitedMs}ms) — ignored`,
            );
            return;
          }
          if (err instanceof SignInTimeoutError) {
            // Said differently from a failure ON PURPOSE: nothing reported an
            // error, the host simply never came back. A log line that called
            // this "failed" would send the next reader looking for an exception
            // that does not exist.
            console.warn(
              `[OpenStoaApp] sign-in attempt ${attempt} TIMED OUT after ${waitedMs}ms ` +
                `(limit ${SIGN_IN_HARD_DEADLINE_MS}ms) — host.loginToOpenStoa never settled`,
            );
            abandonSignIn('timeout', waitedMs);
            return;
          }
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(
            `[OpenStoaApp] sign-in attempt ${attempt} failed after ${waitedMs}ms: ${msg}`,
          );
          setErrorMsg(msg === 'LOGGED_OUT' ? null : msg);
          setPhase('welcome');
        } finally {
          if (deadlineTimer) clearTimeout(deadlineTimer);
          // Only the CURRENT attempt may release the guard. An abandoned one
          // reaching here would otherwise unlock a sign-in that is still
          // running, and two host login flows at once is the exact race this
          // guard was added for.
          if (isCurrent()) {
            signInInflightRef.current = false;
            setSignInBusy(false);
          }
        }
      })();
    },
    [host, session, prefetchFeed, abandonSignIn],
  );

  /**
   * The way out of "Preparing your anonymous identity…".
   *
   * Deliberately reachable while the login is still running: the person cannot
   * be asked to guess whether the host is working or wedged, and the cost of
   * cancelling a healthy login is one more tap, against an app that has to be
   * force-quit otherwise.
   */
  const handleCancelSignIn = useCallback(() => {
    if (!signInInflightRef.current) return;
    abandonSignIn('cancelled', Date.now() - signInStartedAtRef.current);
  }, [abandonSignIn]);

  // Welcome screen sign-in CTAs — no replay needed, just kick off the shared
  // launcher with whichever method was tapped.
  const handleSignIn = useCallback(
    (method: SignInMethodId) => {
      performSignIn(undefined, method);
    },
    [performSignIn],
  );

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
    return (
      <BootScreen
        status={t('openstoa.boot.preparingIdentity')}
        onCancel={handleCancelSignIn}
        cancelLabel={t('openstoa.boot.cancelSignIn')}
        cancelHint={t('openstoa.boot.takingLonger')}
        cancelAfterMs={SIGN_IN_CANCEL_VISIBLE_AFTER_MS}
      />
    );
  }

  if (phase === 'welcome') {
    // The offered methods are handed down rather than read inside the screen:
    // `signInMethods.ts` is the single place that decides, and the Developer
    // Mode read that feeds it belongs to the app, not to onboarding chrome.
    return (
      <WelcomeScreen
        methods={signInMethods}
        onSignIn={handleSignIn}
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
          {/* Silent E2EE key-backup repair, wrapping the whole navigator so it
              reaches every signed-in account regardless of which tab they open
              — the repair is account-level and must not depend on the user
              visiting a chat room, or a Profile tab: the old key-change-only
              trigger is exactly why accounts ended up with a wrapped
              master_key and nothing to restore. It renders no UI of its own.
              The VISIBLE banner it decides on is `<RecoveryNudge />`, mounted
              on the Profile screen alone (see `RecoveryNudge.tsx`). */}
          <RecoveryRepairProvider>
            <OpenStoaTabNavigator />
          </RecoveryRepairProvider>
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
