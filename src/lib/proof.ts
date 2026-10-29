import { ethers } from 'ethers';
import {
  extractScopeFromPublicInputs,
  extractNullifierFromPublicInputs,
  extractDomainFromPublicInputs,
  verifyProofOnChain,
  RPC_ENDPOINTS,
  COINBASE_COUNTRY_PUBLIC_INPUT_LAYOUT,
  OIDC_DOMAIN_ATTESTATION_PUBLIC_INPUT_LAYOUT,
  type OidcRequestContext,
} from '@zkproofport-app/core';
import type { RelayProofResult } from '@zkproofport-app/sdk';
import { relayRequestFor } from './oidcRequestContext';

export const COMMUNITY_SCOPE = 'zkproofport-community';

export function normalizePublicInputs(input: string | string[]): string[] {
  if (Array.isArray(input)) return input;
  const hex = input.startsWith('0x') ? input.slice(2) : input;
  const chunks: string[] = [];
  for (let i = 0; i < hex.length; i += 64) {
    chunks.push('0x' + hex.slice(i, i + 64).padStart(64, '0'));
  }
  return chunks;
}

// Which chain each accepted circuit is verified on, per deployment
// environment. The verifier contract itself is never chosen here: it is the
// deployment @zkproofport-app/core pins for that circuit on that chain
// (PINNED_VERIFIERS, generated from the circuits repo's deployment records).
// Never select a verifier from a proof/relay-supplied address or chain id:
// those are only compared with the pinned one, and a mismatch is refused.
export type VerifiableCircuit =
  | 'coinbase_attestation'
  | 'coinbase_country_attestation'
  | 'oidc_domain_attestation';

const BASE_MAINNET = 8453;
const BASE_SEPOLIA = 84532;

const TESTNET_CHAINS: Record<VerifiableCircuit, number> = {
  coinbase_attestation: BASE_SEPOLIA,
  coinbase_country_attestation: BASE_SEPOLIA,
  oidc_domain_attestation: BASE_SEPOLIA,
};

export const VERIFICATION_CHAINS: Record<string, Record<VerifiableCircuit, number>> = {
  production: {
    coinbase_attestation: BASE_MAINNET,
    coinbase_country_attestation: BASE_MAINNET,
    oidc_domain_attestation: BASE_MAINNET,
  },
  staging: TESTNET_CHAINS,
  development: TESTNET_CHAINS,
  local: TESTNET_CHAINS,
};

// Exact public-input count per circuit. Anything else is not that circuit's
// proof, and is refused before an RPC call. Kept equal to core's own numbers
// by a test (SIGNER_ROOT_LAYOUTS, OIDC_PUBLIC_INPUT_COUNT).
export const PUBLIC_INPUT_COUNTS: Record<VerifiableCircuit, number> = {
  coinbase_attestation: 128,
  coinbase_country_attestation: 150,
  oidc_domain_attestation: 214,
};

const FIELD_HEX = /^0x[0-9a-fA-F]{64}$/;

/** What a relay result claims about its verifier. Compared, never used. */
export interface ClaimedVerifier {
  verifierAddress?: string;
  chainId?: number;
}

/**
 * Verify a proof against the verifier core pins for `circuit` on the chain
 * this environment uses for it. Core also checks the issuer anchor carried in
 * the public inputs: the Coinbase signer-list root, and for OIDC the token's
 * audience, nonce mode, `now` and the provider key against Google's /
 * Microsoft's live JWKS (fail closed).
 *
 * `claimed` is what a relay result said its verifier was. A differing address
 * or chain is refused rather than checked somewhere the sender did not expect.
 *
 * `oidcRequest` is the request an OIDC proof answers. A nonce-bound proof
 * (nonce_mode 1, made by the ZKProofport app) is refused without it: core
 * checks the binding only against a request it is given, so verifying one
 * without its request would accept a proof made for any other request.
 */
export async function verifyTrustedTopicProof(
  circuit: string,
  proof: string,
  publicInputs: string[],
  claimed?: ClaimedVerifier,
  oidcRequest?: OidcRequestContext,
): Promise<{ valid: boolean; error?: string }> {
  const environment = process.env.APP_ENV;
  if (!environment || !Object.hasOwn(VERIFICATION_CHAINS, environment)) {
    return { valid: false, error: `Unknown proof environment '${environment}'. Known: ${Object.keys(VERIFICATION_CHAINS).join(', ')}.` };
  }
  const chains = VERIFICATION_CHAINS[environment];
  if (!Object.hasOwn(chains, circuit)) {
    return { valid: false, error: `Unsupported verifier circuit '${circuit}'. Known: ${Object.keys(chains).join(', ')}.` };
  }
  const known = circuit as VerifiableCircuit;
  const chainId = chains[known];
  if (
    !Array.isArray(publicInputs)
    || publicInputs.length !== PUBLIC_INPUT_COUNTS[known]
    || !publicInputs.every((value) => typeof value === 'string' && FIELD_HEX.test(value))
  ) {
    return { valid: false, error: `Expected ${PUBLIC_INPUT_COUNTS[known]} 32-byte public inputs for ${circuit}` };
  }
  if (typeof proof !== 'string' || !/^0x[0-9a-fA-F]+$/.test(proof)) {
    return { valid: false, error: 'Proof is not hex' };
  }
  if (
    known === 'oidc_domain_attestation'
    && oidcRequest === undefined
    && BigInt(publicInputs[OIDC_DOMAIN_ATTESTATION_PUBLIC_INPUT_LAYOUT.NONCE_MODE]) !== 0n
  ) {
    return { valid: false, error: 'A request-bound OIDC proof (nonce_mode 1) needs the request it answers; none is known here' };
  }
  const rpcUrl = RPC_ENDPOINTS[chainId];
  if (!rpcUrl) return { valid: false, error: `No RPC endpoint for chain ${chainId}` };
  try {
    return await verifyProofOnChain(
      known,
      { proofHex: proof, publicInputsHex: publicInputs, numPublicInputs: publicInputs.length },
      new ethers.JsonRpcProvider(rpcUrl),
      { chainId },
      claimed,
      known === 'oidc_domain_attestation' && oidcRequest !== undefined ? { request: oidcRequest } : undefined,
    );
  } catch {
    return { valid: false, error: 'Proof verification failed' };
  }
}

/**
 * Verify a relay result for the request OpenStoa polled (`requestId`, never
 * the id the result carries). The circuit must be named by the result: the
 * verifier for that circuit then decides whether the proof is one, so no
 * circuit is ever guessed from input length or from the relay's verifier
 * address. The relay's verifierAddress/chainId are passed as a claim only.
 *
 * An OIDC result is verified against the request OpenStoa recorded when it
 * created it (scope + requestId, see ./oidcRequestContext). No record, or a
 * record for another circuit, refuses the proof. `request` in the answer is
 * that request, for a caller that keeps the proof for later verification.
 */
export async function verifyProofFromRelay(
  result: RelayProofResult,
  requestId: string,
): Promise<{ valid: boolean; error?: string; request?: OidcRequestContext }> {
  if (!result.circuit || !result.proof || !result.publicInputs) {
    return { valid: false, error: 'Incomplete proof result' };
  }
  const inputs = Array.isArray(result.publicInputs)
    ? result.publicInputs
    : normalizePublicInputs(result.publicInputs as unknown as string);
  const claimed = { verifierAddress: result.verifierAddress, chainId: result.chainId };
  if (result.circuit !== 'oidc_domain_attestation') {
    return verifyTrustedTopicProof(result.circuit, result.proof, inputs, claimed);
  }
  const recorded = await relayRequestFor(requestId);
  if (!recorded) {
    return { valid: false, error: `OpenStoa has no record of relay request ${requestId}; an OIDC proof cannot be bound to it` };
  }
  if (recorded.circuit !== result.circuit) {
    return { valid: false, error: `Relay request ${requestId} was created for ${recorded.circuit}, not ${result.circuit}` };
  }
  const request = { scope: recorded.scope, requestId };
  const verification = await verifyTrustedTopicProof(result.circuit, result.proof, inputs, claimed, request);
  return verification.valid ? { ...verification, request } : verification;
}


const SUPPORTED_CIRCUITS: readonly VerifiableCircuit[] = Object.keys(PUBLIC_INPUT_COUNTS) as VerifiableCircuit[];

function requireSupportedCircuit(circuit: string, what: string): VerifiableCircuit {
  if (!(SUPPORTED_CIRCUITS as readonly string[]).includes(circuit)) {
    throw new Error(`Unknown circuit '${circuit}' for ${what} extraction. Known: ${SUPPORTED_CIRCUITS.join(', ')}.`);
  }
  return circuit as VerifiableCircuit;
}

export function extractNullifier(publicInputs: string[], circuit: string): string {
  const known = requireSupportedCircuit(circuit, 'nullifier');
  const nullifier = extractNullifierFromPublicInputs(publicInputs, known);
  if (!nullifier) throw new Error(`Failed to extract nullifier for circuit: ${circuit}`);
  return nullifier;
}

export function extractScope(publicInputs: string[], circuit: string): string {
  const known = requireSupportedCircuit(circuit, 'scope');
  const scope = extractScopeFromPublicInputs(publicInputs, known);
  if (!scope) throw new Error(`Failed to extract scope for circuit: ${circuit}`);
  return scope;
}

export function computeScopeHash(scopeString: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(scopeString));
}

export function extractIsIncluded(publicInputs: string[], circuit: string): boolean {
  if (circuit !== 'coinbase_country_attestation') {
    throw new Error(`Unsupported circuit for is_included extraction: ${circuit}`);
  }
  const isIncludedField = publicInputs[COINBASE_COUNTRY_PUBLIC_INPUT_LAYOUT.IS_INCLUDED];
  if (isIncludedField === undefined) {
    throw new Error('publicInputs too short: missing is_included field');
  }
  return BigInt(isIncludedField) === 1n;
}

/**
 * Extract country list from coinbase_country_attestation public inputs.
 * country_list occupies indices 64-83 (20 bytes, up to 10 countries).
 * country_list_length at index 84 indicates how many are used.
 * Each country is 2 ASCII bytes (ISO 3166-1 alpha-2).
 */
export function extractCountryList(publicInputs: string[], circuit: string): string[] {
  if (circuit !== 'coinbase_country_attestation') {
    throw new Error(`Unsupported circuit for country_list extraction: ${circuit}`);
  }
  const lengthField = publicInputs[COINBASE_COUNTRY_PUBLIC_INPUT_LAYOUT.COUNTRY_LIST_LENGTH];
  if (lengthField === undefined) {
    throw new Error('publicInputs too short: missing country_list_length field');
  }
  const countryCount = Number(BigInt(lengthField));
  const countries: string[] = [];
  const start = COINBASE_COUNTRY_PUBLIC_INPUT_LAYOUT.COUNTRY_LIST_START;
  for (let i = 0; i < countryCount * 2; i += 2) {
    const byte1 = Number(BigInt(publicInputs[start + i]));
    const byte2 = Number(BigInt(publicInputs[start + i + 1]));
    countries.push(String.fromCharCode(byte1) + String.fromCharCode(byte2));
  }
  return countries;
}

/**
 * Extract domain from OIDC domain attestation public inputs.
 * Delegates to @zkproofport-app/core's extractDomainFromPublicInputs.
 * For AI agent path, use @zkproofport-ai/sdk's version instead.
 */
export function extractDomain(publicInputs: string[], circuit: string): string | null {
  return extractDomainFromPublicInputs(publicInputs, circuit);
}
