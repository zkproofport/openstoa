/**
 * Generate cross-implementation known-answer vectors for the TAK archive layer.
 *
 * The iOS Notification Service Extension (proofport-app `ios/OpenStoaNSE`) ports
 * `sealArchive`/`openArchive` to CryptoKit so it can preview a ciphertext push
 * without touching the live MLS ratchet. A green Swift build proves nothing about
 * whether the two implementations agree on the key schedule, so this script seals
 * a fixed set of plaintexts under a deterministic TAK and the Swift side must
 * reproduce every one of them byte for byte.
 *
 * Run:  npx tsx scripts/gen-archive-vectors.ts > \
 *         ../proofport-app/ios/scripts/archive_vectors.json
 * Verify: proofport-app/ios/scripts/verify_archive_vectors.sh
 */
import * as gc from '../src/lib/mls/groupClient';
import * as tak from '../src/lib/mls/takClient';

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

async function main() {
  const cs = await gc.ciphersuiteImpl();
  // The Swift port hardcodes these suite parameters; record them so a ciphersuite
  // change surfaces as a vector-file diff rather than a silent preview failure.
  const meta = {
    suite: gc.MLS_SUITE_NAME,
    kdfSize: cs.kdf.size,
    nonceLength: cs.hpke.nonceLength,
    aeadKeyLength: cs.hpke.keyLength,
  };

  // Deterministic TAK (0x00..0x1f) so the vector file is reproducible.
  const takBytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) takBytes[i] = i;

  const cases: Array<{ name: string; messageId: string; plaintext: string }> = [
    { name: 'ascii', messageId: '01JQZ8ASCII0000000000000000', plaintext: 'Alice: meeting at 3' },
    { name: 'korean_emoji', messageId: '01JQZ8KOREAN000000000000000', plaintext: 'Alice: 회의 3시 🎉 잘 부탁드립니다' },
    { name: 'empty', messageId: '01JQZ8EMPTY0000000000000000', plaintext: '' },
    { name: 'one_char', messageId: '01JQZ8ONECHAR00000000000000', plaintext: 'x' },
    {
      name: 'multiscript',
      messageId: '01JQZ8MULTI0000000000000000',
      plaintext: 'en/한글/日本語/Ελληνικά/🇰🇷\ttab\nnewline',
    },
    { name: 'large', messageId: '01JQZ8LARGE0000000000000000', plaintext: 'A'.repeat(20000) },
    { name: 'colon_in_msgid', messageId: 'weird:id:with:colons', plaintext: 'colon in the message id' },
    { name: 'hostile_msgid', messageId: '%_\\\'"<script>', plaintext: 'hostile message id' },
    { name: 'utf8_msgid', messageId: '메시지-🆔-01', plaintext: 'utf8 message id' },
  ];

  const vectors: Array<{ name: string; messageId: string; sealed: string; plaintext: string }> = [];
  for (const c of cases) {
    const sealed = await tak.sealArchive(takBytes, c.messageId, c.plaintext);
    const back = await tak.openArchive(takBytes, c.messageId, sealed);
    if (back !== c.plaintext) throw new Error(`TS round-trip failed for vector "${c.name}"`);
    vectors.push({ name: c.name, messageId: c.messageId, sealed, plaintext: c.plaintext });
  }

  // Push-preview vectors — what a SENDER actually puts in `pushArchive.ct`.
  // sealPushPreview binds the fixed `push-preview` context instead of the
  // message id, because the sender seals before POST /chat has assigned one.
  // A port that opens `act` with the message id derives a different key and
  // silently degrades every push to "New message", so this case must stay
  // covered on both platforms. `messageId` here is the UNRELATED id the push
  // also carries — a correct port must ignore it for the first attempt.
  const pushPreviews: Array<{ name: string; messageId: string; sealed: string; plaintext: string }> = [];
  for (const c of [
    { name: 'push_ascii', messageId: '01JQZ8PUSHASCII000000000000', plaintext: 'Alice: meeting at 3' },
    { name: 'push_korean_emoji', messageId: '01JQZ8PUSHKOREAN0000000000', plaintext: 'Alice: 회의 3시 🎉' },
    { name: 'push_empty', messageId: '01JQZ8PUSHEMPTY00000000000', plaintext: '' },
  ]) {
    const sealed = await tak.sealPushPreview(takBytes, c.plaintext);
    const back = await tak.openPushPreview(takBytes, sealed);
    if (back !== c.plaintext) throw new Error(`TS round-trip failed for push vector "${c.name}"`);
    pushPreviews.push({ name: c.name, messageId: c.messageId, sealed, plaintext: c.plaintext });
  }

  // Negative vectors — Swift MUST reject every one of these and fall back to the
  // content-free placeholder rather than showing a garbage preview.
  const base = vectors[0];
  const raw = unb64(base.sealed);

  const flip = (i: number) => {
    const u = new Uint8Array(raw);
    u[i] ^= 0x01;
    return b64(u);
  };

  const negatives = [
    { name: 'tampered_tag', messageId: base.messageId, sealed: flip(raw.length - 1) },
    { name: 'tampered_body', messageId: base.messageId, sealed: flip(13) },
    { name: 'tampered_nonce', messageId: base.messageId, sealed: flip(0) },
    { name: 'wrong_message_id', messageId: `${base.messageId}X`, sealed: base.sealed },
    { name: 'truncated_to_11', messageId: base.messageId, sealed: b64(raw.slice(0, 11)) },
    { name: 'truncated_to_12', messageId: base.messageId, sealed: b64(raw.slice(0, 12)) },
    { name: 'truncated_to_27', messageId: base.messageId, sealed: b64(raw.slice(0, 27)) },
    { name: 'empty_sealed', messageId: base.messageId, sealed: '' },
    { name: 'not_base64', messageId: base.messageId, sealed: '!!!not base64!!!' },
    { name: 'all_zero_28_bytes', messageId: base.messageId, sealed: b64(new Uint8Array(28)) },
  ];

  // Self-check: the TS opener must reject the negatives too, otherwise the vector
  // is testing the wrong thing.
  for (const n of negatives) {
    const got = await tak.openArchive(takBytes, n.messageId, n.sealed);
    if (got !== null) throw new Error(`negative vector "${n.name}" unexpectedly decrypted in TS`);
  }

  console.log(
    JSON.stringify(
      {
        _comment:
          'Known-answer vectors for the OpenStoa TAK archive layer, generated from openstoa/src/lib/mls/takClient.ts. DO NOT hand-edit — regenerate with openstoa/scripts/gen-archive-vectors.ts.',
        meta,
        takBase64: b64(takBytes),
        vectors,
        pushPreviews,
        negatives,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
