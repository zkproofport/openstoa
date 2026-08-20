/**
 * Public contract between an OpenStoa-mobile mini-app and its hosting
 * environment (ZKProofport host, or a standalone shell). All capabilities
 * that depend on the surrounding runtime (proof generation, secure storage,
 * navigation, error display, …) flow through HostApi so that the mini-app
 * itself stays host-agnostic and can run unchanged inside any shell.
 */

export type CircuitId =
  | 'coinbase_attestation'
  | 'coinbase_country_attestation'
  | 'oidc_domain_attestation';

export interface ProofResult {
  proof: string;
  publicInputs: string[];
  numPublicInputs?: number;
}

export interface ProofInputs {
  scope: string;
  circuit: CircuitId;
  // Optional inputs surfaced for non-default circuits — host decides what to use.
  countryList?: string[];
  isIncluded?: boolean;
  domain?: string;
  provider?: 'google' | 'microsoft';
}

export interface AuthResult {
  token: string;
  userId: string;
  needsNickname: boolean;
}

export interface HostEnvironmentInfo {
  isEmbedded: boolean;
  hostName: 'zkproofport' | 'standalone' | string;
  appVersion?: string;
  platform?: 'ios' | 'android' | string;
  /** Base URL of the OpenStoa server (e.g. https://www.openstoa.xyz). */
  openstoaBaseUrl: string;
}

export type HapticType = 'light' | 'medium' | 'heavy' | 'selection';

/** One notification tap handed from the host to the mini-app. */
export interface PushNotificationTap {
  /**
   * Stable id of the notification that was tapped, when the host can supply
   * one. Used purely to de-duplicate: a cold-start replay and the OS listener
   * can both surface the SAME tap, and routing twice would re-navigate.
   */
  id?: string;
  /**
   * The `data` payload the server attached (`{ topicId, messageId, epoch, ct }`
   * — see `openstoa/src/lib/push.ts`). Passed through as-is: Expo does NOT
   * splice `data` into the top level of the APNs payload, so depending on the
   * transport the routing keys can also arrive nested under a `body` key. The
   * mini-app unwraps both shapes rather than trusting one.
   */
  data: Record<string, unknown>;
}

export interface HostApi {
  /** Synchronous metadata about the host shell. */
  getEnvironment(): HostEnvironmentInfo;

  /** Persisted OpenStoa JWT, or null if not authenticated. */
  getOpenStoaToken(): Promise<string | null>;

  /**
   * Run the full self-relay login flow (proof-request → mopro → relay
   * callback → poll?format=token). Resolves with the new token. If a valid
   * token already exists the host may short-circuit and return it as-is.
   */
  loginToOpenStoa(opts?: {
    force?: boolean;
    /**
     * Which proof flavor to run. The mini-app already passes this
     * (`OpenStoaApp.performSignIn`) and ZKProofport already implements it
     * (`zkProofportHostApi.loginToOpenStoa`) — it was missing from the type
     * only, and nothing caught that because `packages/mobile` is excluded from
     * every tsconfig in the repo (see the host's `tsconfig.json` exclude).
     * Omitted → the host's default (OIDC).
     */
    method?: 'oidc' | 'mdl';
  }): Promise<AuthResult>;

  /** Drop the cached token; subsequent API calls must re-authenticate. */
  logoutFromOpenStoa(): Promise<void>;

  /**
   * Replace the persisted OpenStoa token. Used when an API response
   * (e.g. nickname update, profile change) returns a freshly-reissued
   * JWT so the mini-app's next request carries the new claims instead
   * of the stale Bearer.
   */
  setOpenStoaToken(token: string): Promise<void>;

  /**
   * Optional host-provided secure key→value storage (iOS Keychain / Android
   * Keystore via expo-secure-store on ZKProofport). The mini-app uses it to
   * persist E2EE chat MLS ClientState (~2KB/topic) across app restarts so it
   * restores the same leaf instead of re-joining (a re-join drops history).
   * When absent, the mini-app keeps MLS state in memory only.
   */
  secureStore?: {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
  };

  /**
   * Optional host-provided non-secure local KV (AsyncStorage on ZKProofport).
   * Used for bulk, less-sensitive data the mini-app must persist across
   * restarts — e.g. the E2EE chat decrypted-message cache (plaintext keyed by
   * message id). MLS deletes per-message keys on decryption, so without this
   * cache message history can't be re-decrypted after a restart. Not the
   * secure store (Keychain is for keys, not many bulk rows).
   */
  localStore?: {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
  };

  /**
   * Optional host-provided WebAuthn PRF (hmac-secret) for Phase 4 E2EE key
   * recovery (design §6.2/§6.4). The host (react-native-passkeys on ZKProofport)
   * registers/asserts a synced passkey and evaluates PRF with `saltB64`,
   * returning a deterministic 32-byte output the mini-app derives a master_key
   * wrapping key from. `mode: 'create'` registers a new passkey (first-time
   * backup); `'get'` asserts an existing one (recovery). Because the passkey is
   * synced (iCloud Keychain / Google Password Manager), the same salt yields the
   * same PRF on any of the user's devices → cross-device master_key recovery with
   * no escrow. Absent → passkey recovery unavailable on this host; the
   * recovery-code path still works.
   */
  passkeyPrf?(opts: {
    mode: 'create' | 'get';
    /** base64 domain-separation salt (fixed per app) fed to the PRF eval. */
    saltB64: string;
    /** For 'get': the credential to assert. Omitted on 'create'. */
    credentialId?: string;
  }): Promise<{ credentialId: string; prfOutputB64: string }>;

  /**
   * Optional host-provided OS push registration for Phase 6 content-free
   * notifications (design §13, D12-D14). The host requests notification
   * permission and obtains an OS/Expo push token, returning it alongside a
   * stable, client-generated opaque `routingHandle` (persisted by the host so
   * it survives restarts; NO rotation in Phase A). The mini-app POSTs the result
   * to `/api/push/register` so the near-blind gateway can map `routingHandle →
   * pushToken`. The server only ever sends a DUMMY "New message" — no message
   * content leaves the device unencrypted. Returns null when push is
   * unavailable on this host (permission denied, no push support, simulator),
   * in which case the mini-app simply skips registration.
   */
  registerForPush?(): Promise<{
    routingHandle: string;
    pushToken: string;
    platform: 'ios' | 'android';
  } | null>;

  /**
   * Optional host-provided READ of the OS notification permission, WITHOUT
   * prompting (expo-notifications `getPermissionsAsync`, not
   * `requestPermissionsAsync`). The mini-app's in-app notification switch is a
   * server-side preference and cannot see the OS state on its own, so without
   * this it can only report "we asked the OS and got nothing back". With it the
   * settings screen can say "blocked in system settings" up front and offer to
   * open them.
   *
   *   - `granted`      — the OS will deliver pushes (incl. iOS provisional).
   *   - `denied`       — the user declined; only system settings can undo it.
   *   - `undetermined` — never asked yet; registering will prompt.
   *   - `unavailable`  — no push on this build/device (simulator, no EAS
   *                      project id, unsupported host).
   *
   * Absent → the mini-app degrades to "unknown" and simply shows the in-app
   * switch with no OS-level claim.
   */
  getPushPermissionStatus?(): Promise<
    'granted' | 'denied' | 'undetermined' | 'unavailable'
  >;

  /**
   * Optional host-provided subscription to notification TAPS (design §13,
   * P-O gap 5). Without it a chat push is delivered but tapping it does
   * nothing — the mini-app never learns which topic the user came from.
   *
   * The host MUST cover both entry paths:
   *   - the app was already running or backgrounded when the tap happened
   *     (expo-notifications `addNotificationResponseReceivedListener`), and
   *   - the app was LAUNCHED by the tap (`getLastNotificationResponseAsync`).
   *     A cold-start tap is latched by the host and replayed to the first
   *     subscriber, so a mini-app that subscribes a moment after launch still
   *     receives it.
   *
   * Returns an unsubscribe function; the mini-app calls it on unmount.
   * Absent → tap routing is simply unavailable on this host (older binary,
   * standalone shell) and the mini-app degrades to a clean no-op.
   */
  onPushNotificationTap?(
    listener: (tap: PushNotificationTap) => void,
  ): () => void;

  /**
   * Optional host-provided subscription to notifications that were DELIVERED
   * but NOT tapped (expo-notifications `addNotificationReceivedListener`).
   *
   * Distinct from `onPushNotificationTap` because the two carry different
   * intent: a tap is the user asking to go somewhere, a delivery is only
   * information. Acting on a delivery must never navigate.
   *
   * The mini-app uses it for `key-needed` (design §13.7): on the scoped chat
   * tiers a device that just joined can read nothing until a device already
   * holding the keys hands them over, and the holder is almost never in that
   * room. This lets it grant without its owner doing anything.
   *
   * Deliveries that arrive while the mini-app is unmounted are latched by the
   * host and replayed, oldest first, to the next subscriber. Returns an
   * unsubscribe function. Absent → the mini-app degrades to acting only on the
   * account event stream and on room entry.
   */
  onPushNotificationReceived?(
    listener: (tap: PushNotificationTap) => void,
  ): () => void;

  /**
   * Optional host-provided mirror of a Topic Archive Key into wherever the
   * host's background push handler can read it (design §13.6 strategy A).
   *
   * The handler that decorates an incoming chat notification with a real
   * preview runs OUTSIDE the mini-app — an iOS Notification Service Extension
   * in its own process, an Android FCM service with no JS runtime attached —
   * so it cannot ask the mini-app for the key. It has to find the key already
   * sitting in host-owned storage. This is how it gets there.
   *
   * It is the TAK and never an MLS key: opening the live MLS ciphertext would
   * consume a forward-secret ratchet key, after which the mini-app could no
   * longer derive the same key and the group would desync. The TAK is a stable
   * symmetric key, so a background decrypt with it consumes nothing.
   *
   * On iOS the mini-app writes this itself through `secureStore` into the
   * shared Keychain access group, so this member is only consulted on hosts
   * that need a platform-specific path (Android, where the key goes into a
   * Keystore-encrypted store the host's FCM service owns).
   *
   * `takB64` is base64 of exactly 32 raw bytes. It is raw key material: the
   * host MUST keep it on-device and MUST NOT log it.
   *
   * Resolves true only when the key was actually stored. Never rejects, and
   * absent → the host has no background preview path, in which case the
   * recipient simply keeps getting the content-free "New message".
   */
  mirrorTopicArchiveKey?(
    topicId: string,
    takVersion: number,
    takB64: string,
  ): Promise<boolean>;

  /** Generate a ZK proof on the host (e.g. via mopro on ZKProofport). */
  generateProof(inputs: ProofInputs): Promise<ProofResult>;

  /**
   * Leave OpenStoa and surface a host-specific destination. On the
   * ZKProofport host this navigates to the chosen tab; on standalone this
   * is a no-op (or a deep link to ZKProofport, if available).
   */
  exitToHost(targetTab?: string): void;

  /** Display an error using the host's UX (ErrorModal, toast, etc.). */
  showError(code: string, details?: Record<string, unknown>): void;

  /** Optional haptic feedback hook — host may ignore. */
  haptic?(type: HapticType): void;

  /** Current host-controlled UI language. */
  getLanguage(): 'en' | 'ko';

  /**
   * Subscribe to host language changes. Returns an unsubscribe function.
   * Mini-app should call this on mount and tear down on unmount.
   */
  onLanguageChange(listener: (lang: 'en' | 'ko') => void): () => void;

  /** Current host-controlled UI theme mode. */
  getTheme(): 'light' | 'dark';

  /**
   * Subscribe to host theme changes. Returns an unsubscribe function.
   * Mini-app should call this on mount and tear down on unmount.
   */
  onThemeChange(listener: (mode: 'light' | 'dark') => void): () => void;

  /**
   * Whether the host has Developer Mode enabled. Mini-app uses this to
   * gate experimental affordances (e.g. mDL login) so they only appear
   * when the host user has explicitly opted in.
   *
   * Returns `false` on hosts that don't expose Developer Mode.
   */
  getDeveloperMode(): boolean;

  /**
   * Subscribe to host Developer Mode toggle changes. Returns an
   * unsubscribe function. Mini-app should call this on mount and tear
   * it down on unmount.
   */
  onDeveloperModeChange(listener: (enabled: boolean) => void): () => void;
}
