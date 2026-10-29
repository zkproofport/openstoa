import { ethers } from 'ethers';
import { COINBASE_ATTESTATION_PUBLIC_INPUT_COUNT, COINBASE_ATTESTATION_PUBLIC_INPUT_LAYOUT, deriveOidcNonceBinding, OIDC_DOMAIN_ATTESTATION_PUBLIC_INPUT_LAYOUT, OIDC_PUBLIC_INPUT_COUNT } from '@zkproofport-app/core';
export const proofField = (n: number | bigint) => '0x' + n.toString(16).padStart(64, '0');
/**
 * Coinbase issuer inputs carrying the published Coinbase signer root.
 * 193 = Coinbase KYC v2: root at 96-127 and attested_at (192) = the clock,
 * which core holds to a 15-minute window. 150 = Coinbase Country: root at
 * 32-63. Any other length keeps the root at 32 (a shape core refuses).
 */
export function coinbaseIssuerInputs(length = COINBASE_ATTESTATION_PUBLIC_INPUT_COUNT): string[] {
  const inputs = Array(length).fill(proofField(0));
  const rootStart = length === COINBASE_ATTESTATION_PUBLIC_INPUT_COUNT ? COINBASE_ATTESTATION_PUBLIC_INPUT_LAYOUT.MERKLE_ROOT_START : 32;
  Buffer.from('b60da9815c76261b61a1e91f199de5845fc171a6500e57c4240d2ac61d85e2bf', 'hex').forEach((n, i) => inputs[rootStart + i] = proofField(n));
  if (length === COINBASE_ATTESTATION_PUBLIC_INPUT_COUNT) {
    inputs[COINBASE_ATTESTATION_PUBLIC_INPUT_LAYOUT.ATTESTED_AT] = proofField(Math.floor(Date.now() / 1000));
  }
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
