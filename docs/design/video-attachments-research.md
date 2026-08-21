# E2EE Video Attachments — Research Findings

Date: 2026-08-21. Status: COMPLETE.

Evidence labels used throughout:
- **[PRIMARY]** = vendor docs, spec text, or the app's own source code
- **[THIRD-PARTY]** = independent analysis / blog / benchmark
- **[INFERENCE]** = my reasoning, not directly sourced
- **[NOT VERIFIED]** = could not confirm with a source

---

## 1. Size limits

### Signal — 100 MiB default, remote-configurable **[PRIMARY, source code]**

From `Signal-Android/app/src/main/java/org/thoughtcrime/securesms/util/RemoteConfig.kt` (main branch, read 2026-08-21):

```kotlin
/** Maximum attachment ciphertext size when sending in bytes  */
val maxAttachmentSizeBytes: Long by remoteLong(
  key = "global.attachments.maxBytes",
  defaultValue = 100.mebiBytes.inWholeBytes,
  hotSwappable = true
)

/** Maximum size a video transcode should target in bytes  */
val videoTranscodeTargetSizeBytes: Long by remoteLong(
  key = "global.videoAttachments.transcodeTargetBytes",
  defaultValue = 100.mebiBytes.inWholeBytes, hotSwappable = true)

/** Maximum input size when opening a video to send in bytes  */
val maxSourceTranscodeVideoSizeBytes: Long by remoteLong(
  key = "android.media.sourceTranscodeVideo.maxBytes",
  defaultValue = 1.gibiBytes.inWholeBytes, hotSwappable = true)
```
https://github.com/signalapp/Signal-Android/blob/main/app/src/main/java/org/thoughtcrime/securesms/util/RemoteConfig.kt

Key details worth copying:
- The cap is on **ciphertext**, not plaintext. `AttachmentUploadJob.getMaxPlaintextSize()` =
  `AttachmentCipherStreamUtil.getMaxPlaintextSizeForCiphertext(RemoteConfig.maxAttachmentSizeBytes)` — i.e. they
  compute backwards from the wire limit through the padding/MAC overhead. Very relevant to us: our 10 MB
  Next.js limit is also a *ciphertext/transport* limit and should be treated the same way.
- **Receive limit is 1.25x the send limit** (`maxAttachmentReceiveSizeBytes` = `max(sendLimit, remote ?: sendLimit*1.25)`) —
  deliberate slack so a server-side bump doesn't break older clients.
- The default is **hot-swappable server-side config**, not a compiled constant. This is why third-party articles
  disagree (100 MB vs 200 MB): the number is whatever Signal's remote config currently serves.
- Third-party claim that Signal raised the limit 100 MB -> 200 MB: https://aboutsignal.com/news/signal-increases-attachment-size-limit-from-100-mb-to-200-mb/ **[THIRD-PARTY, not confirmed against a Signal announcement]**. The source default in the repo is still 100 MiB, consistent with the raise being a remote-config change.

### WhatsApp — ~16 MB inline media / 2 GB as document **[THIRD-PARTY only]**
I could not retrieve faq.whatsapp.com directly (WebSearch budget exhausted before I got a primary fetch).
Multiple independent sources agree on 16 MB inline video and 2 GB document:
- https://filesize.org/limits/whatsapp/
- https://www.usecarly.com/blog/whatsapp-file-size-limit/
- https://vid-crush.com/blog/whatsapp-video-size-limit/
**Mark as [THIRD-PARTY / NOT VERIFIED against vendor docs].** The important structural fact — and it is corroborated
by Signal's source above — is the **two-tier design: a small "inline media" tier that is transcoded, and a large
"document" tier that is byte-for-byte.**

### Telegram — 2 GB free / 4 GB Premium, **but cloud chats are NOT E2EE** **[PRIMARY-ish]**
- https://telegram.org/faq_premium (Premium FAQ, 4 GB uploads)
- https://core.telegram.org/api/files (upload API)
Critical caveat: Telegram's default cloud chats are **client-server encrypted, not end-to-end**. Only Secret Chats
are E2EE, and Secret Chats are 1:1, device-local, and mobile-only. **So Telegram's 2-4 GB number is not an E2EE
data point** and should not be used as a benchmark for us.

### Matrix / Element — no protocol limit; per-homeserver `max_upload_size` **[PRIMARY]**
The Matrix spec puts no cap on attachment size; the media repo advertises a server-configured limit
(`/_matrix/client/v1/media/config` -> `m.upload.size`). Synapse's default `max_upload_size` is 50M
(and matrix.org runs higher). Element clients enforce whatever the server says.
Spec: https://spec.matrix.org/latest/client-server-api/
**[NOT VERIFIED]** exact current Synapse default value — I did not fetch the Synapse config docs.

### Summary table
| App | Inline video cap | Escape hatch | E2EE? | Evidence |
|---|---|---|---|---|
| Signal | 100 MiB ciphertext (remote config, receive 1.25x) | none — same cap for all attachments | yes | PRIMARY (source) |
| WhatsApp | ~16 MB | "send as document", 2 GB | yes | THIRD-PARTY |
| Telegram | 2 GB / 4 GB Premium | n/a | **only Secret Chats** | vendor FAQ |
| Matrix | server `max_upload_size` | none | yes | PRIMARY (spec) |

**Takeaway for us: nobody's E2EE inline-video tier is anywhere near 7 MB. The closest is WhatsApp at 16 MB, and
WhatsApp gets there by aggressive on-device transcoding.**

---

## 2. Compression / transcoding

**Confirmed: transcoding is 100% on-device, and this is forced by E2EE.** Server-side transcoding is
cryptographically impossible when the server never sees plaintext — every one of these apps resolves it the same
way: the sending client transcodes before encrypting.

### Signal's actual transcode targets **[PRIMARY, source code]**
`Signal-Android/lib/video/.../videoconverter/utils/VideoConstants.kt`:
```kotlin
const val VIDEO_SHORT_EDGE_HD = 720
const val VIDEO_LONG_EDGE_HD = 1280
const val AUDIO_MIME_TYPE = MediaFormat.MIMETYPE_AUDIO_AAC
const val RECORDED_VIDEO_CONTENT_TYPE = "video/mp4"

val DEFAULT_LVL1_STANDARD      = QualityTier(resolution = 480, videoBitrateMbps = 1.0f, audioBitrateKbps = 128, maxDurationSec = 900)
val DEFAULT_LVL2_SHORT_STANDARD= QualityTier(resolution = 720, videoBitrateMbps = 2.0f, audioBitrateKbps = 128, maxDurationSec = 600)
val DEFAULT_LVL2_LONG_STANDARD = QualityTier(resolution = 720, videoBitrateMbps = 1.5f, audioBitrateKbps = 128, maxDurationSec = 900)
val DEFAULT_HIGH               = QualityTier(resolution = 720, videoBitrateMbps = 4.0f, audioBitrateKbps = 128, maxDurationSec = 360)
```
https://github.com/signalapp/Signal-Android/blob/main/lib/video/src/main/java/org/thoughtcrime/securesms/video/videoconverter/utils/VideoConstants.kt

So Signal's **baseline standard tier is 480p @ 1.0 Mbps video + 128 kbps AAC, capped at 15 minutes**; a
locale-dependent tier-2 (country codes incl. 82 = Korea, 1 = US, 81 = Japan, 49 = Germany...) gets 720p @ 1.5-2.0 Mbps.
"High quality" is 720p @ 4 Mbps but capped at 6 minutes.

Note the **duration cap** mechanism — `calculateMaxVideoUploadDurationInSeconds` truncates videos that would not
fit. That is the real trick: *bitrate x duration <= size cap*, so they cap duration rather than degrading quality
without bound.

Signal Android uses Android's `MediaCodec` (hardware encoder) via its own `videoconverter` module. Also note the
input guard: `maxSourceTranscodeVideoSizeBytes` default **1 GiB** — you can pick a 1 GB source video, and it gets
transcoded down to fit the 100 MiB attachment cap.

Known failure mode **[THIRD-PARTY]**: Signal-Android issue #13511 reports the transcoder *inflating* an already-tiny
12 MB / 167 kbps 640x360 video to ~90 MB, because it re-encodes to the tier bitrate regardless of source bitrate.
https://github.com/signalapp/Signal-Android/issues/13511 (labelled wontfix). Lesson for us: **skip transcode when
the source is already below target bitrate and within the cap.**

### WhatsApp **[THIRD-PARTY]**
Re-encodes on-device before sending: down-scales (commonly reported ~960 px long edge), lowers bitrate to roughly
1000-1500 kbps, strips metadata, own H.264 profile. Sources: https://www.usecarly.com/blog/whatsapp-file-size-limit/ ,
https://pixpipe.app/en/blog/whatsapp-video-size-limit/ . Numbers **[NOT VERIFIED]** against WhatsApp docs.

### Matrix/Element
No transcoding mandated by spec; Element clients historically upload as-is (which is why Element is widely
described as poor for video). MSC4016 explicitly calls out that senders still must decompress enough of the file
to thumbnail/blurhash it. **[PRIMARY: MSC4016 text, see §3]**

### Server-side transcoding under E2EE — how they "square it"
They don't. There is no squaring. The consistent industry answer is:
1. transcode on-device before encryption, and
2. also generate the **thumbnail/blurhash on-device** and ship it as a separate small encrypted attachment
   (Matrix's `EncryptedFile` appears twice in an `m.video`: once for `file`, once for `thumbnail_file`).
Everything the server would normally do (thumbnail, preview, adaptive bitrate ladder) has to move to the sender.

---

## 3. Chunked encryption + streaming playback

### The core crypto problem, stated precisely
AES-GCM computes one GHASH-based tag over the *entire* ciphertext. You cannot verify a prefix. Therefore
"decrypt-as-you-download and play immediately" with single-shot GCM means **playing unauthenticated plaintext** —
you only learn the blob was tampered with after the last byte. That is exactly the "release unverified plaintext"
antipattern.

There are three real-world answers:

#### (a) Matrix today: AES-CTR + whole-file SHA-256 **[PRIMARY, spec]**
Matrix spec, "Sending encrypted attachments":
- single-use **256-bit AES key**, **AES-CTR** with a 128-bit counter block = random 64-bit IV || 64-bit counter starting at 0
- "Clients MUST generate both the AES key and IV using a cryptographically secure random source"
- "A hash of the ciphertext MUST also be included, in order to prevent the homeserver from changing the file
  content. Clients MUST verify the hash before using the file contents."
- `EncryptedFile` = `{ url, key (JWK), iv, hashes: {sha256}, v }`
https://spec.matrix.org/latest/client-server-api/#sending-encrypted-attachments

Why CTR: **seekable**. You can decrypt any byte range by jumping the counter. MSC4016 says the only reason Matrix
used CTR rather than GCM is that "native AES-GCM primitives weren't widespread enough on Android back in 2016".
BUT the integrity check is a hash over the *whole* ciphertext, so a spec-compliant client still cannot start
playback early — MSC4016's own text acknowledges the current API only lets you "incrementally decrypt it without
loading the whole thing into RAM ... and then either surfacing or deleting the decrypted result at the end if the
hash matches."

Known weakness **[THIRD-PARTY]**: the Matrix crypto review found the AES-CTR attachment scheme is not IND-CCA2
because the IV is not covered by the hash. https://nebuchadnezzar-megolm.github.io/

#### (b) Matrix's proposed answer: MSC4016 — chunked AES-GCM with per-block tags **[PRIMARY, MSC text]**
https://github.com/matrix-org/matrix-spec-proposals/pull/4016 (branch `matthew/msc4016`, file
`proposals/4016-streaming-e2ee-file-transfer.md`; **open since 2023-05-14, last touched 2026-02-23, NOT merged**).

Format (verbatim from the MSC):
- File header magic `0x4D 0x58 0x43 0x03` ("MXC" 0x03)
- then 1..N blocks, each with a header of:
  - 32-bit registration code `0xFFFFFFFF` (lets a parser find block boundaries when seeking randomly)
  - 32-bit **block sequence number** (starting at 0)
  - 32-bit encrypted-data length
  - 32-bit **CRC32** of the block incl. headers — "used when randomly seeking as a consistency check ... It is not
    used for cryptographic integrity"
  - the AES-256-GCM bitstream for that block
- Block IV = block sequence number **concatenated with** the file-level 96-bit IV (128-bit, hashed down to 96 inside GCM)
- "The block is encrypted including the 32-bit block sequence number as **Additional Authenticated Data**, thus
  stopping encrypted blocks from impersonating each other."
- "Receivers MUST terminate a stream if the seqnum does not sequentially increase (to prevent the server from
  shuffling the blocks)"; "Implementations MUST terminate a stream if the seqnum is exhausted, to prevent IV reuse."
- Default block size **32 KB**; smaller (e.g. 1 KB) for audio to cut latency; CBR recommended so block sizes don't
  leak waveform metadata.
- `hashes` is **removed** from `EncryptedFile` v3, because GCM provides its own integrity.
- Transport: streaming HTTP PUT (HTTP/2) and/or **tus** resumable upload; **HTTP Range** headers for seeking/resume.
- New `"v": "org.matrix.msc4016.v3"`, `"alg": "A256GCM"`.

Overhead: "~32 bytes per block" (16 B header + 16 B GCM tag). At 32 KB blocks that's ~0.1%.

**Security-review status — the part you must not skip:**
- The MSC itself flags: "AES-GCM is not key-committing, so removing hashes on the event means ... an adversary
  which constructs a ciphertext C with multiple ((IV1,K1),(IV2,K2),...) so that C decrypts to P1, P2 ... we
  introduce this attack."
- "Removing the `hashes` entry ... means that an attacker who controls the key & IV of the original file transfer
  could strategically substitute the file contents ... a malicious server could serve different file contents to
  other users or servers to evade moderation."
- The MSC's own open question: "XXX: is there still a vulnerability here? Other approaches use **Merkle trees** to
  hash the AEADs rather than simple sequence numbers, but why?"
- "When doing random access, the reader has to trust the server to serve the right blocks after a discontinuity."
- Per the PR discussion, reviewers pushed back and recommended a standard construction (**STREAM** / **FLOE**)
  instead of bespoke framing; the proposal is effectively **stalled pending security rework**.
  Test jig: https://github.com/matrix-org/streaming-files-test

#### (c) Signal's answer: AES-CBC + HMAC with an **incremental (chunked) MAC** **[PRIMARY, source code]**
Signal did not go to chunked GCM. It kept encrypt-then-MAC and made the MAC *incremental* so a receiver can
validate a prefix. `libsignal/rust/protocol/src/incremental_mac.rs`:

```rust
const MINIMUM_CHUNK_SIZE: usize = 64 * 1024;      // 64 KiB
const MAXIMUM_CHUNK_SIZE: usize = 2 * 1024 * 1024; // 2 MiB
const TARGET_TOTAL_DIGEST_SIZE: usize = 8 * 1024;  // 8 KiB of MACs total

pub const fn calculate_chunk_size<D>(data_size: usize) -> usize {
    let target_chunk_count = TARGET_TOTAL_DIGEST_SIZE / D::OutputSize::USIZE; // 8192/32 = 256 chunks
    if data_size < target_chunk_count * MINIMUM_CHUNK_SIZE { return MINIMUM_CHUNK_SIZE; }
    if data_size < target_chunk_count * MAXIMUM_CHUNK_SIZE { return data_size.div_ceil(target_chunk_count); }
    MAXIMUM_CHUNK_SIZE
}
```
https://github.com/signalapp/libsignal/blob/main/rust/protocol/src/incremental_mac.rs

Design notes worth stealing:
- **Chunk size is derived from file size to hold the total digest list at ~8 KiB (256 x SHA-256).** Small files
  get 64 KiB chunks; large files scale chunk size up to 2 MiB. The *digest list is a fixed budget*, not the chunk size.
- The MAC is **rolling/cumulative**: each chunk's MAC is the HMAC state after all bytes so far, so validating chunk
  N transitively authenticates chunks 0..N. This gives prefix authentication (streaming) **and** ordering/truncation
  resistance for free, without a Merkle tree and without per-chunk key/IV management.
- Cost: it is **strictly sequential** — great for progressive download, useless for random seek into the middle.
  Signal accepts that; they stream forward, they don't seek into unverified regions.
- Bridged to all platforms: `node/ts/incremental_mac.ts`, `swift/Sources/LibSignalClient/IncrementalMac.swift`,
  `rust/bridge/shared/src/incremental_mac.rs`.
- Third-party walkthrough of Signal's attachment crypto incl. incremental MAC:
  https://soatok.blog/signal-crypto-review-2025-part-4/ (I could not fetch it — 403 — so treat the analysis as
  **[NOT VERIFIED]**; the source-code facts above are primary and stand on their own.)

#### (d) The standards-track option: STREAM / Tink's AES-GCM-HKDF-STREAMING **[PRIMARY, Google docs]**
https://developers.google.com/tink/streaming-aead/aes_gcm_hkdf_streaming
- File is split into segments of `CiphertextSegmentSize`; requires `CiphertextSegmentSize > DerivedKeySize + 24`.
- First segment holds `CiphertextSegmentSize - len(Header) - 16` bytes; later segments `CiphertextSegmentSize - 16`.
- Per-segment IV = `NoncePrefix || i || b`, where `i` is the **4-byte big-endian segment index** and `b` is a
  **final-segment flag: `0x00` if i < n-1, `0x01` otherwise**.
- The final-segment flag is what gives **truncation resistance** — an attacker cannot chop the tail because the
  last segment is cryptographically marked as last.
- Explicitly supports "random access, or access to the beginning of a file without inspecting the end of the file."
- Caveat from the docs: "APIs should be careful to not allow users to confuse end-of-file and decryption errors."

**This is the construction I would actually recommend** (see §6): it is the same shape as MSC4016 but it is a
published, reviewed design (Hoang-Reyzin-Shen-Rogaway STREAM) with the truncation flag MSC4016 lacks, and it is
what Matrix's own reviewers told MSC4016 to adopt.

#### Comparison of the three integrity strategies
| Strategy | Prefix-verifiable? | Random seek? | Truncation-resistant? | Key-commitment issue? |
|---|---|---|---|---|
| Single-shot GCM (**what we do today**) | no | no | yes (whole tag) | yes (GCM not key-committing) |
| Matrix v2: CTR + whole-file SHA-256 | no | yes (but unverified) | yes | n/a (hash commits) |
| Signal incremental HMAC (CBC+HMAC) | **yes** | no (sequential only) | yes (cumulative) | n/a |
| MSC4016 chunked GCM + seqnum AAD | yes | **yes** | **no** (no last-flag) | yes (hashes removed) |
| STREAM / Tink AES-GCM-HKDF | **yes** | **yes** | **yes** (final-segment flag) | GCM caveat remains |

---

## 4. React Native specifically — playing an ENCRYPTED video

### What `react-native-video` actually accepts as a source **[PRIMARY, docs + repo]**
The source is **always a URI**. There is no in-memory / ArrayBuffer / callback data source in the public JS API:
```ts
new VideoPlayer('https://example.com/video.mp4');
new VideoPlayer({ uri: 'https://example.com/video.mp4' });
new VideoPlayer({ source: { uri: '...' }, /* ... */ });
```
https://github.com/TheWidlarzGroup/react-native-video/blob/master/docs/docs/player/video-player.md

Accepted schemes in practice: `http(s)://`, `file://`, bundled assets, `content://` (Android). **No `data:`-of-any-useful-size, no Blob, no JS callback.**

Version state (npm, checked 2026-08-21): `react-native-video` latest stable **6.19.2 (2026-04-28)**; v7 line in beta, **7.0.0-beta.11 (2026-08-12)**.

### Answer to "is download-decrypt-write-play file:// the only viable approach?"
**On iOS today with the public API: effectively yes.** On Android there is now a real second option. Details:

#### Option A — decrypt whole file to disk, play `file://` (works everywhere)
- Simple, works on both platforms, works with v6 stable.
- Costs: full download before first frame; plaintext lands on disk (must go in an app-private, no-backup dir and be
  wiped); RAM/disk pressure; decrypt latency (see §5 — with native crypto this becomes negligible).
- This is what the overwhelming majority of RN apps do. Community write-ups all land here:
  https://dev.to/garudashish/encrypt-and-decrypt-video-file-in-react-native-5hk7 **[THIRD-PARTY]**

#### Option B — local HTTP server on `127.0.0.1`, stream-decrypt per Range request
- Run an embedded HTTP server in-app, point the player at `http://127.0.0.1:<port>/x.mp4`, and decrypt on the fly
  in the server handler, honouring `Range:` requests. This is the classic trick and it is the only way to get
  **streaming decryption on iOS without touching native code**.
- Requires a seekable cipher mode (AES-CTR, or chunked GCM/STREAM with block-aligned ranges). **Single-shot GCM
  cannot do this.**
- Library: `@dr.pogodin/react-native-static-server` — **actively maintained, 0.28.0 published 2026-08-13**. The old
  `react-native-http-bridge` is dead (0.6.1, 2018-11-05).
- **[NOT VERIFIED]**: whether `@dr.pogodin/react-native-static-server` supports a *dynamic/handler* route rather
  than serving a static directory. Its documented model is serving a filesystem folder, which would not by itself
  give you on-the-fly decryption. Needs a spike before committing. **[INFERENCE]** you may need a small native
  server or a fork.
- Security note: a localhost server is reachable by other apps on the device unless you bind loopback + require a
  per-session random path/token.

#### Option C — react-native-video v7 plugin API: custom ExoPlayer `DataSource` (**Android only**)
v7 exposes a native plugin interface with, among others:
```kotlin
fun getMediaDataSourceFactory(source: NativeVideoPlayerSource,
                              mediaDataSourceFactory: DataSource.Factory): DataSource.Factory?
fun getMediaSourceFactory(...): MediaSource.Factory?
fun overrideSource(source: NativeVideoPlayerSource): NativeVideoPlayerSource
fun getDRMManager(source: NativeVideoPlayerSource): Any?
```
https://github.com/TheWidlarzGroup/react-native-video/blob/master/docs/docs/plugins/interface.md

`getMediaDataSourceFactory` is exactly the hook needed for a decrypting `DataSource` wrapper — true streaming
decryption inside ExoPlayer, no temp plaintext file. **But the same doc's platform matrix says:**
| Feature | Android | iOS |
|---|---|---|
| Media Factories | Full ExoPlayer support | **Limited AVFoundation** |
| Cache Control | Yes | No |

i.e. **there is no iOS equivalent of `getMediaDataSourceFactory`.** iOS plugins get `overrideSource` and
`getDRMManager` only.

#### Option D — HLS with AES-128 segment encryption (**the most underrated option**)
Both native players decrypt HLS AES-128 themselves, so you get streaming + seeking for free:
- **Android/ExoPlayer(media3)**: `androidx/media3/exoplayer/hls/Aes128DataSource.java` — "If the segment is fully
  encrypted, returns an `Aes128DataSource` that wraps the original" (`HlsMediaChunk.java`). Playlist parser handles
  `#EXT-X-KEY:METHOD=AES-128,URI="..."`.
  https://github.com/androidx/media/blob/release/libraries/exoplayer_hls/src/main/java/androidx/media3/exoplayer/hls/Aes128DataSource.java
- **iOS/AVPlayer**: HLS AES-128 is native; the key URI can be served from a custom scheme handled by
  `AVAssetResourceLoaderDelegate`. **[NOT VERIFIED — I could not retrieve Apple's doc body; treat the
  custom-scheme key delivery detail as unconfirmed.]** react-native-video does use
  `AVAssetResourceLoader` internally (`ios/core/HLSSubtitleInjector.swift`) but does **not** expose it to JS.
- Caveat: AES-128 HLS is **not authenticated** (CBC, no MAC). You would need to authenticate the playlist +
  segment digests out of band (e.g. ship a signed manifest of per-segment SHA-256 in the E2EE message payload) or
  you have re-created Matrix's IND-CCA2 gap. **[INFERENCE]**
- Caveat 2: producing HLS on-device means segmenting/packaging on-device. Non-trivial on RN.

#### Option E — DRM (Widevine / FairPlay). **Not applicable.**
`@react-native-video/drm` exists and is the only officially-blessed "encrypted video" path
(https://github.com/TheWidlarzGroup/react-native-video/blob/master/docs/docs/player/drm.md), but DRM requires a
**license server that holds the keys** — the exact opposite of E2EE. Ignore it.

### Are there libraries that already do encrypted streaming playback in RN?
**No maintained one found.** The recurring GitHub ask (react-native-video #2223, "Pass the decryption key to the
video directly") was **closed as stale with no maintainer solution**:
https://github.com/react-native-video/react-native-video/issues/2223

### Bottom line for §4
- **iOS**: download -> decrypt -> `file://` is the only no-native-code option. Streaming needs either a localhost
  server (Option B) or your own `AVAssetResourceLoaderDelegate` native module (Option C-equivalent, must be written).
- **Android**: v7's `getMediaDataSourceFactory` gives you real streaming decryption if you write a small Kotlin plugin.
- **Both**: HLS+AES-128 is the only path where the *players themselves* do the streaming decryption, at the cost of
  on-device packaging and a separate integrity story.

---

## 5. Native crypto for React Native (matters independently of video)

Your 3.5 s / 6 MB figure = **~0.58 s/MB**. That is right in line with published `@noble` numbers, so it is not a
Hermes pathology — it is what pure-JS AES-GCM costs.

### react-native-quick-crypto — **the recommendation** **[PRIMARY]**
- AES-GCM: **yes**, first class. `CipherGCMType = 'aes-128-gcm' | 'aes-192-gcm' | 'aes-256-gcm'`
  (`packages/react-native-quick-crypto/src/utils/types.ts`); documented in `docs/content/docs/api/cipher.mdx`
  (`aes-256-gcm` | 32-byte key | 12-byte IV | GCM | AEAD: Yes). Node-compatible
  `createCipheriv`/`createDecipheriv` + `getAuthTag`/`setAuthTag`.
- Maintenance: **latest 1.1.7 published 2026-08-15** (npm registry). Releases 1.1.3→1.1.7 across 2026-05..2026-08.
  Actively maintained by Margelo.
- Architecture: **v1.x = Nitro Modules, New Architecture / bridgeless only, min RN 0.75.** v0.x supported old arch.
- **Published AES-GCM benchmark** (iPhone 15 Pro, iOS 17),
  https://github.com/margelo/react-native-quick-crypto/blob/main/docs/content/docs/introduction/comparison.mdx :

  | Operation | RNQC | JS | Speedup |
  |---|---|---|---|
  | AES-256-GCM (1 MB) | **177 ops/s** | 1.32 ops/s (**@noble**) | **134x** |
  | AES-256-GCM (1 MB) | 177 ops/s | 0.18 ops/s (browserify) | 962x |
  | XSalsa20 (64 KB) | 852 ops/s | 7.39 ops/s | 115x |
  | PBKDF2 (sync) | 76,601 ops/s | 1,459 ops/s (@noble) | 52x |

  **177 ops/s at 1 MB = ~5.6 ms/MB.** Your 6 MB case goes 3.5 s -> **~34 ms**. A 100 MB video would decrypt in
  ~0.6 s. **Crypto stops being the bottleneck entirely.**
- Independent corroboration **[THIRD-PARTY]**, Joplin forum measurements (Android API 27 / iOS 16.5.1):
  AES-GCM 1.28 MB plaintext — iOS ~34-35 MB/s quick vs ~86-91 KB/s sjcl; Android ~126 MB/s vs ~23 KB/s.
  20x-5000x depending on size. https://discourse.joplinapp.org/t/performance-test-of-react-native-quick-crypto/38622
- **Critical caveat from that same thread**: after switching to native crypto, **base64 encode/decode becomes the
  bottleneck** ("less than 2X improvement with native libraries ... limiting overall throughput to a few megabytes
  per second or even slower"). **This directly indicts our base64-in-JSON transport.** Fixing crypto without fixing
  base64 will move the 3.5 s into the base64 step.
- Security posture: the repo has an ongoing security-audit plan incl. AEAD misuse tests (setAAD-after-update must
  throw, `decipher.final()` without `setAuthTag` must throw) — `plans/done/security-audit.md`, dated 2026-04-27.
  Good sign.

### expo-crypto — viable if you are in the Expo ecosystem **[PRIMARY, docs]**
https://docs.expo.dev/versions/latest/sdk/crypto/
- **AES-GCM: yes**, via `aesEncryptAsync()` / `aesDecryptAsync()`. Keys 128/192/256 (192 unsupported on Web).
  IV defaults to 12 bytes, configurable. Tag defaults to 16 bytes, configurable on Android/Web; **Apple is always
  16 bytes** (CryptoKit `AES.GCM`).
- Platforms: Android, iOS, tvOS, Web.
- Maintenance: `expo-crypto` **57.0.1 published 2026-07-15**; 58.x canaries as of 2026-08. Actively maintained.
- Async-only for AES; no Node `crypto` compatibility surface, no streaming/`update()` API — you hand it the whole
  buffer. **That makes chunked/streaming designs more awkward than with RNQC.**
- **[NOT VERIFIED]** which Expo SDK first shipped `aesEncryptAsync`; the AES PR is expo/expo#41249.
  No published throughput benchmarks found.

### Others (for completeness)
| Library | AES-GCM? | Latest release | Verdict |
|---|---|---|---|
| `react-native-quick-crypto` | yes (full Node API) | **1.1.7, 2026-08-15** | **use this** |
| `expo-crypto` | yes (`aesEncryptAsync`) | 57.0.1, 2026-07-15 | fine if Expo, no streaming API |
| `react-native-aes-gcm-crypto` (craftzdog) | yes, incl. file encrypt/decrypt | **0.2.2, 2022-07-20** | **abandoned** (4 yr) |
| `react-native-simple-crypto` | AES-CBC only **[NOT VERIFIED]** | 0.3.0, 2026-02-21 | not GCM |
| `react-native-fast-crypto` | no AES **[NOT VERIFIED]** | 3.0.0, 2025-10-27 | scrypt/secp focus |
| `react-native-nitro-modules` | n/a (runtime, not crypto) | 0.37.0, 2026-08-20 | RNQC v1 depends on it |

**Recommendation for §5, independent of video: adopt `react-native-quick-crypto` v1.x for all attachment
crypto now.** It requires New Architecture (RN >= 0.75) — verify `proofport-app`'s RN version and newArch flag
before committing. Keep `@noble/ciphers` as the web-client implementation (the browser has WebCrypto; use
`crypto.subtle.encrypt('AES-GCM')` there — hardware-accelerated and already available, no dependency).

**Side note we should act on regardless**: the Next.js web client should be using `crypto.subtle` (WebCrypto
AES-GCM), not `@noble/ciphers`, for the same 100x reason. **[INFERENCE — I did not read our web client code.]**

---

## 6. Recommendation for our architecture

### The arithmetic first
Signal's *standard* tier is 480p @ 1.0 Mbps video + 128 kbps AAC ~= **1.13 Mbps ~= 141 KB/s**.

| Plaintext budget | Duration at Signal-standard 480p | at 720p/1.5 Mbps |
|---|---|---|
| **7 MB (today)** | ~50 s | ~34 s |
| 10 MB (same cap, binary upload, no base64) | ~66 s | ~45 s |
| 50 MB | ~5.5 min | ~3.7 min |
| 100 MB (Signal's default) | ~11 min | ~7.5 min |

So **7 MB is not literally pointless — it is roughly a 40-50 second 480p clip.** But it is below every competitor's
inline tier, and it is a cap imposed by an accident of our transport (Next.js middleware + base64), not by a product
decision. Whether "50 seconds of 480p" is a product is your call; my read is that it is enough for a
"video message" feature and not enough for "share a video".

### Minimum viable video support (do these, in order)

**Step 0 — kill base64. This is the single highest-leverage change and it is not about video.**
Base64 costs 33% payload *and* is now the measured bottleneck once crypto goes native (Joplin thread, above).
Move attachment upload/download to `application/octet-stream` (or multipart) with the ciphertext as raw bytes and
the E2EE metadata in headers or a separate JSON part. On the same 10 MB middleware cap this alone buys +33%
plaintext. Note Next.js middleware body limits apply to the *middleware*; moving uploads to a Route Handler with
a streaming request body (or to a direct-to-storage presigned PUT) removes the cap altogether.
**[INFERENCE — verify the exact Next.js version's middleware/body-size behaviour in our repo before planning around it.]**

**Step 1 — swap in `react-native-quick-crypto` on mobile and `crypto.subtle` on web.** 6 MB decrypt goes
3.5 s -> ~34 ms. Do this even if video never ships; it fixes images too.

**Step 2 — on-device transcode before encrypt, with a duration cap.** Copy Signal's shape exactly:
- target 480p / 1.0 Mbps / AAC 128 kbps as the standard tier (optionally 720p/1.5 for good networks)
- **cap duration to fit the byte budget** rather than degrading quality arbitrarily
- **skip transcode when the source is already under target bitrate AND under the cap** (this is Signal's
  #13511 bug — don't inherit it)
- always generate and send a **separate small encrypted thumbnail/poster + blurhash**, because the server can
  never make one.
RN options: `react-native-compressor` or a `MediaCodec`/`AVAssetExportSession` wrapper. **[NOT VERIFIED — I did not
evaluate RN transcoding libraries in this pass; that is the obvious next research task.]**

**Step 3 — chunked upload, and chunked/streaming crypto.**
Multipart or resumable upload is **required** for anything past the current cap; there is no way around it. Once
you are chunking the transport anyway, chunk the crypto to match. **Use Tink's AES-GCM-HKDF-STREAMING (STREAM), not
a bespoke format**:
- per-segment nonce = `NoncePrefix || segmentIndex(4B BE) || finalFlag(1B: 0x00 / 0x01)`
- the final-segment flag gives truncation resistance, which is precisely what MSC4016 lacks and what got it
  blocked in security review
- segment size 256 KB - 1 MB for video (32 KB is MSC4016's default but that is tuned for low-latency audio)
- gives you: prefix authentication (start playing early, honestly), random access (seeking), and bounded RAM
https://developers.google.com/tink/streaming-aead/aes_gcm_hkdf_streaming

If you want the *simplest* thing that is still honest and you don't need seeking, **Signal's incremental-MAC shape
is easier to get right**: AES-CTR (or CBC) + a rolling HMAC emitted every N bytes, N chosen so the digest list stays
~8 KiB. Sequential-only, but sequential is all progressive playback needs.

**Do NOT ship: single-shot AES-GCM + "decrypt as it arrives and play".** That is releasing unverified plaintext.
Either verify the whole blob before playing (what we do now), or move to a chunked AEAD.

### Playback plan
- **Phase 1 (ship this)**: download whole encrypted file -> native-crypto decrypt -> write to app-private
  `no-backup` cache dir -> `<Video source={{uri: 'file://...'}} />` -> delete on unmount / on cache eviction.
  With RNQC the decrypt of a 50 MB file is ~0.3 s, so the *only* remaining latency is the download. Good enough.
- **Phase 2 (if users complain about time-to-first-frame)**: chunked STREAM format + Range-based fetch, plus
  - Android: a react-native-video **v7 plugin** implementing `getMediaDataSourceFactory` with a decrypting
    `DataSource`;
  - iOS: a small native module implementing `AVAssetResourceLoaderDelegate`, or a localhost HTTP server.
  Budget this as real native work on both platforms. Nobody has shipped a reusable RN library for it.

### Honest summary of the 7 MB question
The 7 MB cap makes video **a 45-second-clip feature, not a video-sharing feature**. It is fixable without
multipart (kill base64, move off middleware) up to maybe 10-15 MB, but **anything comparable to the market
(Signal 100 MB, WhatsApp 16 MB inline / 2 GB doc) requires chunked/resumable upload.** There is no clever
encoding trick that closes that gap — every competitor solves it with on-device transcoding plus a large,
chunk-uploaded blob.

---

## Explicitly NOT verified in this pass
- WhatsApp's official media size limits and transcode parameters (vendor FAQ not fetched; third-party only).
- Whether Signal's live remote config currently serves 100 MiB or 200 MiB.
- Synapse's current default `max_upload_size`.
- Apple's documented restrictions on `AVAssetResourceLoaderDelegate` for non-HLS/progressive assets.
- Whether `@dr.pogodin/react-native-static-server` supports dynamic request handlers (needed for Option B).
- `react-native-simple-crypto` / `react-native-fast-crypto` AES-GCM support (assumed absent, not confirmed).
- Which Expo SDK version first shipped `aesEncryptAsync`.
- Soatok's Signal crypto review part 4 (403 on fetch) — Signal facts here come from libsignal source instead.
- RN transcoding library landscape (`react-native-compressor` etc.) — not evaluated.
- Our own Next.js middleware body-limit behaviour and web-client cipher choice — not read.

## Source list
- Signal RemoteConfig.kt — https://github.com/signalapp/Signal-Android/blob/main/app/src/main/java/org/thoughtcrime/securesms/util/RemoteConfig.kt
- Signal PushMediaConstraints.java — https://github.com/signalapp/Signal-Android/blob/main/app/src/main/java/org/thoughtcrime/securesms/mms/PushMediaConstraints.java
- Signal VideoConstants.kt — https://github.com/signalapp/Signal-Android/blob/main/lib/video/src/main/java/org/thoughtcrime/securesms/video/videoconverter/utils/VideoConstants.kt
- Signal transcode inflation bug — https://github.com/signalapp/Signal-Android/issues/13511
- libsignal incremental_mac.rs — https://github.com/signalapp/libsignal/blob/main/rust/protocol/src/incremental_mac.rs
- Matrix spec, encrypted attachments — https://spec.matrix.org/latest/client-server-api/#sending-encrypted-attachments
- MSC4016 — https://github.com/matrix-org/matrix-spec-proposals/pull/4016 and proposals/4016-streaming-e2ee-file-transfer.md on branch matthew/msc4016
- MSC4016 test jig — https://github.com/matrix-org/streaming-files-test
- Matrix crypto vulnerabilities (AES-CTR IND-CCA2) — https://nebuchadnezzar-megolm.github.io/
- Tink AES-GCM-HKDF-STREAMING — https://developers.google.com/tink/streaming-aead/aes_gcm_hkdf_streaming
- react-native-video plugin interface — https://github.com/TheWidlarzGroup/react-native-video/blob/master/docs/docs/plugins/interface.md
- react-native-video VideoPlayer docs — https://github.com/TheWidlarzGroup/react-native-video/blob/master/docs/docs/player/video-player.md
- react-native-video DRM docs — https://github.com/TheWidlarzGroup/react-native-video/blob/master/docs/docs/player/drm.md
- react-native-video issue #2223 — https://github.com/react-native-video/react-native-video/issues/2223
- ExoPlayer/media3 Aes128DataSource — https://github.com/androidx/media/blob/release/libraries/exoplayer_hls/src/main/java/androidx/media3/exoplayer/hls/Aes128DataSource.java
- RNQC benchmarks — https://github.com/margelo/react-native-quick-crypto/blob/main/docs/content/docs/introduction/comparison.mdx
- RNQC cipher API — https://github.com/margelo/react-native-quick-crypto/blob/main/docs/content/docs/api/cipher.mdx
- Joplin RNQC benchmark thread — https://discourse.joplinapp.org/t/performance-test-of-react-native-quick-crypto/38622
- expo-crypto — https://docs.expo.dev/versions/latest/sdk/crypto/ ; AES PR https://github.com/expo/expo/pull/41249
- Telegram Premium FAQ — https://telegram.org/faq_premium ; upload API https://core.telegram.org/api/files
- WhatsApp limits (third-party) — https://filesize.org/limits/whatsapp/ , https://www.usecarly.com/blog/whatsapp-file-size-limit/
- Signal 200MB claim (third-party) — https://aboutsignal.com/news/signal-increases-attachment-size-limit-from-100-mb-to-200-mb/
