import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSDKInstance = vi.hoisted(() => ({
  createRelayRequest: vi.fn().mockResolvedValue({ requestId: 'req-123', deepLink: 'zkproofport://test' }),
  pollResult: vi.fn().mockResolvedValue({ status: 'completed', proof: '0x...' }),
  setSigner: vi.fn(),
}));

vi.mock('@zkproofport-app/sdk', () => {
  const SDK = vi.fn().mockImplementation(() => mockSDKInstance);
  (SDK as any).create = vi.fn().mockImplementation(() => mockSDKInstance);
  return { ProofportSDK: SDK };
});

vi.mock('ethers', () => ({
  ethers: { Wallet: { createRandom: vi.fn().mockReturnValue({}) } },
}));

beforeEach(() => {
  vi.clearAllMocks();
  mockSDKInstance.createRelayRequest.mockResolvedValue({ requestId: 'req-123', deepLink: 'zkproofport://test' });
  mockSDKInstance.pollResult.mockResolvedValue({ status: 'completed', proof: '0x...' });
  delete process.env.RELAY_URL;
  vi.resetModules();
});

describe('createRelayProofRequest', () => {
  it('returns requestId and deepLink', async () => {
    const { createRelayProofRequest } = await import('@/lib/relay');

    const result = await createRelayProofRequest('zkproofport-community');

    expect(result.requestId).toBe('req-123');
    expect(result.deepLink).toBe('zkproofport://test');
  });

  it('uses ProofportSDK constructor with RELAY_URL when set', async () => {
    process.env.RELAY_URL = 'http://relay:4001';
    vi.resetModules();

    const { ProofportSDK } = await import('@zkproofport-app/sdk');
    const { createRelayProofRequest } = await import('@/lib/relay');

    await createRelayProofRequest('zkproofport-community');

    expect(ProofportSDK).toHaveBeenCalledWith({ relayUrl: 'http://relay:4001' });
    expect((ProofportSDK as any).create).not.toHaveBeenCalled();
  });

  it('uses ProofportSDK.create() when RELAY_URL is not set', async () => {
    vi.resetModules();

    const { ProofportSDK } = await import('@zkproofport-app/sdk');
    const { createRelayProofRequest } = await import('@/lib/relay');

    await createRelayProofRequest('zkproofport-community');

    expect((ProofportSDK as any).create).toHaveBeenCalled();
    expect(ProofportSDK).not.toHaveBeenCalledWith(expect.objectContaining({ relayUrl: expect.anything() }));
  });

  it('passes countryList for coinbase_country_attestation circuit', async () => {
    const { createRelayProofRequest } = await import('@/lib/relay');

    await createRelayProofRequest('zkproofport-community', {
      circuitType: 'coinbase_country_attestation',
      countryList: ['US', 'KR'],
      isIncluded: true,
    });

    const [, inputs] = mockSDKInstance.createRelayRequest.mock.calls[0];
    expect(inputs.countryList).toEqual(['US', 'KR']);
    expect(inputs.isIncluded).toBe(true);
  });

  it('passes domain and provider for oidc_domain_attestation circuit', async () => {
    const { createRelayProofRequest } = await import('@/lib/relay');

    await createRelayProofRequest('zkproofport-community', {
      circuitType: 'oidc_domain_attestation',
      domain: 'company.com',
      provider: 'google',
    });

    const [, inputs] = mockSDKInstance.createRelayRequest.mock.calls[0];
    expect(inputs.domain).toBe('company.com');
    expect(inputs.provider).toBe('google');
  });
});

describe('pollProofResult', () => {
  it('returns the result from SDK pollResult', async () => {
    const { pollProofResult } = await import('@/lib/relay');

    const result = await pollProofResult('req-123');

    expect(mockSDKInstance.pollResult).toHaveBeenCalledWith('req-123');
    expect(result).toMatchObject({ status: 'completed', proof: '0x...' });
  });
});
