export const HUMAN_PROOF_CIRCUITS = {
  coinbase_attestation: 'humanProof.kyc',
  coinbase_country_attestation: 'humanProof.country',
  oidc_domain_attestation: 'humanProof.domain',
} as const;

export interface HumanProofRequest {
  requestId: string;
  deepLink: string;
  scope: string;
  circuitType: keyof typeof HUMAN_PROOF_CIRCUITS;
}

function decode(encoded: string): Record<string, unknown> {
  if (!encoded || encoded.length > 20000 || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error('Invalid proof link encoding');
  const binary = atob(encoded.replace(/-/g, '+').replace(/_/g, '/'));
  const value = JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(Uint8Array.from(binary, char=>char.charCodeAt(0))));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid proof link object');
  return value;
}

/** The fragment is a handoff, not authentication. Never accept credentials or arbitrary poll URLs. */
export function parseHumanProofFragment(hash: string, relayOrigin: string): HumanProofRequest | null {
  try {
    if (!hash.startsWith('#')) return null;
    const value = decode(hash.slice(1));
    const fields = ['requestId','deepLink','scope','circuitType'];
    if (Object.keys(value).length !== fields.length || fields.some(key=>typeof value[key] !== 'string')) return null;
    const {requestId, deepLink, scope, circuitType} = value as unknown as HumanProofRequest;
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(requestId) ||
        !/^zkproofport-community:topic:[^\s\u0000-\u001f]{1,256}$/.test(scope) ||
        !Object.hasOwn(HUMAN_PROOF_CIRCUITS, circuitType)) return null;
    const url = new URL(deepLink);
    if (url.protocol !== 'zkproofport:' || url.hostname !== 'proof-request' || url.pathname ||
        url.username || url.password || url.port || url.hash ||
        Array.from(url.searchParams.keys()).join(',') !== 'data') return null;
    const payload = decode(url.searchParams.get('data')!);
    const inputs = payload.inputs as Record<string,unknown> | undefined;
    if (payload.requestId !== requestId || payload.circuitId !== circuitType || inputs?.scope !== scope) return null;
    const callback = new URL(String(payload.callbackUrl));
    if (callback.origin !== new URL(relayOrigin).origin || !['https:','http:'].includes(callback.protocol) || callback.username || callback.password ||
        callback.pathname !== '/api/v1/proof/callback' || callback.search || callback.hash) return null;
    return {requestId,deepLink,scope,circuitType};
  } catch { return null; }
}
