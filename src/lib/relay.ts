import { ethers } from 'ethers';
import { ProofportSDK } from '@zkproofport-app/sdk';
import type { RelayProofResult } from '@zkproofport-app/sdk';

function createSDK(): ProofportSDK {
  const relayUrl = process.env.RELAY_URL;
  const relayEnv = process.env.RELAY_ENV;

  let sdk: ProofportSDK;
  if (relayUrl) {
    // Local Docker or custom relay
    sdk = new ProofportSDK({ relayUrl });
  } else if (relayEnv === 'staging') {
    sdk = ProofportSDK.create('staging');
  } else {
    // Production (default, no config needed)
    sdk = ProofportSDK.create();
  }

  // Ephemeral random wallet per request — only used for relay nonce replay prevention
  sdk.setSigner(ethers.Wallet.createRandom());
  return sdk;
}

/**
 * Get the server-side relay URL for direct fetch calls.
 * Uses RELAY_URL if set (Docker), otherwise derives from SDK environment.
 */
export function getServerRelayUrl(): string {
  const relayUrl = process.env.RELAY_URL;
  if (relayUrl) return relayUrl;
  if (process.env.RELAY_ENV === 'staging') return 'https://stg-relay.zkproofport.app';
  return 'https://relay.zkproofport.app';
}

export async function createRelayProofRequest(
  scope: string,
  options?: { dappName?: string; message?: string },
): Promise<{ requestId: string; deepLink: string }> {
  const sdk = createSDK();
  const relay = await sdk.createRelayRequest('coinbase_attestation', { scope }, {
    dappName: options?.dappName ?? 'ZK Community',
    message: options?.message,
  });
  return { requestId: relay.requestId, deepLink: relay.deepLink };
}

export async function waitForProofResult(
  requestId: string,
  timeoutMs: number = 300_000,
): Promise<RelayProofResult> {
  const sdk = createSDK();
  return sdk.waitForProof(requestId, { timeoutMs });
}

export { createSDK };
