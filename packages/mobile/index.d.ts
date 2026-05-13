/**
 * Type-only entry that the embedding host (proofport-app) sees when
 * resolving `openstoa-mobile`. The runtime `index.ts` continues to be
 * what Metro picks up — declared via the package.json `react-native`
 * field. Keeping host typecheck on this file (instead of recursing into
 * src/**) means proofport-app's tsconfig does not need to provide RN
 * type roots for the mini-app's internals.
 */
import type { ComponentType, ReactNode } from 'react';

export interface OpenStoaAppProps {
  baseUrl?: string;
}

export const OpenStoaApp: ComponentType<OpenStoaAppProps>;
export const OpenStoaTabNavigator: ComponentType<Record<string, never>>;

export interface OpenStoaSessionState {
  token: string | null;
  userId: string | null;
  nickname: string | null;
  needsNickname: boolean;
  expiresAt: number | null;
  setSession(s: { token: string; userId: string; nickname?: string; needsNickname?: boolean; expiresAt?: number | null }): void;
  setNickname(nickname: string): void;
  clear(): void;
}

export const useOpenStoaSession: <T = OpenStoaSessionState>(
  selector?: (state: OpenStoaSessionState) => T,
) => T;

// Re-export bridge surface so consumers can pull both from this package.
export interface HostProviderProps {
  api: HostApi;
  children: ReactNode;
}
export const HostProvider: ComponentType<HostProviderProps>;
export const useHost: () => HostApi;
export const useHostOptional: () => HostApi | null;

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

export interface HostApi {
  getEnvironment(): HostEnvironmentInfo;
  getOpenStoaToken(): Promise<string | null>;
  loginToOpenStoa(opts?: { force?: boolean }): Promise<AuthResult>;
  logoutFromOpenStoa(): Promise<void>;
  generateProof(inputs: ProofInputs): Promise<ProofResult>;
  exitToHost(targetTab?: string): void;
  showError(code: string, details?: Record<string, unknown>): void;
  haptic?(type: HapticType): void;
}
