/**
 * Portable MLS group-lifecycle client (RFC 9420, ciphersuite 0x0001) — mobile
 * mini-app copy. Byte-compatible with the web client
 * (openstoa/src/lib/mls/groupClient.ts): same wire format, same base64, so a
 * group created on web interoperates with a mobile device and vice versa.
 *
 * Difference from the web copy: ts-mls is loaded with a lazy `require` INSIDE
 * the accessor (not a top-level import). Per the Phase 0 on-device findings,
 * this (a) ensures ts-mls loads only after the host's boot WebCrypto polyfill
 * (index.js → ensureSubtleCrypto) has attached crypto.subtle, and (b) avoids
 * Metro `inlineRequires` resolving a top-level module namespace to undefined.
 *
 * NOTE: duplicated from the web copy (the mobile package is consumed standalone
 * via file: + Metro and can't import the Next app's src/). Keep the two in sync
 * — a shared @openstoa/mls package is a follow-up.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _T: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function T(): any {
  if (!_T) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _T = require('ts-mls');
  }
  return _T;
}

export const MLS_SUITE_NAME = 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519'; // 0x0001 (RFC 9420 MTI)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _impl: any = null;
async function impl() {
  if (!_impl) {
    // Use ts-mls's noble crypto provider (pure-JS @noble/ciphers AES-GCM) on
    // mobile instead of the default provider, which routes AES-GCM through
    // crypto.subtle. On Hermes that subtle is react-native-quick-crypto, whose
    // AES-GCM *encrypt* produces ciphertext that standard WebCrypto (the web
    // client) cannot decrypt — so mobile→web messages failed to open while
    // web→mobile worked (quick-crypto decrypt is fine). The noble AEAD is
    // byte-standard (16-byte tag appended) and interoperates with the web
    // client's subtle AES-GCM. HPKE/Ed25519 still use @hpke/core / subtle (both
    // proven working on-device), so only the application-message AEAD changes.
    _impl = await T().getCiphersuiteImpl(
      T().getCiphersuiteFromName(MLS_SUITE_NAME),
      T().nobleCryptoProvider,
    );
  }
  return _impl;
}

export interface SealedMessage {
  ciphertext: string;
  epoch: number;
  takVersion?: number | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type GroupState = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Device = any;

const enc = new TextEncoder();
const dec = new TextDecoder();
function b64(u: Uint8Array): string {
  let s = '';
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return btoa(s);
}
function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function topicGroupId(topicId: string): Uint8Array {
  return enc.encode(`openstoa:topic:${topicId}`);
}

export async function createDevice(identity: string): Promise<Device> {
  const cs = await impl();
  const cred = { credentialType: 'basic' as const, identity: enc.encode(identity) };
  return T().generateKeyPackage(cred, T().defaultCapabilities(), T().defaultLifetime, [], cs);
}

export function encodeKeyPackage(device: Device): string {
  return b64(
    T().encodeMlsMessage({ keyPackage: device.publicPackage, wireformat: 'mls_key_package', version: 'mls10' }),
  );
}

async function exportGroupInfo(state: GroupState): Promise<string> {
  const cs = await impl();
  const gi = await T().createGroupInfoWithExternalPubAndRatchetTree(state, [], cs);
  return b64(T().encodeMlsMessage({ groupInfo: gi, wireformat: 'mls_group_info', version: 'mls10' }));
}

export async function createTopicGroup(
  topicId: string,
  device: Device,
): Promise<{ state: GroupState; groupInfoB64: string }> {
  const cs = await impl();
  const state = await T().createGroup(
    topicGroupId(topicId),
    device.publicPackage,
    device.privatePackage,
    [],
    cs,
  );
  return { state, groupInfoB64: await exportGroupInfo(state) };
}

export async function joinTopicGroup(
  device: Device,
  groupInfoB64: string,
): Promise<{ state: GroupState; commitB64: string; groupInfoB64: string }> {
  const cs = await impl();
  const giMsg = T().decodeMlsMessage(unb64(groupInfoB64), 0)[0];
  if (giMsg.wireformat !== 'mls_group_info') throw new Error('expected group_info');
  const ext = await T().joinGroupExternal(giMsg.groupInfo, device.publicPackage, device.privatePackage, false, cs);
  const commitB64 = b64(
    T().encodeMlsMessage({ publicMessage: ext.publicMessage, wireformat: 'mls_public_message', version: 'mls10' }),
  );
  return { state: ext.newState, commitB64, groupInfoB64: await exportGroupInfo(ext.newState) };
}

export async function sealMessage(
  state: GroupState,
  plaintext: string,
): Promise<{ state: GroupState; sealed: SealedMessage }> {
  const cs = await impl();
  const epoch = Number(state.groupContext.epoch);
  const res = await T().createApplicationMessage(state, enc.encode(plaintext), cs);
  const ciphertext = b64(
    T().encodeMlsMessage({ privateMessage: res.privateMessage, wireformat: 'mls_private_message', version: 'mls10' }),
  );
  return { state: res.newState, sealed: { ciphertext, epoch } };
}

export type OpenResult =
  | { state: GroupState; kind: 'message'; plaintext: string }
  | { state: GroupState; kind: 'handshake' };

export async function openMessage(state: GroupState, sealed: SealedMessage): Promise<OpenResult> {
  const cs = await impl();
  const msg = T().decodeMlsMessage(unb64(sealed.ciphertext), 0)[0];
  if (msg.wireformat !== 'mls_private_message') {
    return { state, kind: 'handshake' };
  }
  const r = await T().processPrivateMessage(state, msg.privateMessage, T().emptyPskIndex, cs);
  if (r.kind === 'newState') return { state: r.newState, kind: 'handshake' };
  return { state: r.newState ?? state, kind: 'message', plaintext: dec.decode(r.message) };
}

export async function processCommit(state: GroupState, commitB64: string): Promise<GroupState> {
  const cs = await impl();
  const msg = T().decodeMlsMessage(unb64(commitB64), 0)[0];
  if (msg.wireformat === 'mls_public_message') {
    const r = await T().processPublicMessage(state, msg.publicMessage, T().emptyPskIndex, cs);
    return r.newState;
  }
  if (msg.wireformat === 'mls_private_message') {
    const r = await T().processPrivateMessage(state, msg.privateMessage, T().emptyPskIndex, cs);
    return r.newState ?? state;
  }
  return state;
}

export function currentEpoch(state: GroupState): number {
  return Number(state.groupContext.epoch);
}

/**
 * Serialize the live MLS ClientState to base64 for durable persistence
 * (Keychain/Keystore via the host secure store). Encodes the full GroupState —
 * everything needed to keep sealing/opening as the same leaf after an app
 * restart, so reopening no longer re-joins as a new leaf (which dropped
 * pre-restart history).
 */
export function serializeState(state: GroupState): string {
  return b64(T().encodeGroupState(state));
}

/**
 * Restore a persisted ClientState. decodeGroupState yields the GroupState but
 * not the (function-bearing, non-serializable) clientConfig, so reattach the
 * default config the group was created with. Lazy-require the subpath for the
 * same reason ts-mls itself is lazy here (load after the boot crypto polyfill).
 */
export function deserializeState(serialized: string): GroupState {
  const decoded = T().decodeGroupState(unb64(serialized), 0);
  const state = Array.isArray(decoded) ? decoded[0] : decoded;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  state.clientConfig = require('ts-mls/clientConfig.js').defaultClientConfig;
  return state;
}
