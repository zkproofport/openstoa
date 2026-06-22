import { describe, it, expect } from 'vitest';
import {
  parseCommitFraming,
  MlsFramingError,
  WIRE_PRIVATE_MESSAGE,
  WIRE_PUBLIC_MESSAGE,
  CONTENT_COMMIT,
} from '@/lib/mls/framing';

// Real Commit MLSMessage bytes produced by ts-mls 1.6.2 (ciphersuite 0x0001),
// captured out-of-band so the SERVER never imports an MLS crypto library (C1).
// Both are mls_private_message handshake Commits; #0 builds on epoch 0, #1 on
// epoch 1. group_id = utf8("openstoa-topic-explore").
const FIXTURE_COMMIT_EPOCH0 =
  'AAEAAhZvcGVuc3RvYS10b3BpYy1leHBsb3JlAAAAAAAAAAADABxqGVjE8mSY3/UlksInOFsTWoStw8FMRkPW6K1qQbiu1kjBeORV2hFxs47XxshW8DwwB3q/t4L05SLGLPm64HwLUGZF7C/n1YLVN2W0t7RSgGeRPYdOLRhGW/YTv4m0GEh/nwYsSWNOa8xc27JdlHD7ALJzzmGBmiXpVhpt1tbJK46G2V/qRdiItHp/ylYFT7MuznMJ4RHl/sAs3/T1/w4trQ6Nk3ZN1jX7Xc8Ht47eWIFz+JXIKJLzQRZONnuBdCGs0bLcC7PHyUp1dIEn/Pe3ik3UNqE40vQibPfkK8418LhbIdWhWZGqXv2vPFTZGUo72gkxvbuaE0lu6rfP5m1kLcDM08P7ZXH0c6GjbG7FUh+TC4jpN2AZavzV2OKlE16W+ddpuAbl4s4b/SezwMDJ3veWN6emmhh6vzn5/NgoSxOUYz/q3rxgL6X4ysR+e3EmEFHPuXyM0tX2A75pPS//bbejFS0+BdIOsYYVjDA+F1cp1q61Elwa4LLDq5VghZerPaNci6OjMm7/12iHDDj8U05D0Uq5+S3C15KO5PoGbzr2bbKIxnZZT9L6xGQxGlomv+IuqX0TmeTpKY5EVqV0V6CJVYjBWWnREx86I5u/ZMefCxq4xQ==';
const FIXTURE_COMMIT_EPOCH1 =
  'AAEAAhZvcGVuc3RvYS10b3BpYy1leHBsb3JlAAAAAAAAAAEDABzeNvMcssfPdkz5wwQ5D3aKroyMhsxN4oEWDU5bQb71X9qWU6GdiSK90xuF0Whv757NiuEsUD/ry6Am3jBXPtDyGs38BQAZJbDJdLTry6b9M7cI335/H6KbbuObFdpAWr9GpXfHx3RCLbHUiPKjZX1CkXUnKVb2DV35Scd0fy9nirxluqbtZCTcFYWSYtT+scDtuRTTQZ/DwTmBzdTc+CYmYspGFvG4vLAtuZV3eAJSC//Dk9Nnrc2gDuOviz974D9wcG0OraqbnDo+nskcNVG05alVSTBfOjIlDF+/1ZoE+t/v4kr9cl7u2CBr+HJ3kN1isjAd9Bjb5XPws8bIilfpmWS1Tma8trJ5/WFCOnwJXc4tRN/FFNt57zCGySBdJbeWxpM80lzsNfoqxNKhegWxJpFKgyPgyj7Wa6QACCdIz3aUTS82NvLbY1g00oiyONZTlvoJMaCFIqoP34EdBseEc15FBk2W/qRzNjbklWtHIwsJJWwFv6N9fg0j+h5WcUG+VudngRWwe9g8B/WENEwmlDx0hDmRyVm6+Mqq7tP95RzvRpIMAbVMF4TWqiU6DWPyo49as4RDDIv/WXyzZj2eZDRbTAnAB6BEX3YG3WlaW5a+LyVb0jM1FdOlEA==';
const GROUP_ID = 'openstoa-topic-explore';

const b64 = (s: string) => Buffer.from(s, 'base64');

/** Build a minimal PublicMessage commit header for a given sender type. */
function craftPublicCommit(epoch: number, senderType: number, withLeaf = false): Buffer {
  const gid = Buffer.from('tg', 'utf8');
  const prefix = Buffer.from([0x00, 0x01, 0x00, WIRE_PUBLIC_MESSAGE]); // version=1, wire=public
  const gidLen = Buffer.from([gid.length]); // varint (len < 64)
  const ep = Buffer.alloc(8);
  ep.writeBigUInt64BE(BigInt(epoch));
  const sender = withLeaf
    ? Buffer.from([senderType, 0x00, 0x00, 0x00, 0x00]) // member: +uint32 leaf_index
    : Buffer.from([senderType]); // new_member_commit/proposal: no extra
  const authData = Buffer.from([0x00]); // authenticated_data<V> length 0
  const contentType = Buffer.from([CONTENT_COMMIT]);
  return Buffer.concat([prefix, gidLen, gid, ep, sender, authData, contentType]);
}

describe('parseCommitFraming — real ts-mls private-message commits', () => {
  it('extracts epoch 0 from a real Commit built on epoch 0', () => {
    const r = parseCommitFraming(b64(FIXTURE_COMMIT_EPOCH0));
    expect(r.epoch).toBe(0);
    expect(r.wireFormat).toBe(WIRE_PRIVATE_MESSAGE);
    expect(r.contentType).toBe(CONTENT_COMMIT);
    expect(r.groupId.toString('utf8')).toBe(GROUP_ID);
  });

  it('extracts epoch 1 from a real Commit built on epoch 1', () => {
    const r = parseCommitFraming(b64(FIXTURE_COMMIT_EPOCH1));
    expect(r.epoch).toBe(1);
    expect(r.wireFormat).toBe(WIRE_PRIVATE_MESSAGE);
    expect(r.groupId.toString('utf8')).toBe(GROUP_ID);
  });

  it('extracts the same group_id across epochs', () => {
    const a = parseCommitFraming(b64(FIXTURE_COMMIT_EPOCH0));
    const b = parseCommitFraming(b64(FIXTURE_COMMIT_EPOCH1));
    expect(a.groupId.equals(b.groupId)).toBe(true);
  });
});

describe('parseCommitFraming — public-message (External Commit) path', () => {
  it('parses a new_member_commit (External Commit) public message', () => {
    const r = parseCommitFraming(craftPublicCommit(5, 4 /* new_member_commit */));
    expect(r.epoch).toBe(5);
    expect(r.wireFormat).toBe(WIRE_PUBLIC_MESSAGE);
    expect(r.contentType).toBe(CONTENT_COMMIT);
    expect(r.groupId.toString('utf8')).toBe('tg');
  });

  it('parses a member (leaf_index) public commit, skipping the uint32 sender', () => {
    const r = parseCommitFraming(craftPublicCommit(7, 1 /* member */, true));
    expect(r.epoch).toBe(7);
    expect(r.wireFormat).toBe(WIRE_PUBLIC_MESSAGE);
  });
});

describe('parseCommitFraming — rejects malformed / non-commit input', () => {
  it('rejects an empty buffer', () => {
    expect(() => parseCommitFraming(Buffer.alloc(0))).toThrow(MlsFramingError);
  });

  it('rejects a truncated commit', () => {
    expect(() => parseCommitFraming(b64(FIXTURE_COMMIT_EPOCH0).subarray(0, 10))).toThrow(MlsFramingError);
  });

  it('rejects an unsupported MLS version', () => {
    const bad = b64(FIXTURE_COMMIT_EPOCH0);
    bad.writeUInt16BE(2, 0); // version 2
    expect(() => parseCommitFraming(bad)).toThrow(/unsupported MLS version/);
  });

  it('rejects a non-handshake wire format (e.g. welcome=3)', () => {
    const bad = b64(FIXTURE_COMMIT_EPOCH0);
    bad.writeUInt16BE(3, 2); // wire_format = mls_welcome
    expect(() => parseCommitFraming(bad)).toThrow(/not a handshake wire format/);
  });

  it('rejects a private message whose content_type is not commit', () => {
    const bad = b64(FIXTURE_COMMIT_EPOCH0);
    // content_type byte = version(2)+wire(2)+gidLen(1)+gid(22)+epoch(8) = offset 35
    bad[35] = CONTENT_COMMIT - 2; // = 1 (application)
    expect(() => parseCommitFraming(bad)).toThrow(/not a commit/);
  });
});
