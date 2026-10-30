/**
 * OpenStoa on @zkproofport-app/core 0.4.0-beta.1: Coinbase KYC v2 and the
 * Android signer packages.
 *
 * Edge matrix (each row maps to a test below):
 *  - Coinbase KYC count: 193 accepted; v1's 128 refused before any network
 *    call; 192 / 194 refused.
 *  - attested_at (core): now accepted; 16 minutes old and 6 minutes ahead
 *    refused before the contract call.
 *  - signerVariant: absent -> the standard pinned verifier; `android` and
 *    `android_factory` -> that package's pinned verifier, for Coinbase KYC and
 *    OIDC, in staging (Base Sepolia) and production (Base mainnet); unknown
 *    ('ios', '', '__proto__'), non-string and a claim contradicted by the
 *    proof's length refused without a call; an Android-length proof with no
 *    claim refused. (Coinbase Country's variants: coinbase-country-v2.test.ts.)
 *  - relay results: the result's signerVariant reaches core (contract called
 *    is the android one); a response naming the standard contract for an
 *    android proof is refused.
 *  - topic gate (requireTopicProof): body.signerVariant is forwarded; a
 *    non-string or over-long one is a 400 with no contract call.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearOidcKeyCache,
  getPinnedVariantVerifier,
  getPinnedVerifier,
  COINBASE_ATTESTATION_PUBLIC_INPUT_LAYOUT,
} from '@zkproofport-app/core';
import { coinbaseIssuerInputs, oidcIssuerInputs, jwksFetch, encodedBool, proofField } from './fixtures/trusted-proof';

const state = vi.hoisted(() => ({
  calls: [] as Array<{ to: string }>,
  result: vi.fn(),
}));
vi.mock('ethers', async () => {
  const actual = await vi.importActual<typeof import('ethers')>('ethers');
  class FakeProvider {
    constructor(_url: string) {}
    async call(tx: { to: string }) {
      state.calls.push({ to: String(tx.to).toLowerCase() });
      return state.result();
    }
  }
  return { ...actual, ethers: { ...actual.ethers, JsonRpcProvider: FakeProvider } };
});
vi.mock('@/lib/redis', () => ({ redis: { get: async () => null, set: async () => 'OK' } }));
const cache = vi.hoisted(() => ({ saved: [] as unknown[] }));
vi.mock('@/lib/verification-cache', () => ({
  circuitToCacheType: (circuit: string) => circuit,
  getVerificationCache: async () => null,
  saveVerificationCache: async (...args: unknown[]) => { cache.saved.push(args); },
}));

import { verifyTrustedTopicProof, verifyProofFromRelay, computeScopeHash } from '@/lib/proof';
import { requireTopicProof, topicProofScope } from '@/lib/topic-proof';

/** A proof of the length a 2^n EVM UltraHonk proof has: 32 * (82 + 12n) bytes. */
const proofOfLog = (log: number) => '0x' + 'ab'.repeat(32 * (82 + 12 * log));
const STANDARD_KYC = proofOfLog(20);
const ANDROID = proofOfLog(21);

beforeEach(() => {
  state.calls.length = 0;
  cache.saved.length = 0;
  state.result.mockReset().mockResolvedValue(encodedBool(true));
  clearOidcKeyCache();
  vi.unstubAllGlobals();
  vi.stubGlobal('fetch', vi.fn(jwksFetch()));
  vi.stubEnv('APP_ENV', 'staging');
});

describe('Coinbase KYC v2 count and attested_at', () => {
  it('a 193-input proof with a fresh attested_at reaches the v2 verifier', async () => {
    expect(await verifyTrustedTopicProof('coinbase_attestation', STANDARD_KYC, coinbaseIssuerInputs())).toEqual({ valid: true });
    expect(state.calls.map(c => c.to)).toEqual(['0x1885aa2283db21ad0fc63a2df98efe92f31908e6']);
  });

  it.each([128, 192, 194])('%i inputs are refused before any network call', async (n) => {
    const result = await verifyTrustedTopicProof('coinbase_attestation', STANDARD_KYC, Array(n).fill(proofField(0)));
    expect(result).toEqual({ valid: false, error: 'Expected 193 32-byte public inputs for coinbase_attestation' });
    expect(state.calls).toHaveLength(0);
  });

  it.each([
    ['16 minutes old', -16 * 60, /behind this verifier's clock/],
    ['6 minutes ahead', 6 * 60, /ahead of this verifier's clock/],
  ])('attested_at %s is refused before the contract call', async (_label, offset, message) => {
    const inputs = coinbaseIssuerInputs();
    inputs[COINBASE_ATTESTATION_PUBLIC_INPUT_LAYOUT.ATTESTED_AT] = proofField(Math.floor(Date.now() / 1000) + offset);
    const result = await verifyTrustedTopicProof('coinbase_attestation', STANDARD_KYC, inputs);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(message);
    expect(state.calls).toHaveLength(0);
  });
});

describe('signerVariant selects among core\'s pinned verifiers', () => {
  const rows = (['staging', 'production'] as const).flatMap(env =>
    (['coinbase_attestation', 'oidc_domain_attestation'] as const).flatMap(circuit =>
      (['android', 'android_factory'] as const).map(variant => [env, circuit, variant] as const)));

  it.each(rows)('%s / %s / %s verifies on that package\'s pinned contract', async (env, circuit, variant) => {
    vi.stubEnv('APP_ENV', env);
    const chainId = env === 'production' ? 8453 : 84532;
    const inputs = circuit === 'coinbase_attestation' ? coinbaseIssuerInputs() : oidcIssuerInputs();
    const result = await verifyTrustedTopicProof(circuit, ANDROID, inputs, undefined, undefined, variant);
    expect(result).toEqual({ valid: true });
    expect(state.calls.map(c => c.to)).toEqual([getPinnedVariantVerifier(circuit, variant, chainId).address]);
    expect(state.calls[0].to).not.toBe(getPinnedVerifier(circuit, chainId).address);
  });

  it('production Coinbase KYC android verifiers are the Base mainnet deployments', async () => {
    vi.stubEnv('APP_ENV', 'production');
    await verifyTrustedTopicProof('coinbase_attestation', ANDROID, coinbaseIssuerInputs(), undefined, undefined, 'android');
    await verifyTrustedTopicProof('coinbase_attestation', ANDROID, coinbaseIssuerInputs(), undefined, undefined, 'android_factory');
    await verifyTrustedTopicProof('coinbase_attestation', STANDARD_KYC, coinbaseIssuerInputs());
    expect(state.calls.map(c => c.to)).toEqual([
      '0x836d8b0fd01bed4e34220ebcee6d63265951fbf9',
      '0x87d9a66cacac95b2bc43bac8e610c59acb67c5e0',
      '0x6fc22d3576fb70457d1529b3f70f711a3cba7a7f',
    ]);
  });

  it('production OIDC is the new Base mainnet verifier 0xf1aa88ad…7f35', async () => {
    vi.stubEnv('APP_ENV', 'production');
    expect(await verifyTrustedTopicProof('oidc_domain_attestation', proofOfLog(20), oidcIssuerInputs())).toEqual({ valid: true });
    expect(state.calls.map(c => c.to)).toEqual(['0xf1aa88ad844bfd1dc552526a67f5980aad4e7f35']);
  });

  it.each([['ios'], [''], ['__proto__'], ['Android']])('variant %j is refused without a call', async (variant) => {
    const result = await verifyTrustedTopicProof('coinbase_attestation', ANDROID, coinbaseIssuerInputs(), undefined, undefined, variant);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/signer variant/);
    expect(state.calls).toHaveLength(0);
  });

  it('a non-string variant is refused without a call', async () => {
    const result = await verifyTrustedTopicProof('coinbase_attestation', ANDROID, coinbaseIssuerInputs(), undefined, undefined, 7 as unknown as string);
    expect(result).toEqual({ valid: false, error: 'signerVariant must be a string' });
    expect(state.calls).toHaveLength(0);
  });

  it('an android claim on a standard-length proof is refused without a call', async () => {
    const result = await verifyTrustedTopicProof('coinbase_attestation', STANDARD_KYC, coinbaseIssuerInputs(), undefined, undefined, 'android');
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/the length of a 'standard' proof/);
    expect(state.calls).toHaveLength(0);
  });

  it('an Android-length proof with no claim is refused, not sent to the standard verifier', async () => {
    const result = await verifyTrustedTopicProof('coinbase_attestation', ANDROID, coinbaseIssuerInputs());
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/does not say which signer made it/);
    expect(state.calls).toHaveLength(0);
  });
});

describe('relay results carry their signerVariant to core', () => {
  const result = (extra: Record<string, unknown>) => ({
    requestId: 'r', status: 'completed', circuit: 'coinbase_attestation',
    proof: ANDROID, publicInputs: coinbaseIssuerInputs(), ...extra,
  }) as never;

  it('an android result verifies on the android contract', async () => {
    expect(await verifyProofFromRelay(result({ signerVariant: 'android' }), 'r')).toEqual({ valid: true });
    expect(state.calls.map(c => c.to)).toEqual([getPinnedVariantVerifier('coinbase_attestation', 'android', 84532).address]);
  });

  it('an android result whose relay names the standard contract is refused', async () => {
    const verdict = await verifyProofFromRelay(result({
      signerVariant: 'android',
      verifierAddress: getPinnedVerifier('coinbase_attestation', 84532).address,
      chainId: 84532,
    }), 'r');
    expect(verdict.valid).toBe(false);
    expect(verdict.error).toMatch(/Refusing rather than trusting the response/);
    expect(state.calls).toHaveLength(0);
  });

  it('the same result without its signerVariant is refused', async () => {
    const verdict = await verifyProofFromRelay(result({}), 'r');
    expect(verdict.valid).toBe(false);
    expect(state.calls).toHaveLength(0);
  });
});

describe('the topic gate forwards body.signerVariant', () => {
  const userId = 'user-1';
  const kycInputs = () => {
    const inputs = coinbaseIssuerInputs();
    Buffer.from(computeScopeHash(topicProofScope(userId)).slice(2), 'hex')
      .forEach((byte, i) => inputs[COINBASE_ATTESTATION_PUBLIC_INPUT_LAYOUT.SCOPE_START + i] = proofField(byte));
    return inputs;
  };

  it('an android KYC proof joins through the android verifier', async () => {
    const response = await requireTopicProof(userId, { proofType: 'kyc' }, { proof: ANDROID, publicInputs: kycInputs(), signerVariant: 'android' });
    expect(response).toBeNull();
    expect(state.calls.map(c => c.to)).toEqual([getPinnedVariantVerifier('coinbase_attestation', 'android', 84532).address]);
    expect(cache.saved).toHaveLength(1);
  });

  it('a standard KYC proof without the field joins through the standard verifier', async () => {
    expect(await requireTopicProof(userId, { proofType: 'kyc' }, { proof: STANDARD_KYC, publicInputs: kycInputs() })).toBeNull();
    expect(state.calls.map(c => c.to)).toEqual([getPinnedVerifier('coinbase_attestation', 84532).address]);
  });

  it.each([[7], [{}], ['x'.repeat(33)]])('signerVariant %j is a 400 with no contract call', async (signerVariant) => {
    const response = await requireTopicProof(userId, { proofType: 'kyc' }, { proof: ANDROID, publicInputs: kycInputs(), signerVariant });
    expect(response?.status).toBe(400);
    expect(state.calls).toHaveLength(0);
    expect(cache.saved).toHaveLength(0);
  });

  it('a v1 KYC proof (128 inputs) is a 400 with no contract call', async () => {
    const response = await requireTopicProof(userId, { proofType: 'kyc' }, { proof: proofOfLog(19), publicInputs: Array(128).fill(proofField(0)) });
    expect(response?.status).toBe(400);
    expect(state.calls).toHaveLength(0);
  });
});
