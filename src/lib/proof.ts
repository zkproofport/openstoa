import { ethers } from 'ethers';
import { createSDK } from './relay';
import {
  extractScopeFromPublicInputs,
  extractNullifierFromPublicInputs,
  extractDomainFromPublicInputs,
  COINBASE_COUNTRY_PUBLIC_INPUT_LAYOUT,
} from '@zkproofport-app/sdk';
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

// mdl_kr_* verifiers are not part of @zkproofport-app/sdk (Korea Mobile ID
// PoC). All three predicate verifiers share the HonkVerifier ABI; their
// addresses are resolved at runtime from the circuits-repo Foundry
// broadcast JSON, with the latest known deployment as the fallback if
// the fetch fails. The resolution is cached in-process for 5 minutes.
type MdlKrVariant = 'mdl_kr_ownership' | 'mdl_kr_age' | 'mdl_kr_region';

const MDL_KR_VERIFIER_FALLBACK: Record<MdlKrVariant, string> = {
  // v4 (HS256-pending): nullifier = keccak(keccak(ci) || scope). signal_hash
  // and cx_integrity_root removed from public inputs.
  mdl_kr_ownership: '0x7602D09d24E6E16efF5AB981646872886376763E',
  mdl_kr_age:       '0xcFF90FF8cEADc98f625300dc976eD85A3AA943Ba',
  mdl_kr_region:    '0x435F0448F02F5Df9659D460181116BCaF37E518E',
};

const MDL_KR_VERIFIER_ABI = [
  'function verify(bytes calldata _proof, bytes32[] calldata _publicInputs) external view returns (bool)',
] as const;

const MDL_KR_BROADCAST_URL: Record<MdlKrVariant, string> = {
  mdl_kr_ownership:
    'https://raw.githubusercontent.com/zkproofport/circuits/main/broadcast/DeployMdlKrOwnership.s.sol/84532/run-latest.json',
  mdl_kr_age:
    'https://raw.githubusercontent.com/zkproofport/circuits/main/broadcast/DeployMdlKrAge.s.sol/84532/run-latest.json',
  mdl_kr_region:
    'https://raw.githubusercontent.com/zkproofport/circuits/main/broadcast/DeployMdlKrRegion.s.sol/84532/run-latest.json',
};

interface CachedAddress { address: string; fetchedAt: number; }
const mdlKrAddressCache: Partial<Record<MdlKrVariant, CachedAddress>> = {};
const MDL_KR_CACHE_TTL_MS = 5 * 60 * 1000;

async function resolveMdlKrVerifierAddress(variant: MdlKrVariant): Promise<string> {
  const now = Date.now();
  const cached = mdlKrAddressCache[variant];
  if (cached && now - cached.fetchedAt < MDL_KR_CACHE_TTL_MS) {
    return cached.address;
  }
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    const res = await fetch(MDL_KR_BROADCAST_URL[variant], { signal: controller.signal });
    clearTimeout(timeout);
    if (res.ok) {
      const broadcast = (await res.json()) as { transactions?: Array<{ contractName?: string; contractAddress?: string }> };
      const tx = broadcast.transactions?.find((t) => t.contractName === 'HonkVerifier');
      if (tx?.contractAddress) {
        mdlKrAddressCache[variant] = { address: tx.contractAddress, fetchedAt: now };
        return tx.contractAddress;
      }
    }
  } catch {
    // network/JSON failure -> fall back below
  }
  return MDL_KR_VERIFIER_FALLBACK[variant];
}

async function verifyMdlKrOnChain(
  variant: MdlKrVariant,
  result: RelayProofResult,
): Promise<{ valid: boolean; error?: string }> {
  const rpcUrl = process.env.RPC_URL || 'https://sepolia.base.org';
  const verifierAddress = await resolveMdlKrVerifierAddress(variant);
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const verifier = new ethers.Contract(
    verifierAddress,
    MDL_KR_VERIFIER_ABI,
    provider,
  );
  try {
    const publicInputs = Array.isArray(result.publicInputs)
      ? result.publicInputs
      : normalizePublicInputs(result.publicInputs as unknown as string);
    const ok: boolean = await verifier.verify(result.proof, publicInputs);
    return { valid: ok };
  } catch (err) {
    return {
      valid: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function verifyProofFromRelay(
  result: RelayProofResult,
): Promise<{ valid: boolean; error?: string }> {
  const inputs = Array.isArray(result.publicInputs)
    ? result.publicInputs
    : normalizePublicInputs(result.publicInputs as unknown as string);
  const detected = detectCircuit(inputs, result.verifierAddress);
  if (
    detected === 'mdl_kr_ownership' ||
    detected === 'mdl_kr_age' ||
    detected === 'mdl_kr_region' ||
    result.circuit === 'mdl_kr_ownership' ||
    result.circuit === 'mdl_kr_age' ||
    result.circuit === 'mdl_kr_region'
  ) {
    const variant = (result.circuit as MdlKrVariant | undefined) ?? (detected as MdlKrVariant);
    return verifyMdlKrOnChain(variant, result);
  }
  const sdk = createSDK();
  return sdk.verifyResponseOnChain(result as any);
}


const SUPPORTED_CIRCUITS = [
  'coinbase_attestation',
  'coinbase_country_attestation',
  'oidc_domain_attestation',
  'mdl_kr_ownership',
  'mdl_kr_age',
  'mdl_kr_region',
];

// All three mdl_kr_* circuits share the same first four public-input
// blocks (signal_hash, scope, nullifier_value, cx_integrity_root) at the
// same offsets, so scope/nullifier extraction is identical across them.
//   signal_hash       [0..32]
//   scope             [32..64]
//   nullifier_value   [64..96]
//   cx_integrity_root [96..128]
//   ... predicate-specific fields after that ...
//
// Total public-input field counts (used by detectCircuit):
//   ownership: 32 + 32 + 32 + 32 + 1 + 32 = 161
//   age:       32 + 32 + 32 + 32 + 1 + 1  = 130
//   region:    32 + 32 + 32 + 32 + 32     = 160
// v4 layout — signal_hash and cx_integrity_root removed. Public inputs now
// start with scope (32) || nullifier_value (32) || predicate-specific tail.
const MDL_KR_LAYOUT = {
  SCOPE_START: 0,
  NULLIFIER_START: 32,
  OWNERSHIP_FIELDS: 97,   // scope(32) + nullifier(32) + disclose_flags(1) + owner_commit(32)
  AGE_FIELDS: 66,         // scope(32) + nullifier(32) + age_threshold(1) + current_year(1)
  REGION_FIELDS: 96,      // scope(32) + nullifier(32) + region_code(32)
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
 * Delegates to @zkproofport-app/sdk's extractDomainFromPublicInputs.
 * For AI agent path, use @zkproofport-ai/sdk's version instead.
 */
export function extractDomain(publicInputs: string[], circuit: string): string | null {
  return extractDomainFromPublicInputs(publicInputs, circuit);
}

// Known verifier addresses → circuit mapping (Base Mainnet for SDK
// circuits + Base Sepolia for the mdl_kr_* PoC). Address keys are
// lower-cased so callers can match against verifierAddress.toLowerCase().
const VERIFIER_CIRCUIT_MAP: Record<string, string> = {
  '0xf7ded73e7a7fc8fb030c35c5a88d40abe6865382': 'coinbase_attestation',
  '0x9677ba46ad226ce8b3c4517d9c0143e4d458beae': 'oidc_domain_attestation',
  '0x7602d09d24e6e16eff5ab981646872886376763e': 'mdl_kr_ownership',
  '0xcff90ff8ceadc98f625300dc976ed85a3aa943ba': 'mdl_kr_age',
  '0x435f0448f02f5df9659d460181116bcaf37e518e': 'mdl_kr_region',
};

export function detectCircuit(publicInputs: string[], verifierAddress?: string): string {
  // 1. Use verifier address if available (most reliable).
  if (verifierAddress) {
    const circuit = VERIFIER_CIRCUIT_MAP[verifierAddress.toLowerCase()];
    if (circuit) return circuit;
  }
  // 2. Fallback to public input count.
  const len = publicInputs.length;
  if (len === MDL_KR_LAYOUT.OWNERSHIP_FIELDS) return 'mdl_kr_ownership';
  if (len === MDL_KR_LAYOUT.AGE_FIELDS) return 'mdl_kr_age';
  if (len === MDL_KR_LAYOUT.REGION_FIELDS) return 'mdl_kr_region';
  if (len === 148) return 'oidc_domain_attestation';
  if (len > 128) return 'coinbase_country_attestation';
  return 'coinbase_attestation';
}
