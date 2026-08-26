/**
 * The keypair that proves this install is the same one as last time.
 *
 * WHY IT EXISTS. Until now "which device is this?" was answered by a random
 * string the phone made up and put in a header. The server stored it and
 * believed it, because it had nothing else to go on. Two consequences, both seen
 * on staging:
 *
 *   - Lose the string and the phone becomes a stranger to itself. One account,
 *     one phone, 48 distinct device ids across epochs 1→58 in one room — every
 *     one a leaf that joined, pushed the epoch forward, and left the messages
 *     before it unreadable to its successor. The reader is told to ask another
 *     member for keys that their own phone wrote yesterday.
 *   - Learn the string and anyone can claim to be that device, from anywhere.
 *
 * A name can be lost and a name can be copied. Holding a private key is neither:
 * the server sends a nonce, the device signs it, and the signature either checks
 * against the registered public key or it does not.
 *
 * WHAT THIS DOES NOT DO, stated plainly because the boundary matters. The key
 * lives in `expo-secure-store` — the same place as the MLS private keys and the
 * master_key — so anyone who can dump that store can copy it. That is a
 * deliberate choice, not an oversight: a Secure Enclave key would be
 * unextractable, but MLS uses X25519/Ed25519 and the Enclave holds only P-256,
 * so the chat keys would stay in the same store either way. Moving only this key
 * would harden the one thing an attacker with that access has no reason to
 * steal — they would take the chat keys directly.
 *
 * So the guarantee is precise: this closes REMOTE forgery, where someone knows
 * the device id and nothing else. It does not close a dumped device.
 *
 * Ed25519 rather than P-256 for the same reason the Enclave is out — the MLS
 * suite here is already `MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519`, and
 * `react-native-quick-crypto` (already a dependency) provides it. No new
 * primitive, no new native module.
 */
import { Ed } from 'react-native-quick-crypto';

/** Where the private key lives. Namespaced — the store is shared with the host. */
export const DEVICE_KEY_STORE_KEY = 'openstoa.device.key.v1';

/** Host secure-store shape, same slice `installDeviceId` uses. */
export interface SecureStoreLike {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

export interface DeviceKeyPair {
  /** Base64. Sent to the server once, at registration. */
  publicKey: string;
  /** Base64. Never leaves the device. */
  privateKey: string;
}

function b64(bytes: ArrayBuffer): string {
  return Buffer.from(new Uint8Array(bytes)).toString('base64');
}

function unb64(s: string): Buffer {
  return Buffer.from(s, 'base64');
}

/*
 * One resolution per process, shared by every caller.
 *
 * A promise rather than a value, for the reason `installDeviceId` gives about
 * its own id: two callers racing at startup must not both generate and both
 * write, because the loser's public key would be the one already registered —
 * and the account would hold a key it can never sign with.
 */
let pending: Promise<DeviceKeyPair> | null = null;

/**
 * Read the device keypair, or make it on first run.
 *
 * A read that THROWS is re-raised rather than treated as "no key yet". The
 * difference is not academic: the same swallow-and-continue in `mlsSession`
 * minted a new MLS leaf on every transient store failure, which is how one phone
 * became 48. A store that cannot answer is a reason to stop, not a reason to
 * become a new device.
 */
export function deviceKeyPair(store: SecureStoreLike): Promise<DeviceKeyPair> {
  if (!pending) pending = resolve(store);
  return pending;
}

async function resolve(store: SecureStoreLike): Promise<DeviceKeyPair> {
  let saved: string | null;
  try {
    saved = await store.getItem(DEVICE_KEY_STORE_KEY);
  } catch (err) {
    throw new Error(
      'Device key store unreadable — refusing to generate a new identity, which ' +
        'would make this phone a stranger to its own history. Cause: ' +
        (err instanceof Error ? err.message : String(err)),
    );
  }

  if (saved) {
    const parsed = parse(saved);
    if (parsed) return parsed;
    /*
     * Stored but unparseable. NOT regenerated: whatever is there was written by
     * this app, and replacing it silently is the exact move that loses history.
     * Better to fail loudly and let a human decide.
     */
    throw new Error(
      `Device key at ${DEVICE_KEY_STORE_KEY} is present but unreadable. ` +
        'Refusing to overwrite it.',
    );
  }

  const ed = new Ed('ed25519', {} as never);
  await ed.generateKeyPair();
  const pair: DeviceKeyPair = {
    publicKey: b64(ed.getPublicKey()),
    privateKey: b64(ed.getPrivateKey()),
  };
  await store.setItem(DEVICE_KEY_STORE_KEY, JSON.stringify(pair));

  // Re-read rather than trusting the write: a concurrent first run may have won,
  // and two keys for one device is what persisting it exists to prevent.
  const reread = await store.getItem(DEVICE_KEY_STORE_KEY);
  return (reread && parse(reread)) || pair;
}

function parse(raw: string): DeviceKeyPair | null {
  try {
    const v = JSON.parse(raw) as Partial<DeviceKeyPair>;
    if (typeof v.publicKey !== 'string' || typeof v.privateKey !== 'string') return null;
    if (!v.publicKey || !v.privateKey) return null;
    return { publicKey: v.publicKey, privateKey: v.privateKey };
  } catch {
    return null;
  }
}

/**
 * Sign a server challenge.
 *
 * The nonce is signed as raw bytes, not as text: a caller that base64-decodes on
 * one side and not the other produces a signature that verifies nowhere, and the
 * failure would look like a wrong key.
 */
export async function signChallenge(
  store: SecureStoreLike,
  nonceB64: string,
): Promise<string> {
  const { privateKey } = await deviceKeyPair(store);
  const ed = new Ed('ed25519', {} as never);
  const sig = await ed.sign(unb64(nonceB64), unb64(privateKey));
  return b64(sig);
}

/** Verify a signature — the server's side, exported here so both use one path. */
export async function verifyChallenge(
  publicKeyB64: string,
  nonceB64: string,
  signatureB64: string,
): Promise<boolean> {
  const ed = new Ed('ed25519', {} as never);
  return ed.verify(unb64(signatureB64), unb64(nonceB64), unb64(publicKeyB64));
}

/** Test seam: drop the memo so a fresh store can be resolved. */
export function resetDeviceKeyMemo(): void {
  pending = null;
}
