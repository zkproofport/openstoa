import { ethers } from 'ethers';
import { COINBASE_ATTESTATION_PUBLIC_INPUT_COUNT, COINBASE_ATTESTATION_PUBLIC_INPUT_LAYOUT, COINBASE_COUNTRY_PUBLIC_INPUT_COUNT, COINBASE_COUNTRY_PUBLIC_INPUT_LAYOUT, computeSignalHash, deriveOidcNonceBinding, OIDC_DOMAIN_ATTESTATION_PUBLIC_INPUT_LAYOUT, OIDC_PUBLIC_INPUT_COUNT, reduceOprfName, TACEO_TESTNET_OPRF_KEY_HASH } from '@zkproofport-app/core';
export const proofField = (n: number | bigint) => '0x' + n.toString(16).padStart(64, '0');
interface CoinbaseLayout {
  circuit: 'coinbase_attestation' | 'coinbase_country_attestation';
  MERKLE_ROOT_START: number; OPRF_KEY_HASH: number; OPRF_DOMAIN: number; SCOPE: number; NULLIFIER: number; ATTESTED_AT: number;
}
const COINBASE_LAYOUTS_BY_COUNT: Record<number, CoinbaseLayout> = {
  [COINBASE_ATTESTATION_PUBLIC_INPUT_COUNT]: { circuit: 'coinbase_attestation', ...COINBASE_ATTESTATION_PUBLIC_INPUT_LAYOUT },
  [COINBASE_COUNTRY_PUBLIC_INPUT_COUNT]: { circuit: 'coinbase_country_attestation', ...COINBASE_COUNTRY_PUBLIC_INPUT_LAYOUT },
};
const COINBASE_SIGNER_ROOT = 'b60da9815c76261b61a1e91f199de5845fc171a6500e57c4240d2ac61d85e2bf';
/** The OPRF domain OpenStoa names on staging (OPRF_SETTINGS); the fixtures' default. */
export const STAGING_OPRF_DOMAIN = 'stg-community.zkproofport.app';
/** A field-sized nullifier, standing in for an OPRF output. */
export const TEST_OPRF_NULLIFIER = proofField(0x2a2a2an);
export interface CoinbaseInputOptions {
  /** The scope string; written as keccak256(utf8) mod p. Default 'zkproofport-community'. */
  scope?: string;
  /** The OPRF domain string; written as keccak256(utf8) mod p. Default STAGING_OPRF_DOMAIN. */
  oprfDomain?: string;
  /** The OPRF key hash. Default: the testnet key core pins for staging / local. */
  oprfKeyHash?: string;
  nullifier?: string;
  /** When given, signal_hash (0-31) = computeSignalHash of this request; zero otherwise. */
  requestId?: string;
}
function writeBytes(inputs: string[], start: number, hex: string): void {
  Buffer.from(hex.replace(/^0x/, ''), 'hex').forEach((byte, i) => inputs[start + i] = proofField(byte));
}
/**
 * Coinbase issuer inputs at each v2 circuit's offsets (core's layouts):
 * the published Coinbase signer root, the OPRF key hash / domain / scope /
 * nullifier fields, and attested_at = the clock (core holds it to a 15-minute
 * window). 133 = Coinbase KYC v2, 155 = Coinbase Country v2 (see
 * countryIssuerInputs for its list). Any other length keeps the root at 32,
 * a shape core refuses.
 */
export function coinbaseIssuerInputs(length = COINBASE_ATTESTATION_PUBLIC_INPUT_COUNT, options: CoinbaseInputOptions = {}): string[] {
  const inputs = Array(length).fill(proofField(0));
  const layout = Object.hasOwn(COINBASE_LAYOUTS_BY_COUNT, length) ? COINBASE_LAYOUTS_BY_COUNT[length] : undefined;
  const rootStart = layout ? layout.MERKLE_ROOT_START : 32;
  writeBytes(inputs, rootStart, COINBASE_SIGNER_ROOT);
  if (layout) {
    const scope = options.scope ?? 'zkproofport-community';
    inputs[layout.OPRF_KEY_HASH] = options.oprfKeyHash ?? TACEO_TESTNET_OPRF_KEY_HASH;
    inputs[layout.OPRF_DOMAIN] = reduceOprfName(options.oprfDomain ?? STAGING_OPRF_DOMAIN);
    inputs[layout.SCOPE] = reduceOprfName(scope);
    inputs[layout.NULLIFIER] = options.nullifier ?? TEST_OPRF_NULLIFIER;
    inputs[layout.ATTESTED_AT] = proofField(Math.floor(Date.now() / 1000));
    if (options.requestId !== undefined) {
      writeBytes(inputs, 0, computeSignalHash({ scope, circuitId: layout.circuit, requestId: options.requestId }));
    }
  }
  return inputs;
}
export interface CountryInputOptions {
  /** The list written into country_list, in this order. Codes are written byte for byte, so lower case stays lower case. */
  countries?: readonly string[];
  /** country_list_length; defaults to countries.length. */
  length?: number;
  /** is_included; defaults to 1. */
  isIncluded?: number;
}
/**
 * A Coinbase Country v2 public-input vector (155 fields) that passes core's
 * issuer check: the Coinbase signer root, the OPRF fields, a fresh
 * attested_at, and the list, length and inclusion flag at
 * COINBASE_COUNTRY_PUBLIC_INPUT_LAYOUT.
 */
export function countryIssuerInputs(options: CountryInputOptions & CoinbaseInputOptions = {}): string[] {
  const L = COINBASE_COUNTRY_PUBLIC_INPUT_LAYOUT;
  const inputs = coinbaseIssuerInputs(COINBASE_COUNTRY_PUBLIC_INPUT_COUNT, options);
  const countries = options.countries ?? ['KR'];
  countries.forEach((code, slot) => {
    inputs[L.COUNTRY_LIST_START + 2 * slot] = proofField(code.charCodeAt(0));
    inputs[L.COUNTRY_LIST_START + 2 * slot + 1] = proofField(code.charCodeAt(1));
  });
  inputs[L.COUNTRY_LIST_LENGTH] = proofField(options.length ?? countries.length);
  inputs[L.IS_INCLUDED] = proofField(options.isIncluded ?? 1);
  return inputs;
}
// `issuer` is the template Microsoft attaches to multi-tenant keys; core
// requires it on Microsoft keys and ignores it on Google's.
export const testJwk = {kty:'RSA',e:'AQAB',alg:'RS256',use:'sig',issuer:'https://login.microsoftonline.com/{tenantid}/v2.0',n:Buffer.alloc(256, 0xab).toString('base64url')}; // top bit set: a real 2048-bit modulus
/** A fetch stand-in serving a JWKS. A new Response per call: a body reads once. */
export const jwksFetch = (keys: unknown[] = [testJwk]) => async () => new Response(JSON.stringify({keys}), {status: 200});
/** ABI-encoded bool, what an eth_call to verify() returns. */
export const encodedBool = (value: boolean) => '0x' + (value ? '1' : '0').padStart(64, '0');
/** The client ids core accepts (OIDC_ALLOWED_AUDIENCES), by sign-in path. */
export const OIDC_AUDIENCES = {
  googleWeb: '491923400813-5bb3up7dhejns2unvbrt6mku520hrr5g.apps.googleusercontent.com',
  googleDevice: '491923400813-pr17m6kpin2rsbbes18jpb60j1s3qmv4.apps.googleusercontent.com',
  microsoft: '8b09c842-d7a8-4d9c-a6ea-46c797412bac',
} as const;
const keccakBytes = (value: string) => Buffer.from(ethers.keccak256(ethers.toUtf8Bytes(value)).slice(2), 'hex');
export interface OidcInputOptions {
  provider?: number;
  aud?: string;
  /** Mode 1 (app, nonce bound) needs the request it answers; mode 0 (device flow) has none. */
  nonceMode?: number;
  request?: { scope: string; requestId: string };
  scope?: string;
  now?: number;
}
/**
 * A v2 oidc_domain_attestation public-input vector (214 fields) that passes
 * core's policy and key check: the test JWK's modulus, a known audience, the
 * nonce binding for `request` in mode 1 (zero in mode 0), and `now` = the
 * clock. Default: a device-flow (mode 0) Google proof over `scope`.
 */
export function oidcIssuerInputs(options: OidcInputOptions = {}): string[] {
  const nonceMode = options.nonceMode ?? 0;
  const aud = options.aud ?? (nonceMode === 1 ? OIDC_AUDIENCES.googleWeb : OIDC_AUDIENCES.googleDevice);
  const scope = options.request?.scope ?? options.scope ?? 'zkproofport-community';
  const L = OIDC_DOMAIN_ATTESTATION_PUBLIC_INPUT_LAYOUT;
  const inputs = Array(OIDC_PUBLIC_INPUT_COUNT).fill(proofField(0));
  let n = BigInt('0x'+Buffer.from(testJwk.n,'base64url').toString('hex'));
  for (let i=0; i<18; i++) {inputs[i]=proofField(n&((1n<<120n)-1n));n>>=120n;}
  keccakBytes(scope).forEach((byte, i) => inputs[L.SCOPE_START + i] = proofField(byte));
  inputs[L.PROVIDER] = proofField(options.provider ?? 0);
  keccakBytes(aud).forEach((byte, i) => inputs[L.AUD_HASH_START + i] = proofField(byte));
  inputs[L.NONCE_MODE] = proofField(nonceMode);
  if (options.request) {
    Buffer.from(deriveOidcNonceBinding(options.request.scope, options.request.requestId), 'hex')
      .forEach((byte, i) => inputs[L.NONCE_BINDING_START + i] = proofField(byte));
  }
  inputs[L.NOW] = proofField(options.now ?? Math.floor(Date.now() / 1000));
  return inputs;
}
