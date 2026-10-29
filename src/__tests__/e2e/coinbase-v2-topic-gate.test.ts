/**
 * The KYC topic gate on core 0.4.0-beta.1, over HTTP against a real
 * deployment. No prover needed: every case is a refusal that must happen
 * before any contract call, or the 402 that names what to prove.
 *
 * Matrix:
 *  - no proof -> 402 naming coinbase_attestation
 *  - Coinbase KYC v1 shape (128 inputs) -> 400
 *  - v2 shape (193 inputs) over a signer root of the prover's choosing -> 400
 *  - signerVariant that is not a string / over-long / unknown -> 400
 *  - a removed Korea Mobile ID circuit asked of the relay -> 400 naming the known ids
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { authPost, publicGet } from './helpers';

const field = (n: number) => '0x' + n.toString(16).padStart(64, '0');
const proofOfLog = (log: number) => '0x' + 'ab'.repeat(32 * (82 + 12 * log));
let categoryId: string;

beforeAll(async () => {
  const res = await publicGet('/api/categories');
  expect(res.status).toBe(200);
  categoryId = (await res.json()).categories[0].id;
});

const createKyc = (extra: Record<string, unknown>) => authPost('/api/topics', {
  title: `E2E KYC v2 gate ${Date.now()}`,
  description: 'refusal cases',
  categoryId,
  proofType: 'kyc',
  ...extra,
});

describe.sequential('KYC topic gate (Coinbase KYC v2)', () => {
  it('without a proof answers 402 naming coinbase_attestation', async () => {
    const res = await createKyc({});
    expect(res.status).toBe(402);
    const json = await res.json();
    expect(json.proofRequirement.circuit).toBe('coinbase_attestation');
  });

  it('a v1-shaped proof (128 public inputs) is refused', async () => {
    const res = await createKyc({ proof: proofOfLog(19), publicInputs: Array(128).fill(field(0)) });
    expect(res.status).toBe(400);
  });

  it('a v2-shaped proof over another signer root is refused', async () => {
    const res = await createKyc({ proof: proofOfLog(20), publicInputs: Array(193).fill(field(0)) });
    expect(res.status).toBe(400);
  });

  it.each([[7], ['x'.repeat(33)], ['ios']])('signerVariant %j is refused', async (signerVariant) => {
    const res = await createKyc({ proof: proofOfLog(21), publicInputs: Array(193).fill(field(0)), signerVariant });
    expect(res.status).toBe(400);
  });
});

describe('relay proof requests', () => {
  it.each(['mdl_kr_ownership', 'mdl_kr_age', 'mdl_kr_region'])('%s is refused naming the known circuits', async (circuitType) => {
    const res = await authPost('/api/auth/proof-request', { circuitType });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('circuitType is required and must be one of: coinbase_attestation, coinbase_country_attestation, oidc_domain_attestation.');
  });
});
