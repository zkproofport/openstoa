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
import {
  CHAT_MEDIA_BODY_PREFIX,
  MAX_CHAT_MEDIA_BYTES,
  buildChatMediaBody,
  chatMediaObjectKey,
  parseChatMediaBody,
  type ChatMediaEnvelope,
} from '../src/lib/chatMedia';

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

  /*
   * ATTACHMENT vectors (P-1).
   *
   * An attachment's push preview decrypts to an ENVELOPE, not to text, and the
   * iOS NSE has to parse it, fetch the object and open the bytes — a fourth
   * hand-written copy of rules that live in `src/lib/chatMedia.ts`. A Swift
   * constant that drifts from that file does not fail to compile, it just stops
   * matching, so these vectors are generated by the REAL parser and sealer and
   * the Swift port has to reproduce every one.
   *
   * The bytes are sealed under `media:<mediaId>` rather than a message id
   * (takClient `mediaContextId`), because an attachment is sealed before the
   * POST that mints a message id. A port that opens them with the message id
   * derives a different key and silently shows no picture, so `wrongContext`
   * below pins that too.
   */
  const MEDIA_TOPIC_ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
  const MEDIA_USER_ID = 'user-nullifier_ABC-123';
  const mediaCases: Array<{ name: string; mediaId: string; mime: string; bytes: Uint8Array }> = [
    // PNG magic + a little payload: the shape a real attachment starts with.
    {
      name: 'media_png',
      mediaId: 'a0b1c2d3e4f5061728394a5b6c7d8e9f',
      mime: 'image/png',
      bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3, 4, 5, 6, 7]),
    },
    // One byte — the smallest attachment the sender will accept (`size > 0`).
    { name: 'media_one_byte', mediaId: '00000000000000000000000000000001', mime: 'image/jpeg', bytes: new Uint8Array([0xff]) },
    // Every byte value, so a port that mangles high bytes (a UTF-8 decode on the
    // way through, say) fails here rather than on someone's lock screen.
    {
      name: 'media_all_byte_values',
      mediaId: 'ffffffffffffffffffffffffffffffff',
      mime: 'image/gif',
      bytes: new Uint8Array(Array.from({ length: 256 }, (_, i) => i)),
    },
    // Large enough to cross any chunking in a base64 helper.
    {
      name: 'media_200k',
      mediaId: '0123456789abcdef0123456789abcdef',
      mime: 'image/webp',
      bytes: new Uint8Array(200_000).map((_, i) => (i * 7) % 251),
    },
  ];

  const media = [];
  for (const c of mediaCases) {
    const sealed = await tak.sealMediaBytes(takBytes, c.mediaId, c.bytes);
    const back = await tak.openMediaBytes(takBytes, c.mediaId, sealed);
    if (!back || b64(back) !== b64(c.bytes)) throw new Error(`TS media round-trip failed for "${c.name}"`);
    // The sealed bytes must NOT open under the message-id context — that is the
    // mistake a port makes, and it must fail loudly here instead of quietly there.
    const wrongContext = await tak.openArchive(takBytes, c.mediaId, b64(sealed));
    if (wrongContext !== null) throw new Error(`media "${c.name}" opened under the wrong context in TS`);

    const envelope: ChatMediaEnvelope = {
      v: 1,
      key: chatMediaObjectKey(MEDIA_TOPIC_ID, MEDIA_USER_ID, c.mediaId),
      mediaId: c.mediaId,
      takVersion: 3,
      mime: c.mime,
      size: c.bytes.length,
    };
    const body = buildChatMediaBody(envelope);
    if (!parseChatMediaBody(body)) throw new Error(`TS refused its own body for "${c.name}"`);
    media.push({
      name: c.name,
      topicId: MEDIA_TOPIC_ID,
      body,
      envelope,
      sealed: b64(sealed),
      plaintextBase64: b64(c.bytes),
    });
  }

  /*
   * Bodies the parser must ACCEPT or REJECT, without needing any bytes.
   *
   * Each one is run through the real `parseChatMediaBody` below, so a fixture
   * cannot claim an outcome TypeScript does not actually produce — which is the
   * failure mode of a hand-written expectation table. The Swift port must agree
   * on every row, and on WHICH topic it agrees for: a body naming another
   * topic's object is rejected by the client, not merely by the server.
   */
  const otherTopic = '11111111-2222-3333-4444-555555555555';
  const goodMediaId = 'a0b1c2d3e4f5061728394a5b6c7d8e9f';
  const goodKey = chatMediaObjectKey(MEDIA_TOPIC_ID, MEDIA_USER_ID, goodMediaId);
  const envelopeBody = (over: Record<string, unknown>) =>
    CHAT_MEDIA_BODY_PREFIX +
    JSON.stringify({
      v: 1,
      key: goodKey,
      mediaId: goodMediaId,
      takVersion: 0,
      mime: 'image/png',
      size: 1024,
      ...over,
    });

  const mediaBodyCases: Array<{ name: string; topicId: string; body: string }> = [
    // --- accepted ---
    { name: 'ok_minimum_size', topicId: MEDIA_TOPIC_ID, body: envelopeBody({ size: 1 }) },
    { name: 'ok_maximum_size', topicId: MEDIA_TOPIC_ID, body: envelopeBody({ size: MAX_CHAT_MEDIA_BYTES }) },
    { name: 'ok_tak_version_zero', topicId: MEDIA_TOPIC_ID, body: envelopeBody({ takVersion: 0 }) },
    // --- boundaries ---
    { name: 'size_zero', topicId: MEDIA_TOPIC_ID, body: envelopeBody({ size: 0 }) },
    { name: 'size_negative', topicId: MEDIA_TOPIC_ID, body: envelopeBody({ size: -1 }) },
    { name: 'size_over_max', topicId: MEDIA_TOPIC_ID, body: envelopeBody({ size: MAX_CHAT_MEDIA_BYTES + 1 }) },
    { name: 'size_double_max', topicId: MEDIA_TOPIC_ID, body: envelopeBody({ size: MAX_CHAT_MEDIA_BYTES * 2 }) },
    { name: 'size_fractional', topicId: MEDIA_TOPIC_ID, body: envelopeBody({ size: 10.5 }) },
    { name: 'tak_version_negative', topicId: MEDIA_TOPIC_ID, body: envelopeBody({ takVersion: -1 }) },
    { name: 'tak_version_fractional', topicId: MEDIA_TOPIC_ID, body: envelopeBody({ takVersion: 1.5 }) },
    // Numbers as STRINGS: the TS parser requires `typeof === 'number'`, so a
    // port that is helpfully lenient would admit envelopes nobody else accepts.
    { name: 'size_as_string', topicId: MEDIA_TOPIC_ID, body: envelopeBody({ size: '1024' }) },
    { name: 'tak_version_as_string', topicId: MEDIA_TOPIC_ID, body: envelopeBody({ takVersion: '0' }) },
    { name: 'version_as_bool', topicId: MEDIA_TOPIC_ID, body: envelopeBody({ v: true }) },
    { name: 'version_two', topicId: MEDIA_TOPIC_ID, body: envelopeBody({ v: 2 }) },
    // --- hostile keys ---
    { name: 'key_traversal', topicId: MEDIA_TOPIC_ID, body: envelopeBody({ key: `topics/${MEDIA_TOPIC_ID}/chat/../../etc/${goodMediaId}.bin` }) },
    { name: 'key_absolute_url', topicId: MEDIA_TOPIC_ID, body: envelopeBody({ key: `https://evil.example/${goodMediaId}.bin` }) },
    { name: 'key_other_topic', topicId: MEDIA_TOPIC_ID, body: envelopeBody({ key: chatMediaObjectKey(otherTopic, MEDIA_USER_ID, goodMediaId) }) },
    { name: 'key_media_id_mismatch', topicId: MEDIA_TOPIC_ID, body: envelopeBody({ key: chatMediaObjectKey(MEDIA_TOPIC_ID, MEDIA_USER_ID, 'ffffffffffffffffffffffffffffffff') }) },
    { name: 'key_empty', topicId: MEDIA_TOPIC_ID, body: envelopeBody({ key: '' }) },
    { name: 'key_wrong_extension', topicId: MEDIA_TOPIC_ID, body: envelopeBody({ key: goodKey.replace(/\.bin$/, '.png') }) },
    // The same VALID body, asked about under a different topic. Nothing about
    // the body changed — only whose push it arrived in.
    { name: 'valid_body_wrong_topic', topicId: otherTopic, body: envelopeBody({}) },
    // --- media id / mime ---
    { name: 'media_id_uppercase', topicId: MEDIA_TOPIC_ID, body: envelopeBody({ mediaId: goodMediaId.toUpperCase() }) },
    { name: 'media_id_short', topicId: MEDIA_TOPIC_ID, body: envelopeBody({ mediaId: 'abc' }) },
    { name: 'mime_not_allowlisted', topicId: MEDIA_TOPIC_ID, body: envelopeBody({ mime: 'image/heic' }) },
    { name: 'mime_svg', topicId: MEDIA_TOPIC_ID, body: envelopeBody({ mime: 'image/svg+xml' }) },
    { name: 'mime_empty', topicId: MEDIA_TOPIC_ID, body: envelopeBody({ mime: '' }) },
    // --- shapes that are not an envelope at all ---
    { name: 'prefix_only', topicId: MEDIA_TOPIC_ID, body: CHAT_MEDIA_BODY_PREFIX },
    { name: 'prefix_plus_garbage', topicId: MEDIA_TOPIC_ID, body: `${CHAT_MEDIA_BODY_PREFIX}not json` },
    { name: 'prefix_plus_array', topicId: MEDIA_TOPIC_ID, body: `${CHAT_MEDIA_BODY_PREFIX}[]` },
    { name: 'prefix_plus_null', topicId: MEDIA_TOPIC_ID, body: `${CHAT_MEDIA_BODY_PREFIX}null` },
    { name: 'prefix_plus_string', topicId: MEDIA_TOPIC_ID, body: `${CHAT_MEDIA_BODY_PREFIX}"hello"` },
    { name: 'prefix_plus_empty_object', topicId: MEDIA_TOPIC_ID, body: `${CHAT_MEDIA_BODY_PREFIX}{}` },
    { name: 'truncated_json', topicId: MEDIA_TOPIC_ID, body: envelopeBody({}).slice(0, -3) },
    // --- lookalikes: text a member could type, which must stay TEXT ---
    { name: 'lookalike_v2', topicId: MEDIA_TOPIC_ID, body: `openstoa:media:v2:${JSON.stringify({ v: 1 })}` },
    { name: 'lookalike_no_colon', topicId: MEDIA_TOPIC_ID, body: `openstoa:media:v1${JSON.stringify({ v: 1 })}` },
    { name: 'lookalike_prefix_inside', topicId: MEDIA_TOPIC_ID, body: `look: ${CHAT_MEDIA_BODY_PREFIX}{"v":1}` },
    { name: 'lookalike_bare_json', topicId: MEDIA_TOPIC_ID, body: JSON.stringify({ v: 1, key: goodKey, mediaId: goodMediaId, takVersion: 0, mime: 'image/png', size: 1 }) },
    { name: 'plain_text', topicId: MEDIA_TOPIC_ID, body: 'Alice: meeting at 3' },
    { name: 'empty_body', topicId: MEDIA_TOPIC_ID, body: '' },
  ];

  const mediaBodies = mediaBodyCases.map((c) => {
    const parsed = parseChatMediaBody(c.body);
    // The topic check lives in `isChatMediaKeyForTopic`; the Swift port folds
    // both into one `parse(body:topicId:)`, so the expectation must too.
    const valid = parsed !== null && parsed.key === chatMediaObjectKey(c.topicId, MEDIA_USER_ID, parsed.mediaId);
    return {
      name: c.name,
      topicId: c.topicId,
      body: c.body,
      // Whether the body is an ATTACHMENT at all (`isChatMediaBody`) — the check
      // that decides a body may never be shown as text — is separate from
      // whether it PARSES. A malformed envelope is still not text.
      isMediaBody: c.body.startsWith(CHAT_MEDIA_BODY_PREFIX),
      valid,
      envelope: valid ? parsed : null,
    };
  });

  console.log(
    JSON.stringify(
      {
        _comment:
          'Known-answer vectors for the OpenStoa TAK archive layer, generated from openstoa/src/lib/mls/takClient.ts. DO NOT hand-edit — regenerate with openstoa/scripts/gen-archive-vectors.ts.',
        meta: {
          ...meta,
          // Restated in Swift (`ChatMedia`) and Kotlin; recorded here so a change
          // in chatMedia.ts surfaces as a failing vector run, not as a preview
          // that silently stops matching.
          mediaBodyPrefix: CHAT_MEDIA_BODY_PREFIX,
          maxChatMediaBytes: MAX_CHAT_MEDIA_BYTES,
          mediaUserSegment: MEDIA_USER_ID,
        },
        takBase64: b64(takBytes),
        vectors,
        pushPreviews,
        negatives,
        media,
        mediaBodies,
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
