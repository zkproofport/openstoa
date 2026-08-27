/**
 * Stub type declarations consumed by external hosts (proofport-app)
 * so they don't recurse into src/**.tsx during typecheck. Runtime
 * resolution still goes through src/index.ts via the package.json
 * `react-native` field.
 */
import type { ComponentType, ReactNode } from 'react';

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
  openstoaBaseUrl: string;
}

export type HapticType = 'light' | 'medium' | 'heavy' | 'selection';

/** One notification tap handed from the host to the mini-app. */
export interface PushNotificationTap {
  /** Stable notification id, when the host can supply one — used to de-duplicate. */
  id?: string;
  /** The server-attached `data` payload; may arrive nested under a `body` key. */
  data: Record<string, unknown>;
}

export interface HostApi {
  getEnvironment(): HostEnvironmentInfo;
  getOpenStoaToken(): Promise<string | null>;
  loginToOpenStoa(opts?: { force?: boolean; method?: 'oidc' | 'mdl'; takeover?: boolean }): Promise<AuthResult>;
  logoutFromOpenStoa(): Promise<void>;
  setOpenStoaToken(token: string): Promise<void>;
  /**
   * Optional secure KV storage (Keychain/Keystore) for MLS state persistence.
   *
   * KEEP IN LOCKSTEP WITH `types.ts`. This file is what the `types` field of
   * package.json points at, so it — not `types.ts` — is the declaration every
   * CONSUMER compiles against. A member added to one and not the other compiles
   * green inside this package and red in the host app, which is exactly how
   * `removeItem` came to exist in the contract and be unimplementable by the
   * only host there is.
   */
  secureStore?: {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
    /** Delete one entry. Optional — an older host does not have it. */
    removeItem?(key: string): Promise<void>;
  };
  /** Optional non-secure local KV (AsyncStorage) for the decrypted-message cache. */
  localStore?: {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
    /** Delete one entry. Optional — an older host does not have it. */
    removeItem?(key: string): Promise<void>;
    /** Every key in the store, wallet entries included. Optional. */
    getAllKeys?(): Promise<string[]>;
  };
  /**
   * How many messages are waiting, so the host can badge its own OpenStoa tab
   * and the app icon. The mini-app owns the number; the host owns the drawing.
   * See the full note on `HostApi.setUnreadBadge` in `types.ts`.
   */
  setUnreadBadge?(count: number): void;
  /** Optional WebAuthn PRF (react-native-passkeys) for Phase 4 E2EE key recovery. */
  passkeyPrf?(opts: {
    mode: 'create' | 'get';
    saltB64: string;
    credentialId?: string;
  }): Promise<{ credentialId: string; prfOutputB64: string }>;
  /** Optional OS push registration for Phase 6 content-free notifications. Null when unavailable. */
  registerForPush?(): Promise<{
    routingHandle: string;
    pushToken: string;
    platform: 'ios' | 'android';
  } | null>;
  /** Optional NON-prompting read of the OS notification permission. Absent → the mini-app treats the OS state as unknown. */
  getPushPermissionStatus?(): Promise<'granted' | 'denied' | 'undetermined' | 'unavailable'>;
  /** Optional subscription to notification TAPS (warm + cold start). Absent → tap routing unavailable. */
  onPushNotificationTap?(listener: (tap: PushNotificationTap) => void): () => void;
  /** Optional subscription to notifications DELIVERED but not tapped. Used for `key-needed`; never navigates. Absent → unavailable. */
  onPushNotificationReceived?(listener: (tap: PushNotificationTap) => void): () => void;
  /**
   * Optional removal of the notifications one conversation already delivered,
   * called when the user opens it. Scoped to that conversation and never the
   * whole tray — room B's banner must survive the user opening room A. Never
   * rejects. Absent → this host cannot clear notifications.
   */
  clearTopicNotifications?(topicId: string): Promise<void>;
  /**
   * Optional mirror of a Topic Archive Key into host storage the background push
   * handler can read (design §13.6 strategy A). `takB64` is base64 of exactly 32
   * raw bytes and must never be logged. Absent → no background preview on this host.
   */
  mirrorTopicArchiveKey?(topicId: string, takVersion: number, takB64: string): Promise<boolean>;
  generateProof(inputs: ProofInputs): Promise<ProofResult>;
  exitToHost(targetTab?: string): void;
  showError(code: string, details?: Record<string, unknown>): void;
  haptic?(type: HapticType): void;
  getLanguage(): 'en' | 'ko';
  onLanguageChange(listener: (lang: 'en' | 'ko') => void): () => void;
  getTheme(): 'light' | 'dark';
  onThemeChange(listener: (mode: 'light' | 'dark') => void): () => void;
  getDeveloperMode(): boolean;
  onDeveloperModeChange(listener: (enabled: boolean) => void): () => void;
}

export interface HostProviderProps {
  api: HostApi;
  children: ReactNode;
}

export const HostProvider: ComponentType<HostProviderProps>;
export const useHost: () => HostApi;
export const useHostOptional: () => HostApi | null;
