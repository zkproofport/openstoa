/**
 * Portable MLS group-lifecycle client (RFC 9420, ciphersuite 0x0001) — mobile
 * mini-app copy. Byte-compatible with the web client
 * (openstoa/src/lib/mls/groupClient.ts): same wire format, same base64, so a
 * group created on web interoperates with a mobile device and vice versa.
 *
 * Differences from the web copy (both are mobile-runtime workarounds; the MLS
 * logic below is identical and must stay in sync):
 *  1. ts-mls is loaded with a lazy `require` INSIDE the accessor (not a
 *     top-level import). Per the Phase 0 on-device findings, this (a) ensures
 *     ts-mls loads only after the host's boot WebCrypto polyfill (index.js →
 *     ensureSubtleCrypto) has attached crypto.subtle, and (b) avoids Metro
 *     `inlineRequires` resolving a top-level module namespace to undefined.
 *  2. AES-GCM is served from @noble/ciphers instead of the host's WebCrypto —
 *     see installAesGcmInterop below.
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

// ---------------------------------------------------------------------------
// AES-GCM interop shim (mobile only)
// ---------------------------------------------------------------------------
// On Hermes `crypto.subtle` is react-native-quick-crypto, whose AES-GCM
// *encrypt* produces ciphertext that standard WebCrypto (the web client) cannot
// decrypt — mobile→web breaks while web→mobile keeps working, because
// quick-crypto's *decrypt* accepts standard ciphertext.
//
// ts-mls's `nobleCryptoProvider` only replaces the MLS application-message
// AEAD. HPKE — Commit UpdatePath secrets, Welcome, and every TAK archive/key
// bundle (takClient `cs.hpke.seal`) — is built by ts-mls on `@hpke/core`'s
// `Aes128Gcm`, which calls `crypto.subtle` directly and is unreachable through
// ts-mls's public API. So a mobile-produced External Commit still carried a
// quick-crypto-sealed path secret that other members could not HPKE-open:
// their `processCommit` threw → `catchUp` threw → every later mobile message
// rendered as "[unable to decrypt]" for them.
//
// Fix: serve raw AES-GCM keys from `@noble/ciphers` (pure JS, spec-exact:
// 16-byte tag appended, `additionalData` honoured) instead of the host's
// WebCrypto, so NO AES-GCM operation in the mini-app depends on it. Everything
// else (HKDF, X25519, Ed25519, SHA-2 — all proven on-device) falls through
// untouched. On a spec-correct WebCrypto this is byte-identical, so it is inert
// on web/node and safe for any other host consumer of subtle AES-GCM.
const NOBLE_AES_KEY = '__openstoaNobleAesGcmKey';
let _aesShimInstalled = false;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function algNameOf(a: any): string {
  return (typeof a === 'string' ? a : a?.name) ?? '';
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function asBytes(d: any): Uint8Array {
  if (d instanceof Uint8Array) return d;
  if (ArrayBuffer.isView(d)) return new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
  return new Uint8Array(d);
}

function toArrayBuffer(u: Uint8Array): ArrayBuffer {
  return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
}

function installAesGcmInterop(): void {
  if (_aesShimInstalled) return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const subtle: any = (globalThis as any).crypto?.subtle;
  if (!subtle) return; // no WebCrypto yet — ts-mls would fail anyway; leave as-is
  _aesShimInstalled = true;

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { gcm } = require('@noble/ciphers/aes.js');

  const nativeImportKey = subtle.importKey.bind(subtle);
  const nativeEncrypt = subtle.encrypt.bind(subtle);
  const nativeDecrypt = subtle.decrypt.bind(subtle);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawKeyOf = (key: any): Uint8Array | null =>
    key && typeof key === 'object' && key[NOBLE_AES_KEY] instanceof Uint8Array ? key[NOBLE_AES_KEY] : null;

  // Only `raw` AES-GCM keys are intercepted; the marker object carries the key
  // bytes so encrypt/decrypt can run them through noble. WebCrypto CryptoKeys
  // are imported non-extractable, so the bytes are otherwise unrecoverable.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  subtle.importKey = async (format: string, keyData: any, algorithm: any, extractable: boolean, usages: string[]) => {
    if (format === 'raw' && algNameOf(algorithm) === 'AES-GCM') {
      return {
        type: 'secret',
        extractable,
        usages,
        algorithm: { name: 'AES-GCM', length: asBytes(keyData).length * 8 },
        [NOBLE_AES_KEY]: new Uint8Array(asBytes(keyData)),
      };
    }
    return nativeImportKey(format, keyData, algorithm, extractable, usages);
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const nobleParams = (algorithm: any, raw: Uint8Array) => {
    // tagLength defaults to 128 in WebCrypto, which is what noble produces.
    if (algorithm.tagLength !== undefined && algorithm.tagLength !== 128) return null;
    const aad = algorithm.additionalData ? asBytes(algorithm.additionalData) : undefined;
    return gcm(raw, asBytes(algorithm.iv), aad && aad.length > 0 ? aad : undefined);
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  subtle.encrypt = async (algorithm: any, key: any, data: any) => {
    const raw = rawKeyOf(key);
    if (raw && algNameOf(algorithm) === 'AES-GCM') {
      const cipher = nobleParams(algorithm, raw);
      if (cipher) return toArrayBuffer(cipher.encrypt(asBytes(data)));
    }
    return nativeEncrypt(algorithm, key, data);
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  subtle.decrypt = async (algorithm: any, key: any, data: any) => {
    const raw = rawKeyOf(key);
    if (raw && algNameOf(algorithm) === 'AES-GCM') {
      const cipher = nobleParams(algorithm, raw);
      if (cipher) return toArrayBuffer(cipher.decrypt(asBytes(data)));
    }
    return nativeDecrypt(algorithm, key, data);
  };
}

/** Test hook: true once the AES-GCM interop shim is active. */
export function aesGcmInteropInstalled(): boolean {
  return _aesShimInstalled;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _impl: any = null;
async function impl() {
  if (!_impl) {
    // Route every AES-GCM operation away from the host's WebCrypto first (see
    // installAesGcmInterop) — this covers HPKE (@hpke/core), which ts-mls's
    // noble provider does NOT.
    installAesGcmInterop();
    // ts-mls's noble crypto provider additionally keeps the MLS
    // application-message AEAD, hashes and KDF in pure JS.
    _impl = await T().getCiphersuiteImpl(
      T().getCiphersuiteFromName(MLS_SUITE_NAME),
      T().nobleCryptoProvider,
    );
  }
  return _impl;
}

/**
 * The shared CiphersuiteImpl (memoized, noble provider) for the TAK archive
 * layer — HPKE seal/open, KDF, AEAD, MLS exporter. Same instance the group
 * lifecycle uses, so archive AEAD matches the live-message path (noble) and
 * interops with the web client.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function ciphersuiteImpl(): Promise<any> {
  return impl();
}

/** RFC 9420 MLS exporter (re-exported) — derives the per-epoch TAK. */
export function mlsExporter(
  exporterSecret: Uint8Array,
  label: string,
  context: Uint8Array,
  length: number,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  cs: any,
): Promise<Uint8Array> {
  return T().mlsExporter(exporterSecret, label, context, length, cs);
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
 * Leaf index (not node index) of the member whose basic-credential identity
 * equals `identity`, or null if no such member exists in the validated ratchet
 * tree. Used to target an MLS Remove at a specific device leaf (e.g. an AI
 * member being revoked). Reads only the local validated state — never a
 * server-supplied value.
 */
export function findLeafIndexByIdentity(state: GroupState, identity: string): number | null {
  const tree = state.ratchetTree as Array<
    { nodeType?: string; leaf?: { credential?: { credentialType?: string; identity?: Uint8Array } } } | undefined
  >;
  for (let i = 0; i < tree.length; i++) {
    const node = tree[i];
    if (!node || node.nodeType !== 'leaf' || !node.leaf) continue;
    const cred = node.leaf.credential;
    if (!cred || cred.credentialType !== 'basic' || !cred.identity) continue;
    if (dec.decode(cred.identity) === identity) return i / 2; // node index → leaf index
  }
  return null;
}

/**
 * Remove a member leaf via a Remove Commit (D11 revocation). Produces a Commit
 * that drops `leafIndex` and advances the epoch, so the removed device is
 * excluded from every future epoch (post-compromise security) while remaining
 * members keep reading. Returns the new state, the base64 Commit to POST to
 * /mls/commit (epoch-CAS), and the refreshed GroupInfo for later External
 * Commits (e.g. re-adding the member from its reusable last-resort KeyPackage).
 * Note (D11): this only gates FUTURE epochs — plaintext the member already
 * received is NOT cryptographically revocable; that is paired with the server
 * grant DELETE for immediate access-gating.
 */
export async function removeMember(
  state: GroupState,
  leafIndex: number,
): Promise<{ state: GroupState; commitB64: string; groupInfoB64: string }> {
  const cs = await impl();
  const proposal = { proposalType: 'remove', remove: { removed: leafIndex } };
  const res = await T().createCommit(
    { state, cipherSuite: cs, pskIndex: T().emptyPskIndex },
    { extraProposals: [proposal], ratchetTreeExtension: true },
  );
  const commitB64 = b64(T().encodeMlsMessage(res.commit));
  return { state: res.newState, commitB64, groupInfoB64: await exportGroupInfo(res.newState) };
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
