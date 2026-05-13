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

export interface HostApi {
  getEnvironment(): HostEnvironmentInfo;
  getOpenStoaToken(): Promise<string | null>;
  loginToOpenStoa(opts?: { force?: boolean }): Promise<AuthResult>;
  logoutFromOpenStoa(): Promise<void>;
  generateProof(inputs: ProofInputs): Promise<ProofResult>;
  exitToHost(targetTab?: string): void;
  showError(code: string, details?: Record<string, unknown>): void;
  haptic?(type: HapticType): void;
  getLanguage(): 'en' | 'ko';
  onLanguageChange(listener: (lang: 'en' | 'ko') => void): () => void;
  getTheme(): 'light' | 'dark';
  onThemeChange(listener: (mode: 'light' | 'dark') => void): () => void;
}

export interface HostProviderProps {
  api: HostApi;
  children: ReactNode;
}

export const HostProvider: ComponentType<HostProviderProps>;
export const useHost: () => HostApi;
export const useHostOptional: () => HostApi | null;
