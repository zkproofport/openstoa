export const proofField = (n: number | bigint) => '0x' + n.toString(16).padStart(64, '0');
export function coinbaseIssuerInputs(length = 128): string[] {
  const inputs = Array(length).fill(proofField(0));
  Buffer.from('b60da9815c76261b61a1e91f199de5845fc171a6500e57c4240d2ac61d85e2bf', 'hex').forEach((n, i) => inputs[32 + i] = proofField(n));
  return inputs;
}
// `issuer` is the template Microsoft attaches to multi-tenant keys; core
// requires it on Microsoft keys and ignores it on Google's.
export const testJwk = {kty:'RSA',e:'AQAB',alg:'RS256',use:'sig',issuer:'https://login.microsoftonline.com/{tenantid}/v2.0',n:Buffer.alloc(256, 0xab).toString('base64url')}; // top bit set: a real 2048-bit modulus
/** A fetch stand-in serving a JWKS. A new Response per call: a body reads once. */
export const jwksFetch = (keys: unknown[] = [testJwk]) => async () => new Response(JSON.stringify({keys}), {status: 200});
/** ABI-encoded bool, what an eth_call to verify() returns. */
export const encodedBool = (value: boolean) => '0x' + (value ? '1' : '0').padStart(64, '0');
export function oidcIssuerInputs(): string[] {
  const inputs = Array(148).fill(proofField(0));
  let n = BigInt('0x'+Buffer.from(testJwk.n,'base64url').toString('hex'));
  for (let i=0; i<18; i++) {inputs[i]=proofField(n&((1n<<120n)-1n));n>>=120n;}
  return inputs;
}
