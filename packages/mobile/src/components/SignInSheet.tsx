import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { useOpenStoaSession } from '../stores/sessionStore';
import { useSignInLauncher } from '../auth/SignInLauncher';
import { subscribeSessionExpired } from '../auth/sessionExpiry';
import { useThemeColors } from '../theme/ThemeContext';
import { useDeveloperMode } from '../hooks/useDeveloperMode';
import { RADIUS, TYPE_SCALE } from '../theme/tokens';

interface SignInSheetContextValue {
  /**
   * If the user is already signed in, runs `onSignedIn` synchronously
   * (when provided) and returns true.
   *
   * If the user is a guest, opens the sign-in sheet, queues `onSignedIn`
   * to fire on successful sign-in, and returns false. This gives callers
   * a one-line auto-replay pattern:
   *
   * ```ts
   * signInGate.require(() => doVote());
   * ```
   *
   * Callers that prefer the old "return false, do nothing" semantics can
   * still call `if (!signInGate.require()) return;` — no callback, no replay.
   */
  require: (onSignedIn?: () => void) => boolean;
  /** Force-open the sheet (e.g. after catching a GuestAuthRequiredError). */
  open: (onSignedIn?: () => void) => void;
  /** Programmatically dismiss the sheet. Rarely needed by callers. */
  close: () => void;
  /** Convenience boolean — handy for conditional UI without re-rendering on every keystroke. */
  isGuest: boolean;
}

const SignInSheetContext = createContext<SignInSheetContextValue | null>(null);

export function useSignInGate(): SignInSheetContextValue {
  const ctx = useContext(SignInSheetContext);
  if (!ctx) {
    throw new Error(
      '[openstoa-mobile] useSignInGate() called outside SignInSheetProvider',
    );
  }
  return ctx;
}

export interface SignInSheetProviderProps {
  children: ReactNode;
}

export function SignInSheetProvider({ children }: SignInSheetProviderProps) {
  const session = useOpenStoaSession();
  const launcher = useSignInLauncher();
  const { t } = useTranslation();
  const { colors } = useThemeColors();
  // mDL sign-in is host-experimental — only surface it when Developer Mode
  // is enabled on the host. Re-renders automatically on toggle.
  const developerMode = useDeveloperMode();
  const [visible, setVisible] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  // Which copy the sheet shows. 'guest' is the ordinary "sign in to do
  // this" gate (screens opt in explicitly via `require()`/`open()`).
  // 'expired' means the sheet opened ITSELF because the server just
  // refused an authenticated request — see the effect below. The two are
  // NOT interchangeable: a person who was already signed in and did
  // nothing new needs "your session ended", not "sign in to continue".
  const [reason, setReason] = useState<'guest' | 'expired'>('guest');
  // Queue of "what to do after sign-in completes". Stored in a ref so
  // re-rendering callers don't lose the pending action between renders.
  // Cleared on: successful sign-in (after firing), cancel, or error.
  const pendingActionRef = useRef<(() => void) | null>(null);

  const isGuest = session.mode !== 'authenticated';

  const open = useCallback((onSignedIn?: () => void) => {
    if (onSignedIn) pendingActionRef.current = onSignedIn;
    setErrorMsg(null);
    setReason('guest');
    setVisible(true);
  }, []);

  const close = useCallback(() => {
    // User dismissed without signing in — drop any queued action so it
    // doesn't surprise them on the next sign-in attempt.
    pendingActionRef.current = null;
    setVisible(false);
  }, []);

  // Pop the sheet UNPROMPTED the moment a session gets refused server-side
  // (see openstoaClient.ts `dropDeadSession` -> sessionLifecycle.ts
  // `onSessionDropped` -> `notifySessionExpired`). No `onSignedIn` is
  // queued here: the request that surfaced this has already failed and
  // returned, so there is nothing left to auto-replay — the person has to
  // retry their own action after signing back in.
  useEffect(() => {
    return subscribeSessionExpired(() => {
      pendingActionRef.current = null;
      setErrorMsg(null);
      setReason('expired');
      setVisible(true);
    });
  }, []);

  const require = useCallback(
    (onSignedIn?: () => void): boolean => {
      if (session.mode === 'authenticated') {
        // Fire the action synchronously so callers can use the same
        // line for both the "already signed in" and "guest gates" cases.
        if (onSignedIn) onSignedIn();
        return true;
      }
      open(onSignedIn);
      return false;
    },
    [session.mode, open],
  );

  const runLauncher = useCallback(
    (method?: 'oidc' | 'mdl') => {
      // Hand off to the launcher — OpenStoaApp will switch to the
      // `'authenticating'` BootScreen and run the host proof flow there.
      // We close the sheet first so the proof modal has a clean modal
      // slot to present into (iOS can't reliably stack Modal-over-Modal).
      // `pendingActionRef.current` is intentionally NOT cleared here — it
      // survives the dismissal so the launcher's onSuccess can replay it.
      setErrorMsg(null);
      setVisible(false);
      launcher(() => {
        const replay = pendingActionRef.current;
        pendingActionRef.current = null;
        if (replay) {
          try {
            replay();
          } catch {
            // Swallow — the action handler owns its own error UX.
          }
        }
      }, method);
    },
    [launcher],
  );

  const handleSignIn = useCallback(() => runLauncher('oidc'), [runLauncher]);
  const handleSignInMdl = useCallback(() => runLauncher('mdl'), [runLauncher]);

  const value = useMemo<SignInSheetContextValue>(
    () => ({ require, open, close, isGuest }),
    [require, open, close, isGuest],
  );

  return (
    <SignInSheetContext.Provider value={value}>
      {children}
      <Modal
        visible={visible}
        transparent
        animationType="fade"
        onRequestClose={close}
        statusBarTranslucent
      >
        <Pressable style={styles.backdrop} onPress={close}>
          <Pressable
            style={[
              styles.sheet,
              { backgroundColor: colors.background.primary },
            ]}
            onPress={(e) => e.stopPropagation()}
          >
            <View
              style={[styles.handle, { backgroundColor: colors.border.strong }]}
            />
            <Text style={[styles.title, { color: colors.text.primary }]}>
              {reason === 'expired'
                ? t('openstoa.signInPrompt.expiredTitle')
                : t('openstoa.signInPrompt.title')}
            </Text>
            <Text style={[styles.body, { color: colors.text.secondary }]}>
              {reason === 'expired'
                ? t('openstoa.signInPrompt.expiredBody')
                : t('openstoa.signInPrompt.body')}
            </Text>

            {errorMsg ? (
              <Text style={[styles.error, { color: colors.status.danger }]}>
                {errorMsg}
              </Text>
            ) : null}

            <Pressable
              onPress={handleSignIn}
              style={({ pressed }) => [
                styles.primary,
                {
                  backgroundColor: colors.brand.primary,
                  opacity: pressed ? 0.85 : 1,
                },
              ]}
            >
              <Text style={styles.primaryText}>
                {t('openstoa.signInPrompt.primary')}
              </Text>
            </Pressable>

            {developerMode ? (
              <Pressable
                onPress={handleSignInMdl}
                style={({ pressed }) => [
                  styles.mdl,
                  {
                    borderColor: colors.brand.primary,
                    opacity: pressed ? 0.85 : 1,
                  },
                ]}
              >
                <Text style={[styles.mdlText, { color: colors.brand.primary }]}>
                  {t('openstoa.signInPrompt.primaryMdl')}
                </Text>
              </Pressable>
            ) : null}

            <Pressable
              onPress={close}
              style={({ pressed }) => [
                styles.secondary,
                { opacity: pressed ? 0.7 : 1 },
              ]}
            >
              <Text
                style={[
                  styles.secondaryText,
                  { color: colors.text.secondary },
                ]}
              >
                {t('openstoa.signInPrompt.cancel')}
              </Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
    </SignInSheetContext.Provider>
  );
}

/**
 * Reusable sign-in card for full-screen guest states (e.g. ProfileTab,
 * ChatTab). Tapping the CTA opens the SignInSheet via the gate context.
 */
export function GuestSignInCard({
  title,
  body,
  cta,
}: {
  title?: string;
  body?: string;
  cta?: string;
}) {
  const { t } = useTranslation();
  const { colors } = useThemeColors();
  const { open } = useSignInGate();

  return (
    <View
      style={[
        cardStyles.card,
        { backgroundColor: colors.background.secondary },
      ]}
    >
      <Text style={[cardStyles.title, { color: colors.text.primary }]}>
        {title ?? t('openstoa.signInPrompt.guestCardTitle')}
      </Text>
      <Text style={[cardStyles.body, { color: colors.text.secondary }]}>
        {body ?? t('openstoa.signInPrompt.guestCardBody')}
      </Text>
      <Pressable
        onPress={open}
        style={({ pressed }) => [
          cardStyles.button,
          {
            backgroundColor: colors.brand.primary,
            opacity: pressed ? 0.85 : 1,
          },
        ]}
      >
        <Text style={cardStyles.buttonText}>
          {cta ?? t('openstoa.signInPrompt.guestCardCta')}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  sheet: {
    paddingHorizontal: 24,
    paddingTop: 12,
    paddingBottom: 32,
    borderTopLeftRadius: RADIUS.modal,
    borderTopRightRadius: RADIUS.modal,
  },
  handle: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: RADIUS.pill,
    marginBottom: 18,
  },
  title: {
    fontSize: TYPE_SCALE.headingSmall,
    fontWeight: '700',
    letterSpacing: -0.3,
    marginBottom: 10,
  },
  body: {
    fontSize: TYPE_SCALE.body,
    lineHeight: 20,
    marginBottom: 18,
  },
  error: {
    fontSize: TYPE_SCALE.caption,
    fontWeight: '500',
    marginBottom: 12,
  },
  primary: {
    height: 48,
    borderRadius: RADIUS.card,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 4,
  },
  primaryText: {
    color: '#FFFFFF',
    fontSize: TYPE_SCALE.body,
    fontWeight: '700',
  },
  mdl: {
    height: 48,
    borderRadius: RADIUS.card,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 8,
    borderWidth: 1.5,
    backgroundColor: 'transparent',
  },
  mdlText: {
    fontSize: TYPE_SCALE.bodySmall,
    fontWeight: '700',
  },
  secondary: {
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 6,
  },
  secondaryText: {
    fontSize: TYPE_SCALE.bodySmall,
    fontWeight: '600',
  },
});

const cardStyles = StyleSheet.create({
  card: {
    margin: 16,
    padding: 20,
    borderRadius: RADIUS.card,
  },
  title: {
    fontSize: TYPE_SCALE.body,
    fontWeight: '700',
    marginBottom: 8,
    letterSpacing: -0.2,
  },
  body: {
    fontSize: TYPE_SCALE.bodySmall,
    lineHeight: 20,
    marginBottom: 16,
  },
  button: {
    height: 44,
    borderRadius: RADIUS.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonText: {
    color: '#FFFFFF',
    fontSize: TYPE_SCALE.bodySmall,
    fontWeight: '700',
  },
});
