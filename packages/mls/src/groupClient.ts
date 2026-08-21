/**
 * Portable MLS group-lifecycle client (RFC 9420, ciphersuite 0x0001) for the
 * OpenStoa E2EE chat. Runs on browser WebCrypto and Node's webcrypto, so the
 * same logic backs the web client and its node integration test (and is ported
 * to the mobile mini-app, which adds Keychain/Keystore key storage).
 *
 * Topic = MLS group, device = leaf. Join is **self-service External Commit**:
 * a new device fetches the public GroupInfo and adds itself — no existing
 * member needs to be online (forum UX). This matches the server's Delivery
 * Service endpoints: key-packages / commit (epoch-CAS) / group-info, and the
 * crypto-free framing parser (External Commits are mls_public_message).
 *
 * State (ts-mls ClientState) is threaded by the caller and persisted by a
 * storage adapter (IndexedDB on web, Keychain/Keystore on mobile). This module
 * stays storage-agnostic and side-effect-free.
 */
// Static import: ts-mls is pure JS (no native deps), so it bundles cleanly
// under webpack (web) and Metro (mobile). It needs crypto.subtle only at call
// time — native in the browser, installed at app boot on mobile (index.js
// ensureSubtleCrypto). Node provides it globally for the tests.
//
// The mobile runtime CANNOT use this import (see `configureMlsRuntime` below)
// and supplies its own loader, so nothing here may assume `tsmls` is the module
// actually in use — always go through `T()`.
import * as tsmls from 'ts-mls';
// defaultClientConfig isn't re-exported from the ts-mls index; reach it via the
// package's `./*.js` exports subpath. Needed to rehydrate persisted state (see
// deserializeState) — decodeGroupState omits the (function-bearing) clientConfig.
import { defaultClientConfig } from 'ts-mls/clientConfig.js';
import { leafBelongsTo } from './leafIdentity';

/**
 * The two things that genuinely differ between the web and mobile runtimes.
 *
 * This module used to exist as three hand-synced copies, and the SDK copy
 * drifted 667 lines behind without a single red test — an AI member holding a
 * topic's TAK could not read an attachment because its copy had no `openMedia`.
 * The copies existed for exactly the two reasons below; everything else was
 * identical, so the two reasons are now parameters and the code is one file.
 *
 * Defaults are the WEB behaviour, so a host that configures nothing (browser,
 * node tests, the SDK) gets what it always got and cannot be broken by
 * forgetting to call `configureMlsRuntime`.
 */
export interface MlsRuntime {
  /**
   * How to reach the ts-mls module.
   *
   * Mobile cannot use a top-level import: ts-mls must load only AFTER the
   * host's boot WebCrypto polyfill has attached `crypto.subtle`, and Metro's
   * `inlineRequires` resolves a top-level module namespace to `undefined`. So
   * the mini-app passes a lazy `require`.
   */
  loadTsMls: () => unknown;
  /**
   * Runs once before the ciphersuite is built, for a host that must redirect
   * AES-GCM away from its own WebCrypto. Mobile installs a `@noble/ciphers`
   * shim here — see `installNobleAesGcmInterop`. No-op on web.
   */
  prepareCrypto?: () => void;
  /**
   * Extra argument to `getCiphersuiteImpl`. Mobile passes ts-mls's noble
   * provider; web passes nothing and gets browser WebCrypto.
   */
  cryptoProvider?: (tsmlsModule: unknown) => unknown;
}

const webRuntime: MlsRuntime = { loadTsMls: () => tsmls };
let runtime: MlsRuntime = webRuntime;

/**
 * Point this module at a non-browser runtime. Call ONCE, before any group
 * operation — the ciphersuite is memoized on first use and a later call cannot
 * retroactively change how existing state was built.
 */
export function configureMlsRuntime(next: MlsRuntime): void {
  runtime = next;
}

export const MLS_SUITE_NAME = 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519'; // 0x0001 (RFC 9420 MTI)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function T(): any {
  return runtime.loadTsMls();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _impl: any = null;
async function impl() {
  if (!_impl) {
    runtime.prepareCrypto?.();
    const provider = runtime.cryptoProvider?.(T());
    const suite = T().getCiphersuiteFromName(MLS_SUITE_NAME);
    _impl = provider
      ? await T().getCiphersuiteImpl(suite, provider)
      : await T().getCiphersuiteImpl(suite);
  }
  return _impl;
}

/**
 * The shared CiphersuiteImpl (memoized) for code that needs the raw crypto
 * primitives (HPKE seal/open, KDF, AEAD, MLS exporter) — e.g. the TAK archive
 * layer. Same instance the group lifecycle uses, so the provider matches
 * (browser subtle here; the mobile copy swaps in the noble provider).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function ciphersuiteImpl(): Promise<any> {
  return impl();
}

/**
 * RFC 9420 MLS exporter (re-exported from ts-mls) — derives an application
 * secret from a group's exporter secret. Used by the TAK layer to derive a
 * per-epoch archive key bound to (label, context).
 */
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
  ciphertext: string; // base64 MLSMessage (mls_private_message)
  epoch: number;
  takVersion?: number | null;
}

// Opaque ts-mls handles — callers thread these without inspecting them.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type GroupState = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Device = any;

const enc = new TextEncoder();
const dec = new TextDecoder();
// Browser + Node safe base64 (Buffer is absent in the Next.js client bundle;
// btoa/atob are global in both runtimes).
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

/** Deterministic MLS group_id for a topic (so all devices target the same group). */
export function topicGroupId(topicId: string): Uint8Array {
  return enc.encode(`openstoa:topic:${topicId}`);
}

/** Create this device's signing identity + first KeyPackage. */
export async function createDevice(identity: string): Promise<Device> {
  const cs = await impl();
  const cred = { credentialType: 'basic' as const, identity: enc.encode(identity) };
  return T().generateKeyPackage(cred, T().defaultCapabilities(), T().defaultLifetime, [], cs);
}

/** base64 of this device's public KeyPackage (uploaded to the directory). */
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

/** Genesis: the first member creates the group (epoch 0) and exports GroupInfo. */
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

/**
 * Self-service join via External Commit. Returns the new state, the base64
 * Commit to POST to /mls/commit, and the refreshed GroupInfo to attach so the
 * next joiner can in turn join.
 */
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

/** Seal a plaintext into an application message for the current epoch. */
export async function sealMessage(
  state: GroupState,
  plaintext: string,
): Promise<{ state: GroupState; sealed: SealedMessage }> {
  const cs = await impl();
  const epoch = Number(state.groupContext.epoch); // app messages don't advance the epoch
  const res = await T().createApplicationMessage(state, enc.encode(plaintext), cs);
  const ciphertext = b64(
    T().encodeMlsMessage({ privateMessage: res.privateMessage, wireformat: 'mls_private_message', version: 'mls10' }),
  );
  return { state: res.newState, sealed: { ciphertext, epoch } };
}

export type OpenResult =
  | { state: GroupState; kind: 'message'; plaintext: string }
  | { state: GroupState; kind: 'handshake' }; // a commit/proposal slipped in — caller re-syncs

/** Open an incoming sealed application message. */
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

/** Advance local state by applying an incoming Commit (live fan-out or catch-up). */
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

/** Current epoch of a live state. */
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
  for (const leaf of leafIdentities(state)) {
    if (leaf.identity === identity) return leaf.leafIndex;
  }
  return null;
}

/**
 * Every occupied leaf, as `{ leafIndex, identity }`, read from the local
 * validated ratchet tree.
 *
 * The tree is the device roster. There is no server-side table of a member's
 * devices and there should not be one: a join-time snapshot goes stale the
 * moment someone adds a phone, while the tree is by construction what the group
 * currently is.
 */
export function leafIdentities(state: GroupState): Array<{ leafIndex: number; identity: string }> {
  const tree = state.ratchetTree as Array<
    { nodeType?: string; leaf?: { credential?: { credentialType?: string; identity?: Uint8Array } } } | undefined
  >;
  const out: Array<{ leafIndex: number; identity: string }> = [];
  for (let i = 0; i < tree.length; i++) {
    const node = tree[i];
    if (!node || node.nodeType !== 'leaf' || !node.leaf) continue;
    const cred = node.leaf.credential;
    if (!cred || cred.credentialType !== 'basic' || !cred.identity) continue;
    out.push({ leafIndex: i / 2, identity: dec.decode(cred.identity) }); // node index → leaf index
  }
  return out;
}

/**
 * Every leaf belonging to `userId` — an account has one leaf PER DEVICE, and
 * removing a person means removing all of them.
 *
 * Missing one is not a partial success: the account keeps a live device in the
 * group, keeps deriving every future epoch key, and keeps reading. That is the
 * difference between being removed and appearing to have been removed.
 *
 * Leaves whose credential predates the `<userId>:<deviceId>` format are
 * attributed to nobody rather than guessed at — see `leafIdentity.ts` for why
 * that direction is the safe one.
 */
export function findLeafIndicesByUser(state: GroupState, userId: string): number[] {
  return leafIdentities(state)
    .filter((l) => leafBelongsTo(l.identity, userId))
    .map((l) => l.leafIndex);
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
  return removeMembers(state, [leafIndex]);
}

/**
 * Remove SEVERAL leaves in ONE Commit.
 *
 * This is the shape removal actually needs, because an account owns a leaf per
 * device and all of them go together. Doing it as one Commit per leaf would be
 * wrong in three ways: each Commit advances the epoch, so each has to win its
 * own epoch-CAS race against every other member; a failure halfway through
 * leaves the account still in the group on its remaining devices; and the group
 * would see N system events for one removal.
 *
 * Duplicate indices are collapsed and the order is normalised, so a caller that
 * assembles the list from several lookups cannot produce a malformed Commit.
 * An empty list is refused rather than turned into an empty Commit, which would
 * burn an epoch to say nothing.
 */
export async function removeMembers(
  state: GroupState,
  leafIndices: number[],
): Promise<{ state: GroupState; commitB64: string; groupInfoB64: string }> {
  const targets = [...new Set(leafIndices)].sort((a, b) => a - b);
  if (targets.length === 0) throw new Error('removeMembers: no leaves to remove');
  const cs = await impl();
  const extraProposals = targets.map((removed) => ({ proposalType: 'remove', remove: { removed } }));
  const res = await T().createCommit(
    { state, cipherSuite: cs, pskIndex: T().emptyPskIndex },
    { extraProposals, ratchetTreeExtension: true },
  );
  const commitB64 = b64(T().encodeMlsMessage(res.commit));
  return { state: res.newState, commitB64, groupInfoB64: await exportGroupInfo(res.newState) };
}

/**
 * Serialize the live MLS ClientState to base64 for durable persistence
 * (IndexedDB on web, Keychain/Keystore on mobile). Encodes the full GroupState
 * (key schedule, secret tree, private path, signature key) — everything needed
 * to keep sealing/opening as the same leaf after an app restart, so reopening
 * no longer re-joins as a new leaf (which dropped pre-restart history).
 */
export function serializeState(state: GroupState): string {
  return b64(T().encodeGroupState(state));
}

/**
 * Restore a persisted ClientState. decodeGroupState yields the GroupState but
 * not the (function-bearing, non-serializable) clientConfig, so reattach the
 * default config the group was created with (createGroup / joinGroupExternal
 * both default to defaultClientConfig).
 */
export function deserializeState(serialized: string): GroupState {
  const decoded = T().decodeGroupState(unb64(serialized), 0);
  const state = Array.isArray(decoded) ? decoded[0] : decoded;
  state.clientConfig = defaultClientConfig;
  return state;
}
