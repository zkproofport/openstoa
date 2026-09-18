import { ethers } from 'ethers';

// Same ordered Coinbase signer set and keccak(left || right) tree as the
// prover's config/contracts.ts and input/merkleTree.ts. A circuit's public root
// is a claim; verifying the circuit alone does not authenticate its issuer.
const COINBASE_SIGNERS = [
  '0x952f32128AF084422539C4Ff96df5C525322E564',
  '0x8844591D47F17bcA6F5dF8f6B64F4a739F1C0080',
  '0x88fe64ea2e121f49bb77abea6c0a45e93638c3c5',
  '0x44ace9abb148e8412ac4492e9a1ae6bd88226803',
];
function signerRoot(): string {
  let layer = COINBASE_SIGNERS.map(address => ethers.keccak256(address));
  while (layer.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < layer.length; i += 2) next.push(ethers.keccak256(ethers.concat([layer[i], layer[i + 1] ?? layer[i]])));
    layer = next;
  }
  return layer[0];
}
const COINBASE_SIGNER_ROOT = signerRoot();
// Fixed provider discovery documents advertise these URLs. Neither a request
// nor proof metadata can select an issuer URL or a network destination.
const JWKS_URLS: Record<string, string> = {
  '0': 'https://www.googleapis.com/oauth2/v3/certs',
  '1': 'https://login.microsoftonline.com/common/discovery/v2.0/keys',
};
export async function hasTrustedProofIssuer(circuit: string, inputs: string[]): Promise<boolean> {
  if (circuit === 'coinbase_attestation' || circuit === 'coinbase_country_attestation') {
    const bytes = inputs.slice(32, 64).map(value => BigInt(value));
    if (bytes.length !== 32 || bytes.some(value => value > 255n || value < 0n)) return false;
    return '0x' + bytes.map(value => value.toString(16).padStart(2, '0')).join('') === COINBASE_SIGNER_ROOT;
  }
  if (circuit !== 'oidc_domain_attestation' || inputs.length !== 148) return false;
  const provider = BigInt(inputs[147]).toString();
  if (!Object.hasOwn(JWKS_URLS, provider)) return false;
  const response = await fetch(JWKS_URLS[provider], {signal: AbortSignal.timeout(5000), redirect:'error'});
  if (!response.ok) return false;
  const data: unknown = await response.json();
  const keys = (data as {keys?: unknown[]})?.keys;
  if (!Array.isArray(keys)) return false;
  const limbs = inputs.slice(0,18).map(value=>BigInt(value));
  if (limbs.some(value=>value < 0n || value >= (1n<<120n))) return false;
  return keys.some(raw => {
    const key = raw as {kty?: string; alg?: string; use?: string; n?: string; e?: string};
    if (!key || key.kty !== 'RSA' || key.e !== 'AQAB' || (key.alg && key.alg !== 'RS256') || (key.use && key.use !== 'sig') || typeof key.n !== 'string' || !/^[A-Za-z0-9_-]+$/.test(key.n)) return false;
    const bytes = Buffer.from(key.n, 'base64url');
    if (bytes.length !== 256) return false;
    let modulus = BigInt('0x'+bytes.toString('hex'));
    for (const limb of limbs) {
      if ((modulus & ((1n<<120n)-1n)) !== limb) return false;
      modulus >>= 120n;
    }
    return modulus === 0n;
  });
}
