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
