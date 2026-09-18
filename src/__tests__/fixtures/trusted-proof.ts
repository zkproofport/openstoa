export const proofField = (n: number | bigint) => '0x' + n.toString(16).padStart(64, '0');
export function coinbaseIssuerInputs(length = 128): string[] {
  const inputs = Array(length).fill(proofField(0));
  Buffer.from('b60da9815c76261b61a1e91f199de5845fc171a6500e57c4240d2ac61d85e2bf', 'hex').forEach((n, i) => inputs[32 + i] = proofField(n));
  return inputs;
}
export const testJwk = {kty:'RSA',e:'AQAB',alg:'RS256',use:'sig',n:Buffer.alloc(256, 1).toString('base64url')};
export function oidcIssuerInputs(): string[] {
  const inputs = Array(148).fill(proofField(0));
  let n = BigInt('0x'+Buffer.from(testJwk.n,'base64url').toString('hex'));
  for (let i=0; i<18; i++) {inputs[i]=proofField(n&((1n<<120n)-1n));n>>=120n;}
  return inputs;
}
