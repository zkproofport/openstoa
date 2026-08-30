/**
 * Browser WebAuthn PRF (hmac-secret) for Phase 4 key recovery (design §6.2).
 * Web-only (uses navigator.credentials) — the mobile mini-app gets PRF from the
 * host via HostApi.passkeyPrf instead. A synced passkey (iCloud Keychain / Google
 * Password Manager) evaluated with a fixed salt yields the SAME deterministic
 * 32-byte output on any of the user's devices, so it derives a stable master_key
 * wrapping key with no escrow (Phase 0 verified determinism + cross-device match).
 */

// Fixed domain-separation salt for the master_key wrapping PRF. Constant so every
// device/eval reproduces the same PRF output for a given credential.
const PRF_SALT = new TextEncoder().encode('openstoa-master-key-prf/v1');

function rpId(): string {
  return window.location.hostname; // 'localhost' locally, the domain in prod
}

function b64url(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function randomChallenge(): Uint8Array {
  const c = new Uint8Array(32);
  crypto.getRandomValues(c);
  return c;
}

/**
 * Passkey recovery is OFF everywhere until it has been verified end to end.
 *
 * Nothing about it had ever been run to completion — registering a passkey,
 * wiping the device, and getting the chat keys back. The domain a passkey binds
 * to was also wrong on mobile, and Android has no implementation at all, so the
 * feature could only ever have worked for some people on one platform.
 *
 * Offering half a recovery route is worse than offering none: somebody registers
 * a passkey, believes their keys are safe, and finds out otherwise on the day
 * they need them. The recovery code path is verified and stays.
 *
 * Nobody has registered one — OpenStoa has not launched. Turning this back on
 * needs no migration, just this constant and a run through the real flow.
 */
const PASSKEY_RECOVERY_ENABLED = false;

/** True if passkey recovery is offered AND the browser exposes WebAuthn. */
export function isPasskeySupported(): boolean {
  if (!PASSKEY_RECOVERY_ENABLED) return false;
  return typeof window !== 'undefined' && typeof window.PublicKeyCredential !== 'undefined';
}

function readPrf(cred: PublicKeyCredential): Uint8Array | null {
  // getClientExtensionResults() is loosely typed; prf.results.first is an
  // ArrayBuffer when the authenticator supports hmac-secret.
  const ext = cred.getClientExtensionResults() as { prf?: { results?: { first?: ArrayBuffer } } };
  const first = ext.prf?.results?.first;
  return first ? new Uint8Array(first) : null;
}

export interface PasskeyPrfResult {
  credentialId: string; // base64url rawId — stored with the wrapped master_key
  prfOutput: Uint8Array; // 32 bytes
}

/**
 * Register a new passkey and obtain its PRF output (first-time backup). Some
 * browsers do not return PRF results on create, so if absent we immediately do a
 * get() with the fresh credential to obtain it.
 */
export async function registerPasskeyPrf(userId: string, displayName: string): Promise<PasskeyPrfResult> {
  if (!isPasskeySupported()) throw new Error('WebAuthn not supported in this browser');
  const userHandle = new TextEncoder().encode(userId).slice(0, 64);
  const cred = (await navigator.credentials.create({
    publicKey: {
      rp: { name: 'OpenStoa', id: rpId() },
      user: { id: userHandle as BufferSource, name: displayName, displayName },
      challenge: randomChallenge() as BufferSource,
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 }, // ES256
        { type: 'public-key', alg: -257 }, // RS256
      ],
      authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
      extensions: { prf: { eval: { first: PRF_SALT as BufferSource } } } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error('Passkey registration cancelled');

  const credentialId = b64url(cred.rawId);
  const onCreate = readPrf(cred);
  if (onCreate) return { credentialId, prfOutput: onCreate };
  // Fallback: evaluate PRF via an assertion on the just-created credential.
  return getPasskeyPrf(credentialId);
}

/** Assert an existing passkey and evaluate its PRF (recovery / repeat backup). */
export async function getPasskeyPrf(credentialId?: string): Promise<PasskeyPrfResult> {
  if (!isPasskeySupported()) throw new Error('WebAuthn not supported in this browser');
  const assertion = (await navigator.credentials.get({
    publicKey: {
      rpId: rpId(),
      challenge: randomChallenge() as BufferSource,
      allowCredentials: credentialId
        ? [{ type: 'public-key', id: fromB64url(credentialId) as BufferSource }]
        : [],
      userVerification: 'preferred',
      extensions: { prf: { eval: { first: PRF_SALT as BufferSource } } } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  if (!assertion) throw new Error('Passkey assertion cancelled');
  const prfOutput = readPrf(assertion);
  if (!prfOutput) throw new Error('This passkey/browser did not return a PRF result (hmac-secret unsupported)');
  return { credentialId: b64url(assertion.rawId), prfOutput };
}
