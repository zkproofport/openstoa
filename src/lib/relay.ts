import { ethers } from 'ethers';
import { ProofportSDK } from '@zkproofport-app/sdk';
import type { CircuitType, RelayProofResult } from '@zkproofport-app/sdk';

function createSDK(): ProofportSDK {
  const relayUrl = process.env.RELAY_URL;

  let sdk: ProofportSDK;
  if (relayUrl) {
    // Local Docker or custom relay
    sdk = new ProofportSDK({ relayUrl });
  } else {
    // Production relay (used by both staging and production)
    sdk = ProofportSDK.create();
  }

  // Ephemeral random wallet per request — only used for relay nonce replay prevention
  sdk.setSigner(ethers.Wallet.createRandom());
  return sdk;
}

// Extend SDK CircuitType with experimental circuits that ship outside of
// @zkproofport-app/sdk (the three mdl_kr_* Korea Mobile ID predicate
// circuits). The relay itself accepts any circuitId string (see
// proofport-relay/src/index.ts), and the SDK's runtime path tolerates
// unknown circuits — only its TypeScript narrowing rejects them — so a
// single `as CircuitType` cast at the call site is enough.
export type ExtendedCircuitType =
  | CircuitType
  | 'mdl_kr_ownership'
  | 'mdl_kr_age'
  | 'mdl_kr_region';

export async function createRelayProofRequest(
  scope: string,
  options?: {
    dappName?: string;
    dappIcon?: string;
    message?: string;
    circuitType?: ExtendedCircuitType;
    countryList?: string[];
    isIncluded?: boolean;
    domain?: string;
    provider?: 'google' | 'microsoft';
  },
): Promise<{ requestId: string; deepLink: string }> {
  const sdk = createSDK();
  const circuit: ExtendedCircuitType = options?.circuitType ?? 'coinbase_attestation';
  const inputs: Record<string, unknown> = { scope };
  if (circuit === 'coinbase_country_attestation') {
    inputs.countryList = options?.countryList ?? [];
    inputs.isIncluded = options?.isIncluded ?? true;
  }
  if (circuit === 'oidc_domain_attestation') {
    if (options?.domain) inputs.domain = options.domain;
    if (options?.provider) inputs.provider = options.provider;
  }

  // Default message per circuit type
  let defaultMessage: string;
  if (circuit === 'oidc_domain_attestation') {
    const providerName = options?.provider === 'microsoft' ? 'Microsoft 365' : options?.provider === 'google' ? 'Google Workspace' : 'your organization';
    defaultMessage = `Verify ${providerName} affiliation for OpenStoa`;
  } else if (circuit === 'coinbase_country_attestation') {
    defaultMessage = 'Verify your country via Coinbase attestation for OpenStoa';
  } else if (circuit === 'mdl_kr_ownership') {
    defaultMessage = 'Verify Korea Mobile ID ownership for OpenStoa';
  } else if (circuit === 'mdl_kr_age') {
    defaultMessage = 'Verify Korea Mobile ID age threshold for OpenStoa';
  } else if (circuit === 'mdl_kr_region') {
    defaultMessage = 'Verify Korea Mobile ID residence region for OpenStoa';
  } else {
    defaultMessage = 'Verify your Coinbase KYC to access OpenStoa';
  }

  // SDK CircuitType is narrowed to production circuits; mdl_kr_* are
  // forwarded verbatim to the relay (envelope-only validation; see
  // proofport-relay WALLET_SIGNATURE_CIRCUITS).
  const relay = await sdk.createRelayRequest(circuit as CircuitType, inputs as any, {
    dappName: options?.dappName ?? 'OpenStoa',
    dappIcon: options?.dappIcon ?? (
      process.env.APP_ENV === 'production' ? 'https://www.openstoa.xyz/icon.png'
        : process.env.APP_ENV === 'staging' ? 'https://stg-community.zkproofport.app/icon.png'
        : 'http://localhost:3200/icon.png'
    ),
    message: options?.message ?? defaultMessage,
  });
  return { requestId: relay.requestId, deepLink: relay.deepLink };
}

export async function pollProofResult(
  requestId: string,
): Promise<RelayProofResult> {
  const sdk = createSDK();
  return sdk.pollResult(requestId);
}

export { createSDK };
