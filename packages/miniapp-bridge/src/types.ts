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
  loginToOpenStoa(opts?: { force?: boolean }): Promise<AuthResult>;

  /** Drop the cached token; subsequent API calls must re-authenticate. */
  logoutFromOpenStoa(): Promise<void>;

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
}
