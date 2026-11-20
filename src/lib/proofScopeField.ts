import { keccak256, toUtf8Bytes } from 'ethers';
import { reduceOprfName } from '@zkproofport-app/core/oprf';

/**
 * How each circuit OpenStoa accepts publishes its scope, so every client that
 * compares a verified proof's `scopeHash` computes the same value:
 *
 * - `oprf`: a wallet credential (Coinbase KYC / Country) publishes ONE field,
 *   keccak256(utf8(scope)) mod p (core's reduceOprfName). A raw keccak256 is at
 *   or above p for most strings, so it is never compared directly.
 * - `keccak`: OIDC publishes keccak256(utf8(scope)), 32 bytes.
 *
 * Pure (no server imports): the browser's proof page uses it too.
 */
const SCOPE_ENCODINGS: Record<string, 'oprf' | 'keccak'> = {
  coinbase_attestation: 'oprf',
  coinbase_country_attestation: 'oprf',
  oidc_domain_attestation: 'keccak',
};

export const SCOPE_FIELD_CIRCUITS = Object.keys(SCOPE_ENCODINGS);

/** The scope value a `circuit` proof for `scope` carries, as 0x + 64 hex. Throws for an unknown circuit. */
export function scopeFieldFor(scope: string, circuit: string): string {
  if (!Object.hasOwn(SCOPE_ENCODINGS, circuit)) {
    throw new Error(`Unknown circuit '${circuit}' for a scope value. Known: ${SCOPE_FIELD_CIRCUITS.join(', ')}.`);
  }
  return SCOPE_ENCODINGS[circuit] === 'oprf' ? reduceOprfName(scope) : keccak256(toUtf8Bytes(scope));
}

/** Whether `value` (a proof's scope, 0x + hex) is `scope`'s value for `circuit`. False for anything unreadable. */
export function scopeFieldMatches(value: unknown, scope: string, circuit: string): boolean {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{1,64}$/.test(value)) return false;
  let expected: string;
  try { expected = scopeFieldFor(scope, circuit); } catch { return false; }
  return BigInt(value) === BigInt(expected);
}

/** Whether `circuit` is a wallet credential whose nullifier is keyed by an OPRF domain. */
export function isOprfCircuit(circuit: string): boolean {
  return Object.hasOwn(SCOPE_ENCODINGS, circuit) && SCOPE_ENCODINGS[circuit] === 'oprf';
}
