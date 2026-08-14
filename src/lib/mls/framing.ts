/**
 * Crypto-free MLS message framing parser (RFC 9420 §6) for the Delivery Service.
 *
 * The OpenStoa server runs NO MLS crypto (design decision C1). To enforce
 * one-Commit-per-epoch (SI-2) it must read the epoch a Commit asserts WITHOUT
 * decrypting anything. RFC 9420 places `group_id`, `epoch` and `content_type`
 * in the CLEARTEXT header of both PublicMessage and PrivateMessage framings —
 * only the sender data and the content payload are encrypted. This module
 * parses exactly that cleartext header and nothing else; no key material is
 * ever touched.
 *
 * Wire layout (verified empirically against ts-mls 1.6.2, ciphersuite 0x0001):
 *
 *   MLSMessage = uint16 version | uint16 wire_format | <body>
 *
 *   PrivateMessage body (wire_format = 2, what ts-mls emits for handshakes):
 *     opaque group_id<V>; uint64 epoch; ContentType content_type; ...
 *     → content_type sits immediately after epoch.
 *
 *   PublicMessage body (wire_format = 1, used for External Commits):
 *     FramedContent { opaque group_id<V>; uint64 epoch; Sender sender;
 *                     opaque authenticated_data<V>; ContentType content_type; ... }
 *     → content_type sits after Sender + authenticated_data.
 *
 * `group_id` and `epoch` are at the SAME offsets for both wire formats; only
 * the path to `content_type` differs.
 */

export const MLS_VERSION_MLS10 = 1;
export const WIRE_PUBLIC_MESSAGE = 1;
export const WIRE_PRIVATE_MESSAGE = 2;

// RFC 9420 §6.1 ContentType
export const CONTENT_APPLICATION = 1;
export const CONTENT_PROPOSAL = 2;
export const CONTENT_COMMIT = 3;

// RFC 9420 §6.1 SenderType
const SENDER_MEMBER = 1;
const SENDER_EXTERNAL = 2;
const SENDER_NEW_MEMBER_PROPOSAL = 3;
const SENDER_NEW_MEMBER_COMMIT = 4;

export interface CommitFraming {
  version: number;
  wireFormat: number;
  groupId: Buffer;
  /** The epoch the Commit builds ON (the "from" epoch the DS checks against). */
  epoch: number;
  contentType: number;
}

export class MlsFramingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MlsFramingError';
  }
}

/**
 * RFC 9420 §2.1.2 variable-length integer (QUIC RFC 9000 §16 encoding): the top
 * two bits of the first byte select a 1/2/4/8-byte big-endian length.
 */
function readVarint(buf: Buffer, off: number): { value: number; next: number } {
  if (off >= buf.length) throw new MlsFramingError('varint: out of bounds');
  const b0 = buf[off];
  const lenBytes = 1 << (b0 >> 6);
  if (off + lenBytes > buf.length) throw new MlsFramingError('varint: truncated');
  let value = b0 & 0x3f;
  for (let i = 1; i < lenBytes; i++) value = value * 256 + buf[off + i];
  return { value, next: off + lenBytes };
}

/** Skip an `opaque<V>` field (varint length prefix + that many bytes). */
function skipOpaque(buf: Buffer, off: number): number {
  const { value, next } = readVarint(buf, off);
  const end = next + value;
  if (end > buf.length) throw new MlsFramingError('opaque field truncated');
  return end;
}

/**
 * Parse the cleartext MLS handshake header and assert it is a Commit. Throws
 * MlsFramingError on anything malformed, the wrong version, or a non-commit
 * content type. Returns the asserted epoch + group_id for the DS epoch-CAS.
 *
 * Accepts both PrivateMessage (regular member commit, ts-mls default) and
 * PublicMessage (External Commit for device-change). Never decrypts.
 */
export function parseCommitFraming(input: Buffer | Uint8Array): CommitFraming {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (buf.length < 4) throw new MlsFramingError('too short for MLSMessage prefix');

  const version = buf.readUInt16BE(0);
  if (version !== MLS_VERSION_MLS10) {
    throw new MlsFramingError(`unsupported MLS version ${version} (expected mls10=1)`);
  }
  const wireFormat = buf.readUInt16BE(2);
  if (wireFormat !== WIRE_PRIVATE_MESSAGE && wireFormat !== WIRE_PUBLIC_MESSAGE) {
    throw new MlsFramingError(`not a handshake wire format: ${wireFormat}`);
  }

  // group_id<V> — same offset for both wire formats.
  const { value: gidLen, next: afterGidLen } = readVarint(buf, 4);
  const gidEnd = afterGidLen + gidLen;
  if (gidEnd > buf.length) throw new MlsFramingError('group_id truncated');
  const groupId = Buffer.from(buf.subarray(afterGidLen, gidEnd));

  // epoch uint64 (big-endian) — same offset for both wire formats.
  if (gidEnd + 8 > buf.length) throw new MlsFramingError('epoch truncated');
  const epochBig = buf.readBigUInt64BE(gidEnd);
  if (epochBig > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new MlsFramingError('epoch exceeds safe integer range');
  }
  const epoch = Number(epochBig);

  // content_type — path differs by wire format.
  let ctOff: number;
  if (wireFormat === WIRE_PRIVATE_MESSAGE) {
    ctOff = gidEnd + 8;
  } else {
    // PublicMessage: skip Sender, then authenticated_data<V>.
    let off = gidEnd + 8;
    if (off >= buf.length) throw new MlsFramingError('sender truncated');
    const senderType = buf[off];
    off += 1;
    if (senderType === SENDER_MEMBER || senderType === SENDER_EXTERNAL) {
      off += 4; // uint32 leaf_index / sender_index
    } else if (senderType !== SENDER_NEW_MEMBER_PROPOSAL && senderType !== SENDER_NEW_MEMBER_COMMIT) {
      throw new MlsFramingError(`unknown sender_type ${senderType}`);
    }
    off = skipOpaque(buf, off); // authenticated_data<V>
    ctOff = off;
  }

  if (ctOff >= buf.length) throw new MlsFramingError('content_type truncated');
  const contentType = buf[ctOff];
  if (contentType !== CONTENT_COMMIT) {
    throw new MlsFramingError(`not a commit (content_type=${contentType})`);
  }

  return { version, wireFormat, groupId, epoch, contentType };
}

/**
 * The device id of the leaf a Commit ADDS, or null when the Commit does not
 * name one.
 *
 * This is the server's only unforgeable evidence that a device joined a topic
 * and when (`docs/design/device-join-signal.md`). It matters because a member
 * cannot fabricate another device's join without actually performing it —
 * unlike a client-reported join, which is a claim.
 *
 * It works for exactly one shape, and that is the shape that matters: a device
 * joining is an EXTERNAL Commit, which ts-mls frames as a PublicMessage whose
 * content is not encrypted. An ordinary member Commit is a PrivateMessage and
 * its proposals and path are sealed — so this returns null there rather than
 * reading whatever bytes sit at the offset. A wrong device id is worse than no
 * device id: it would be owed messages forever and never ack.
 *
 * Layout after the `content_type` byte this file already walks to (RFC 9420
 * §12.4, verified empirically against ts-mls, same as the header parse above):
 *
 *   Commit { ProposalOrRef proposals<V>; optional<UpdatePath> path; }
 *   UpdatePath { LeafNode leaf_node; UpdatePathNode nodes<V>; }
 *   LeafNode  { HPKEPublicKey encryption_key<V>; ... }
 *
 * so the key is the first field reachable past the proposal vector and the
 * one-byte `optional` presence flag. Returned base64-encoded, which is exactly
 * `takClient.leafDeviceId` — the id the delivery cursor and the TAK bundle
 * routes already key on, so a join row and an ack row name the same device.
 *
 * NEVER throws: every malformed, truncated or unexpected input is null. This
 * runs on the commit path, and a parse failure must not be able to refuse a
 * member's Commit.
 */
/** RFC 9420 §5.3 CredentialType. `basic` carries a raw identity string. */
const CREDENTIAL_BASIC = 1;

/** What a join Commit says about the device it adds. */
export interface JoinerLeaf {
  /** base64 of the leaf HPKE public key — the same id `leafDeviceId` produces. */
  deviceId: string;
  /**
   * The leaf's credential, verbatim: `<userId>:<deviceId>` for an attributable
   * device, and a bare handle for one that predates that convention (an agent
   * leaf minted as `sdk-<uuid>`, for instance).
   *
   * Returned RAW rather than split, because naming a leaf is `leafIdentity`'s
   * rule and not this parser's, and because a caller that stores the raw string
   * can tell "nobody could name this leaf" from "not looked up yet". Null when
   * the credential is not a `basic` one, which is the only kind this system
   * mints — anything else is not ours to interpret.
   */
  identity: string | null;
}

/**
 * The device a Commit ADDS: its leaf key, and the credential naming it.
 *
 * Same walk and the same one shape as `parseJoinerLeafKey` — an External Commit,
 * framed as a PublicMessage, whose content is not encrypted. See that function
 * for why an ordinary Commit yields null instead of a guess.
 *
 * The credential is read because a device id alone cannot answer "whose device
 * is this?", and two callers need that: the delivery obligation has to bind a
 * device to an account, and inactive-leaf eviction has to know which account a
 * stale leaf belonged to. Both are in `docs/design/device-join-signal.md`.
 */
export function parseJoinerLeaf(input: Buffer | Uint8Array): JoinerLeaf | null {
  try {
    const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
    const off = joinerLeafOffset(buf);
    if (off === null) return null;

    const { value: keyLen, next: keyStart } = readVarint(buf, off);
    const keyEnd = keyStart + keyLen;
    if (keyLen === 0 || keyEnd > buf.length) return null;
    const deviceId = Buffer.from(buf.subarray(keyStart, keyEnd)).toString('base64');

    // LeafNode continues: signature_key<V>, then Credential.
    let p = skipOpaque(buf, keyEnd);
    if (p + 2 > buf.length) return { deviceId, identity: null };
    const credentialType = buf.readUInt16BE(p);
    p += 2;
    if (credentialType !== CREDENTIAL_BASIC) return { deviceId, identity: null };
    const { value: idLen, next: idStart } = readVarint(buf, p);
    const idEnd = idStart + idLen;
    // A truncated identity is no identity: half a credential names the wrong
    // account as readily as the right one.
    if (idLen === 0 || idEnd > buf.length) return { deviceId, identity: null };
    return { deviceId, identity: buf.subarray(idStart, idEnd).toString('utf8') };
  } catch {
    return null;
  }
}

/**
 * Offset of the joining leaf's `encryption_key<V>` in a PublicMessage Commit
 * that carries an UpdatePath, or null when there is none to read.
 */
function joinerLeafOffset(buf: Buffer): number | null {
  const framing = parseCommitFraming(buf);
  if (framing.wireFormat !== WIRE_PUBLIC_MESSAGE) return null;

  const { next: afterGidLen, value: gidLen } = readVarint(buf, 4);
  let off = afterGidLen + gidLen + 8; // + epoch uint64
  const senderType = buf[off];
  off += 1;
  if (senderType === SENDER_MEMBER || senderType === SENDER_EXTERNAL) off += 4;
  off = skipOpaque(buf, off); // authenticated_data<V>
  off += 1; // content_type, already asserted COMMIT by parseCommitFraming
  off = skipOpaque(buf, off); // proposals<V>
  if (off >= buf.length) return null;
  const hasPath = buf[off];
  off += 1;
  return hasPath === 1 ? off : null;
}

export function parseJoinerLeafKey(input: Buffer | Uint8Array): string | null {
  return parseJoinerLeaf(input)?.deviceId ?? null;
}
