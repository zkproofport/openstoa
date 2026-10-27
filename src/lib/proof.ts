import { ethers } from 'ethers';
import {
  extractScopeFromPublicInputs,
  extractNullifierFromPublicInputs,
  extractDomainFromPublicInputs,
  verifyProofOnChain,
  RPC_ENDPOINTS,
  COINBASE_COUNTRY_PUBLIC_INPUT_LAYOUT,
} from '@zkproofport-app/core';
import type { RelayProofResult } from '@zkproofport-app/sdk';

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
// Korea Mobile ID has no mainnet deployment, so it verifies on Base Sepolia in
// every environment -- the same chain the app reports for it
// (proofport-app/src/config/contracts.ts, OMNIONE_TESTNET).
//
// Never select a verifier from a proof/relay-supplied address or chain id:
// those are only compared with the pinned one, and a mismatch is refused.
export type VerifiableCircuit =
  | 'coinbase_attestation'
  | 'coinbase_country_attestation'
  | 'oidc_domain_attestation'
  | 'mdl_kr_ownership'
  | 'mdl_kr_age'
  | 'mdl_kr_region';

const BASE_MAINNET = 8453;
const BASE_SEPOLIA = 84532;

const TESTNET_CHAINS: Record<VerifiableCircuit, number> = {
  coinbase_attestation: BASE_SEPOLIA,
  coinbase_country_attestation: BASE_SEPOLIA,
  oidc_domain_attestation: BASE_SEPOLIA,
  mdl_kr_ownership: BASE_SEPOLIA,
  mdl_kr_age: BASE_SEPOLIA,
  mdl_kr_region: BASE_SEPOLIA,
};

export const VERIFICATION_CHAINS: Record<string, Record<VerifiableCircuit, number>> = {
  production: {
    coinbase_attestation: BASE_MAINNET,
    coinbase_country_attestation: BASE_MAINNET,
    oidc_domain_attestation: BASE_MAINNET,
    mdl_kr_ownership: BASE_SEPOLIA,
    mdl_kr_age: BASE_SEPOLIA,
    mdl_kr_region: BASE_SEPOLIA,
  },
  staging: TESTNET_CHAINS,
  development: TESTNET_CHAINS,
  local: TESTNET_CHAINS,
};

// Exact public-input count per circuit. Anything else is not that circuit's
// proof, and is refused before an RPC call. Kept equal to core's own numbers
// by a test (SIGNER_ROOT_LAYOUTS, OIDC_PUBLIC_INPUT_COUNT, MDL_KR layout).
export const PUBLIC_INPUT_COUNTS: Record<VerifiableCircuit, number> = {
  coinbase_attestation: 128,
  coinbase_country_attestation: 150,
  oidc_domain_attestation: 148,
  mdl_kr_ownership: 97,
  mdl_kr_age: 66,
  mdl_kr_region: 96,
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
 * the public inputs: the Coinbase signer-list root, and the OIDC provider key
 * against Google's / Microsoft's live JWKS (fail closed).
 *
 * `claimed` is what a relay result said its verifier was. A differing address
 * or chain is refused rather than checked somewhere the sender did not expect.
 */
export async function verifyTrustedTopicProof(
  circuit: string,
  proof: string,
  publicInputs: string[],
  claimed?: ClaimedVerifier,
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
  const rpcUrl = RPC_ENDPOINTS[chainId];
  if (!rpcUrl) return { valid: false, error: `No RPC endpoint for chain ${chainId}` };
  try {
    return await verifyProofOnChain(
      known,
      { proofHex: proof, publicInputsHex: publicInputs, numPublicInputs: publicInputs.length },
      new ethers.JsonRpcProvider(rpcUrl),
      { chainId },
      claimed,
    );
  } catch {
    return { valid: false, error: 'Proof verification failed' };
  }
}

/**
 * Verify a relay result. The circuit must be named by the result: the
 * verifier for that circuit then decides whether the proof is one, so no
 * circuit is ever guessed from input length or from the relay's verifier
 * address. The relay's verifierAddress/chainId are passed as a claim only.
 */
export async function verifyProofFromRelay(
  result: RelayProofResult,
): Promise<{ valid: boolean; error?: string }> {
  if (!result.circuit || !result.proof || !result.publicInputs) {
    return { valid: false, error: 'Incomplete proof result' };
  }
  const inputs = Array.isArray(result.publicInputs)
    ? result.publicInputs
    : normalizePublicInputs(result.publicInputs as unknown as string);
  return verifyTrustedTopicProof(result.circuit, result.proof, inputs, {
    verifierAddress: result.verifierAddress,
    chainId: result.chainId,
  });
}


const SUPPORTED_CIRCUITS = [
  'coinbase_attestation',
  'coinbase_country_attestation',
  'oidc_domain_attestation',
  'mdl_kr_ownership',
  'mdl_kr_age',
  'mdl_kr_region',
];

// Korea Mobile ID (v4) public inputs start with scope (32) || nullifier (32),
// one byte per field, followed by a predicate-specific tail. Counts are in
// PUBLIC_INPUT_COUNTS above. Same offsets as core's MDL_KR_PUBLIC_INPUT_LAYOUT;
// this copy keeps its stricter one-byte-per-field check.
type MdlKrVariant = 'mdl_kr_ownership' | 'mdl_kr_age' | 'mdl_kr_region';

const MDL_KR_LAYOUT = {
  SCOPE_START: 0,
  NULLIFIER_START: 32,
};

// Each mdl_kr public-input field is a 32-byte hex string holding a
// single byte (Noir flattens [u8; N] arrays to one field per byte).
// Extract a byte range and re-pack as 0x-prefixed hex.
function packByteRangeAsBytes32(publicInputs: string[], start: number, length: number): string {
  if (publicInputs.length < start + length) {
    throw new Error(`publicInputs too short: need ${start + length}, got ${publicInputs.length}`);
  }
  const hex = publicInputs
    .slice(start, start + length)
    .map((field) => {
      const n = Number(BigInt(field));
      if (n < 0 || n > 0xff) {
        throw new Error(`mdl_kr field at index ${start} expected single byte, got ${n}`);
      }
      return n.toString(16).padStart(2, '0');
    })
    .join('');
  return '0x' + hex;
}

function isMdlKr(circuit: string): circuit is MdlKrVariant {
  return (
    circuit === 'mdl_kr_ownership' ||
    circuit === 'mdl_kr_age' ||
    circuit === 'mdl_kr_region'
  );
}

export function extractNullifier(publicInputs: string[], circuit: string): string {
  if (!SUPPORTED_CIRCUITS.includes(circuit)) {
    throw new Error(`Unsupported circuit for nullifier extraction: ${circuit}`);
  }
  if (isMdlKr(circuit)) {
    return packByteRangeAsBytes32(publicInputs, MDL_KR_LAYOUT.NULLIFIER_START, 32);
  }
  const nullifier = extractNullifierFromPublicInputs(publicInputs, circuit);
  if (!nullifier) throw new Error(`Failed to extract nullifier for circuit: ${circuit}`);
  return nullifier;
}

export function extractScope(publicInputs: string[], circuit: string): string {
  if (!SUPPORTED_CIRCUITS.includes(circuit)) {
    throw new Error(`Unsupported circuit for scope extraction: ${circuit}`);
  }
  if (isMdlKr(circuit)) {
    return packByteRangeAsBytes32(publicInputs, MDL_KR_LAYOUT.SCOPE_START, 32);
  }
  const scope = extractScopeFromPublicInputs(publicInputs, circuit);
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
