/**
 * The topic proof workflow on the OPRF nullifier (core 0.4.0-beta.9).
 *
 * Edge matrix (each row maps to a test below):
 *  - proofRequirement.oprfDomain for a Coinbase KYC / Country requirement:
 *    missing, empty, non-string, control character, 257 bytes -> refused when
 *    the requirement is read (never filled in); a valid one (ASCII, Korean
 *    IDN label, 256 bytes) is kept. An OIDC requirement needs none.
 *  - AI method: the kept domain reaches the prover adapter unchanged; an OIDC
 *    proof is started without one.
 *  - verified scope from an app poll: compared per circuit -- keccak256(scope)
 *    mod p for coinbase_attestation / coinbase_country_attestation, raw
 *    keccak256 for OIDC -- with scopes whose keccak256 is at or above p (so the
 *    two differ); the raw keccak256 offered for a wallet circuit is refused;
 *    a value for another scope, a non-hex, an over-long value refused; an
 *    unknown circuit throws naming the known ones.
 */
import { describe, expect, it, vi } from 'vitest';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { reduceOprfName } from '@zkproofport-app/core';
import { TopicProofWorkflow, MemoryProofOperationStore, expectedScopeField } from '../topicProofWorkflow';

const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const rawKeccak = (s: string) => '0x' + Buffer.from(keccak_256(new TextEncoder().encode(s))).toString('hex');
const SCOPE = 'zkproofport-community:topic:alice';
const DOMAIN = 'stg-community.zkproofport.app';

/** The first `zkproofport-community:topic:u<n>` whose keccak256 is at or above p. */
function scopeAboveP(): string {
  for (let n = 0; n < 1000; n++) {
    const scope = `zkproofport-community:topic:u${n}`;
    if (BigInt(rawKeccak(scope)) >= P) return scope;
  }
  throw new Error('no scope above p in 1000 tries');
}

function setup(scope: string, requirement: Record<string, unknown>, startAi = vi.fn(() => ({ cancel: vi.fn(), status: () => ({ status: 'proving' as const }), wait: () => new Promise<never>(() => {}) }))) {
  const request = vi.fn(async (url: string) => {
    if (url === '/api/auth/challenge') return { scope };
    if (url === '/api/auth/proof-request') return { requestId: 'relay-1', deepLink: 'zkproofport://proof-request?data=abc', scope, circuitType: requirement.circuit };
    return { status: 'pending' };
  });
  const submit = vi.fn(async () => ({ ok: true }));
  const workflow = new TopicProofWorkflow({ rest: { getToken: () => 'credential', request: request as never }, baseUrl: 'http://localhost:3200', store: new MemoryProofOperationStore(), submit, startAi: startAi as never });
  const error = { status: 402, body: { proofScope: scope, proofRequirement: requirement } };
  return { workflow, request, submit, startAi, error };
}

describe('proofRequirement.oprfDomain is required for a wallet proof, never filled in', () => {
  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['a number', 7],
    ['a control character', 'a\u0000b'],
    ['257 bytes', 'x'.repeat(257)],
  ])('kyc with %s is refused', async (_label, oprfDomain) => {
    const x = setup(SCOPE, { type: 'kyc', circuit: 'coinbase_attestation', ...(oprfDomain === undefined ? {} : { oprfDomain }) });
    await expect(x.workflow.required({ kind: 'join', topicId: 't' }, x.error)).rejects.toThrow(/OPRF domain/);
  });

  it('country without one is refused', async () => {
    const x = setup(SCOPE, { type: 'country', circuit: 'coinbase_country_attestation', allowedCountries: ['KR'] });
    await expect(x.workflow.required({ kind: 'join', topicId: 't' }, x.error)).rejects.toThrow(/OPRF domain/);
  });

  it.each([DOMAIN, '커뮤니티.example', 'x'.repeat(256)])('kyc keeps %j', async (oprfDomain) => {
    const x = setup(SCOPE, { type: 'kyc', circuit: 'coinbase_attestation', oprfDomain });
    const r = await x.workflow.required({ kind: 'join', topicId: 't' }, x.error);
    expect(r.requirement.oprfDomain).toBe(oprfDomain);
  });

  it('an OIDC requirement needs none', async () => {
    const x = setup(SCOPE, { type: 'google_workspace', circuit: 'oidc_domain_attestation' });
    const r = await x.workflow.required({ kind: 'join', topicId: 't' }, x.error);
    expect(r.requirement.oprfDomain).toBeUndefined();
  });
});

describe('the AI method passes the kept domain to the prover', () => {
  it('kyc: the domain reaches startAi unchanged', async () => {
    const x = setup(SCOPE, { type: 'kyc', circuit: 'coinbase_attestation', oprfDomain: DOMAIN });
    const r = await x.workflow.required({ kind: 'join', topicId: 't' }, x.error);
    await x.workflow.continue({ operationId: r.operationId, method: 'ai', approved: true });
    expect(x.startAi).toHaveBeenCalledWith(expect.objectContaining({ proofType: 'kyc', scope: SCOPE, oprfDomain: DOMAIN }));
  });

  it('OIDC: started without a domain', async () => {
    const x = setup(SCOPE, { type: 'google_workspace', circuit: 'oidc_domain_attestation' });
    const r = await x.workflow.required({ kind: 'join', topicId: 't' }, x.error);
    await x.workflow.continue({ operationId: r.operationId, method: 'ai', approved: true });
    expect((x.startAi.mock.calls[0] as unknown[])[0]).not.toHaveProperty('oprfDomain');
  });
});

describe('the verified scope of an app result is compared per circuit', () => {
  const high = scopeAboveP();
  const reduced = reduceOprfName(high);

  it('the chosen scope really has keccak256 >= p, so the two encodings differ', () => {
    expect(BigInt(rawKeccak(high))).toBeGreaterThanOrEqual(P);
    expect(BigInt(reduced)).toBe(BigInt(rawKeccak(high)) % P);
  });

  it.each(['coinbase_attestation', 'coinbase_country_attestation'])('%s expects keccak256(scope) mod p', (circuit) => {
    expect(expectedScopeField(high, circuit)).toBe(reduced);
  });

  it('oidc_domain_attestation expects the raw keccak256', () => {
    expect(expectedScopeField(high, 'oidc_domain_attestation')).toBe(rawKeccak(high));
  });

  it.each(['giwa_attestation', '', '__proto__', 'COINBASE_ATTESTATION'])('circuit %j throws naming the known ones', (circuit) => {
    expect(() => expectedScopeField(high, circuit)).toThrow(/Known: coinbase_attestation, coinbase_country_attestation, oidc_domain_attestation/);
  });

  const kyc = { type: 'kyc', circuit: 'coinbase_attestation', oprfDomain: DOMAIN };
  const completed = (scopeHash: unknown) => ({ status: 'completed', circuit: 'coinbase_attestation', scopeHash, proof: '0xaabb', publicInputs: Array(133).fill('0x' + '01'.padStart(64, '0')) });

  async function resumeWith(scopeHash: unknown) {
    const x = setup(high, kyc);
    const r = await x.workflow.required({ kind: 'join', topicId: 't' }, x.error);
    await x.workflow.continue({ operationId: r.operationId, method: 'app', approved: true });
    x.request.mockResolvedValue(completed(scopeHash) as never);
    return { x, result: x.workflow.resume(r.operationId) };
  }

  it('a KYC result carrying keccak256(scope) mod p is submitted', async () => {
    const { x, result } = await resumeWith(reduced);
    expect((await result).status).toBe('completed');
    expect(x.submit).toHaveBeenCalledOnce();
  });

  it('the same value in upper-case hex is the same field', async () => {
    const { x, result } = await resumeWith('0x' + reduced.slice(2).toUpperCase());
    expect((await result).status).toBe('completed');
    expect(x.submit).toHaveBeenCalledOnce();
  });

  it.each([
    ['the raw keccak256', () => rawKeccak(high)],
    ['another account\'s scope', () => reduceOprfName('zkproofport-community:topic:bob')],
    ['non-hex', () => '0xzz'],
    ['an over-long value', () => '0x' + '1'.repeat(65)],
    ['a number', () => 5],
  ])('a KYC result carrying %s is refused before submission', async (_label, value) => {
    const { x, result } = await resumeWith(value());
    await expect(result).rejects.toThrow(/scope/);
    expect(x.submit).not.toHaveBeenCalled();
  });
});
