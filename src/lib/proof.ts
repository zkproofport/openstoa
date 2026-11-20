import { ethers } from 'ethers';
import {
  extractScopeFromPublicInputs,
  extractNullifierFromPublicInputs,
  extractDomainFromPublicInputs,
  verifyProofOnChain,
  RPC_ENDPOINTS,
  COINBASE_ATTESTATION_PUBLIC_INPUT_COUNT,
  COINBASE_COUNTRY_PUBLIC_INPUT_COUNT,
  OIDC_DOMAIN_ATTESTATION_PUBLIC_INPUT_LAYOUT,
  OIDC_PUBLIC_INPUT_COUNT,
  readCountryCondition,
  readOprfPublicInputs,
  reduceOprfName,
  type CountryCondition,
  type OidcRequestContext,
  type OprfEnvironment,
  type ProofRequestContext,
} from '@zkproofport-app/core';
import type { RelayProofResult } from '@zkproofport-app/sdk';
import { relayRequestFor } from './oidcRequestContext';
import { isOprfCircuit, scopeFieldFor, scopeFieldMatches } from './proofScopeField';
import { oprfSettingsFor } from './oprfDomain';

export { OPRF_SETTINGS, oprfSettingsFor } from './oprfDomain';

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

export { isOprfCircuit } from './proofScopeField';

// Exact public-input count per circuit, read from core. Anything else is not
// that circuit's proof, and is refused before an RPC call.
export const PUBLIC_INPUT_COUNTS: Record<VerifiableCircuit, number> = {
  // Coinbase KYC v2 with the OPRF nullifier (133). Earlier shapes (68, 128,
  // 193) are refused here and by core.
  coinbase_attestation: COINBASE_ATTESTATION_PUBLIC_INPUT_COUNT,
  // Coinbase Country v2 with the OPRF nullifier (155). Earlier shapes (90,
  // 150, 215) are refused here and by core.
  coinbase_country_attestation: COINBASE_COUNTRY_PUBLIC_INPUT_COUNT,
  // OIDC v2 (214). A v1 proof (148) is refused here and by core.
  oidc_domain_attestation: OIDC_PUBLIC_INPUT_COUNT,
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
 *
 * `signerVariant` is which circuit package made the proof, as its result says
 * (`standard`, `android`, `android_factory`; absent means `standard`). It only
 * selects among the verifiers core pins for the circuit; core refuses a value
 * the circuit has no package for, and a claim the proof's length contradicts.
 *
 * `countryCondition` is the country list and direction a Coinbase Country
 * proof must have been made against (the topic's list, or the list OpenStoa
 * asked the relay for). The list is a public input the prover chooses and the
 * wallet's signature does not cover it, so a Country proof is refused without
 * one; core compares the two as sets of codes.
 *
 * A wallet credential proof (Coinbase KYC / Country) carries an OPRF
 * nullifier. Its key hash is always checked against the key core pins for this
 * environment (OPRF_SETTINGS). `walletRequest` is the relay request it answers
 * (`{ scope, requestId, oprfDomain }`): when given, core also checks the
 * signal_hash, OPRF domain and scope against it. Without it (a proof submitted
 * to a topic gate later, or one from the AI prover) the domain is compared
 * here with OpenStoa's own; the caller compares the scope.
 */
export async function verifyTrustedTopicProof(
  circuit: string,
  proof: string,
  publicInputs: string[],
  claimed?: ClaimedVerifier,
  oidcRequest?: OidcRequestContext,
  signerVariant?: string,
  countryCondition?: CountryCondition,
  walletRequest?: ProofRequestContext,
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
  if (signerVariant !== undefined && typeof signerVariant !== 'string') {
    return { valid: false, error: 'signerVariant must be a string' };
  }
  if (
    known === 'oidc_domain_attestation'
    && oidcRequest === undefined
    && BigInt(publicInputs[OIDC_DOMAIN_ATTESTATION_PUBLIC_INPUT_LAYOUT.NONCE_MODE]) !== 0n
  ) {
    return { valid: false, error: 'A request-bound OIDC proof (nonce_mode 1) needs the request it answers; none is known here' };
  }
  if (known === 'coinbase_country_attestation' && countryCondition === undefined) {
    return { valid: false, error: 'A Coinbase Country proof needs the country list it was asked for; none is known here' };
  }
  let oprf: { domain: string; environment: OprfEnvironment } | undefined;
  if (isOprfCircuit(known)) {
    oprf = oprfSettingsFor(environment);
    if (walletRequest === undefined) {
      const domainError = oprfDomainError(publicInputs, known, oprf.domain);
      if (domainError) return { valid: false, error: domainError };
    } else if (walletRequest.oprfDomain !== oprf.domain) {
      return { valid: false, error: `The request names OPRF domain '${walletRequest.oprfDomain}', not OpenStoa's '${oprf.domain}'` };
    }
  }
  const rpcUrl = RPC_ENDPOINTS[chainId];
  if (!rpcUrl) return { valid: false, error: `No RPC endpoint for chain ${chainId}` };
  try {
    const verdict = await verifyProofOnChain(
      known,
      { proofHex: proof, publicInputsHex: publicInputs, numPublicInputs: publicInputs.length },
      new ethers.JsonRpcProvider(rpcUrl),
      { chainId },
      claimed,
      {
        ...(known === 'oidc_domain_attestation' && oidcRequest !== undefined ? { request: oidcRequest } : {}),
        ...(known === 'coinbase_country_attestation' ? { countryCondition } : {}),
        ...(oprf ? { oprfEnvironment: oprf.environment } : {}),
        ...(oprf && walletRequest !== undefined ? { request: walletRequest } : {}),
        ...(signerVariant !== undefined ? { signerVariant } : {}),
      },
    );
    // Only the verdict: which contract accepted is core's detail, not OpenStoa's answer.
    return verdict.valid ? { valid: true } : { valid: false, error: verdict.error };
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
 *
 * A wallet credential result (Coinbase KYC / Country) is verified against the
 * request recorded the same way: its scope, the polled requestId and the OPRF
 * domain OpenStoa named (signal_hash, domain and scope all checked by core),
 * and for Country the list and direction asked for. Without that record the
 * proof cannot be placed, so it is refused. `request` in the answer is the
 * request a valid proof was verified against.
 */
export async function verifyProofFromRelay(
  result: RelayProofResult,
  requestId: string,
): Promise<{ valid: boolean; error?: string; request?: ProofRequestContext }> {
  if (!result.circuit || !result.proof || !result.publicInputs) {
    return { valid: false, error: 'Incomplete proof result' };
  }
  const inputs = Array.isArray(result.publicInputs)
    ? result.publicInputs
    : normalizePublicInputs(result.publicInputs as unknown as string);
  const claimed = { verifierAddress: result.verifierAddress, chainId: result.chainId };
  // Which package made the proof; passed through unchanged, never guessed.
  const signerVariant = result.signerVariant ?? undefined;
  if (result.circuit !== 'oidc_domain_attestation' && !isOprfCircuit(result.circuit)) {
    return verifyTrustedTopicProof(result.circuit, result.proof, inputs, claimed, undefined, signerVariant);
  }
  const recorded = await relayRequestFor(requestId);
  if (!recorded) {
    return { valid: false, error: `OpenStoa has no record of relay request ${requestId}; a ${result.circuit} proof cannot be bound to it` };
  }
  if (recorded.circuit !== result.circuit) {
    return { valid: false, error: `Relay request ${requestId} was created for ${recorded.circuit}, not ${result.circuit}` };
  }
  if (result.circuit === 'oidc_domain_attestation') {
    const request = { scope: recorded.scope, requestId };
    const verification = await verifyTrustedTopicProof(result.circuit, result.proof, inputs, claimed, request, signerVariant);
    return verification.valid ? { ...verification, request } : verification;
  }
  if (recorded.oprfDomain === undefined) {
    return { valid: false, error: `Relay request ${requestId} has no recorded OPRF domain` };
  }
  if (result.circuit === 'coinbase_country_attestation' && !recorded.countryCondition) {
    return { valid: false, error: `Relay request ${requestId} has no recorded country list` };
  }
  const request: ProofRequestContext = { scope: recorded.scope, requestId, oprfDomain: recorded.oprfDomain };
  const verification = await verifyTrustedTopicProof(
    result.circuit, result.proof, inputs, claimed, undefined, signerVariant, recorded.countryCondition, request,
  );
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

/**
 * The value a `circuit` proof for `scopeString` carries as its scope, in the
 * form extractScope returns: keccak256(utf8(scope)) mod p for a wallet
 * credential (an OPRF name; a raw keccak256 is at or above p for most
 * strings), keccak256(utf8(scope)) for OIDC.
 */
export function expectedScopeField(scopeString: string, circuit: string): string {
  return scopeFieldFor(scopeString, requireSupportedCircuit(circuit, 'scope'));
}

/** Whether a proof's scope (as extractScope returns it) is `scopeString`'s, for `circuit`. */
export function proofScopeMatches(publicInputs: string[], circuit: string, scopeString: string): boolean {
  return scopeFieldMatches(extractScope(publicInputs, circuit), scopeString, requireSupportedCircuit(circuit, 'scope'));
}

/**
 * Why a wallet credential proof's OPRF domain is not keccak256(utf8(domain))
 * mod p, or null when it is. Read by core (strict count, field elements).
 */
export function oprfDomainError(publicInputs: readonly string[], circuit: string, domain: string): string | null {
  let read;
  try { read = readOprfPublicInputs(circuit, publicInputs); }
  catch (error) { return error instanceof Error ? error.message : String(error); }
  return BigInt(read.domain) === BigInt(reduceOprfName(domain))
    ? null
    : `The proof's OPRF domain is not '${domain}'; it was made for another service`;
}

/**
 * The country list and direction a `coinbase_country_attestation` proof was
 * made against (public inputs 128-149), read by core: 1 to 10 upper-case
 * codes, zero past the length, a 0/1 flag. Throws naming what is wrong.
 */
export function extractCountryCondition(publicInputs: string[], circuit: string): CountryCondition {
  if (circuit !== 'coinbase_country_attestation') {
    throw new Error(`Unsupported circuit for country list extraction: ${circuit}`);
  }
  const read = readCountryCondition(publicInputs);
  if (!read.ok) throw new Error(read.error);
  return read.condition;
}

/**
 * Extract domain from OIDC domain attestation public inputs.
 * Delegates to @zkproofport-app/core's extractDomainFromPublicInputs.
 * For AI agent path, use @zkproofport-ai/sdk's version instead.
 */
export function extractDomain(publicInputs: string[], circuit: string): string | null {
  return extractDomainFromPublicInputs(publicInputs, circuit);
}
