# EXIF handling in Signal & WhatsApp — research notes

Researched 2026-08-21. Evidence tiers are marked explicitly:
**[VENDOR]** = vendor docs/source code · **[SOURCE]** = first-party source code
**[3P-TEST]** = third-party measurement · **[INFERENCE]** = my reasoning · **[NOT VERIFIED]**

## Source quality warning (read this first)

Web search on this topic is dominated by SEO content farms — sammapix.com,
privacystrip.com, editprivacy.com, viallo.app, metaclean.app, 4n6.app,
fast.io — which appear to be AI-generated lead-gen pages for "metadata
remover" apps. They state confident numbers ("100% of document-mode transfers
preserve all metadata") with no stated methodology, no dates, no tooling.
**None of them are used as evidence below.** Everything below is sourced from
first-party source code, vendor docs, or the projects' own issue trackers.

---

## 1. SIGNAL

### 1a. Signal-Android — history

**Before March 2018: EXIF was NOT reliably stripped.** Stripping happened only
incidentally, as a side effect of downscaling large images. Small images went
out with EXIF intact.

Signal founder Moxie Marlinspike, 2016-12-18, in
[Signal-Android#5968](https://github.com/signalapp/Signal-Android/issues/5968):
> "I think it happens incidentally at the moment because of image scaling, but
> if an image were small enough to be sent without scaling or compression, I'm
> not sure the metadata would be removed."

Confirmed empirically in the same thread by contributor `tomrittervg`
(2017-07-25, Signal 4.8.1):
> "I can confirm that on Android EXIF data is **not** removed in many cases...
> They extracted my phone's model, date/time information, and the GPS
> coordinates from the EXIF data."

Moxie's stated design intent, 2017-11-30, same thread:
> "I'd accept a PR for something that strips out **non-orientation** exif
> metadata by default with an option to leave it in."

Note: what actually shipped is stricter than this — it strips orientation too,
by baking the rotation into the pixels (see below).

**March 2018: explicit stripping shipped.** Commit
[`7e1e666`](https://github.com/signalapp/Signal-Android/commit/7e1e666172e0c8d0582d28a817affae91a02a598)
by Greyson Parrelli (Signal), 2018-03-19, titled **"Strip EXIF metadata from
all JPEG images"**: **[SOURCE]**
> "Strip all EXIF metadata from all JPEGs by re-encoding the JPEG. This will
> keep all of the necessary visual effects of the tags (by encoding them
> directly in the image data) while stripped the EXIF tags themselves."

The diff renames `scaleAttachments(...)` → `scaleAndStripExifFromAttachments(...)`
and adds an unconditional re-encode branch: previously an attachment that
already satisfied the size constraints was passed through untouched; after the
commit, a JPEG that satisfies constraints is *still* run through
`getResizedMedia()` purely to destroy its metadata.

Signal staff confirmed intent on
[Signal-Android#7862](https://github.com/signalapp/Signal-Android/issues/7862)
(2018-05-29, a user complaining that stripping had started): maintainer reply
"It was intentional."

### 1b. Signal-Android — current behavior (main branch, checked 2026-08-21)

The logic now lives in
[`AttachmentCompressionJob.java`](https://github.com/signalapp/Signal-Android/blob/main/app/src/main/java/org/thoughtcrime/securesms/jobs/AttachmentCompressionJob.java).
The source comment is explicit: **[SOURCE]**

```java
/**
 * Compresses the images. Given that we compress every image, this has the fun side effect of
 * stripping all EXIF data.
 */
@WorkerThread
private static MediaStream compressImage(...)
```

So in the *current* code the framing is "side effect of unconditional
compression", but it is a **deliberate, load-bearing** side effect — the 2018
commit added compression specifically to get it, for images that needed no
compression at all.

**Mechanism — this matters:** `ImageCompressionUtil.compressWithinConstraints()`
decodes the image through Glide to an `android.graphics.Bitmap` (a raw pixel
buffer) and then re-encodes with `scaledBitmap.compress(format, quality, out)`.
A `Bitmap` is pixels only — it carries no container metadata. So **every** EXIF,
XMP and IPTC field is destroyed by construction, not by a field allowlist.
There is no "keep DateTimeOriginal" path. Orientation survives only because
Glide applies the rotation to the pixels during decode.

**Scope — which attachments get this:** gated by
[`MediaConstraints.canResize()`](https://github.com/signalapp/Signal-Android/blob/main/feature/media-send/src/main/java/org/signal/mediasend/MediaConstraints.java):
```java
public boolean canResize(@Nullable String mediaType) {
  return ContentTypeUtil.isImageType(mediaType) && !ContentTypeUtil.isGif(mediaType) ||
         ContentTypeUtil.isVideoType(mediaType) && isVideoTranscodeAvailable();
}
```
i.e. **all image types except GIF**. Stickers are also explicitly skipped
(`"Sticker, not compressing."`).

### 1c. Signal — "send as image" vs "send as file/document"

This is the one place the popular blog answer is **wrong for Signal**.

The blogspam claims Signal-as-file preserves EXIF (copying the WhatsApp
answer). The primary evidence says otherwise on Android: the strip is applied
in the **send job**, keyed on **content type**, not on which UI affordance the
user picked. A `.jpg` picked via the document picker still has
`contentType == image/jpeg`, so it still hits `canResize()` and still gets
re-encoded.

Corroborated by the user who filed
[#7862](https://github.com/signalapp/Signal-Android/issues/7862) precisely
because he *wanted* his originals preserved (2018-05-30): **[3P-TEST]**
> `scienmind`: "if you want to send a picture unmodified, send it as a 'file'"
> `circledot`: "I have just made another test and I can confirm, pics sent via
> File are still modified; no EXIF and their extension changed from '.jpg' to
> '.jpeg'"

**Caveat / [NOT VERIFIED]:** that test is from 2018 and the media-send stack has
been rewritten since. I did not find a current vendor statement, and I could
not empirically test. Treat "Signal strips even as-file" as *likely but
unverified on current builds*. What IS verified on current code is that the
gate is content-type-based with no as-file escape hatch in
`AttachmentCompressionJob`. Non-image content types (e.g. a `.zip`, or an image
renamed to an unknown extension so it resolves to `application/octet-stream`)
are passed through untouched.

### 1d. Signal-iOS — current behavior (main branch, checked 2026-08-21)

iOS is the more interesting implementation: it has an **explicit, allowlist-based
metadata stripper**, not merely a re-encode side effect. All in
[`SignalUI/Attachments/NormalizedImage.swift`](https://github.com/signalapp/Signal-iOS/blob/main/SignalUI/Attachments/NormalizedImage.swift).

There is even a dedicated error case
`SignalAttachmentError.couldNotRemoveMetadata` with a user-facing string
`ATTACHMENT_ERROR_COULD_NOT_REMOVE_METADATA` — Signal treats "failed to strip
metadata" as a **send-blocking error**, which is a strong statement of intent.

**The allowlist is two fields — both orientation:** **[SOURCE]**
```swift
private static let preservedMetadata: [CFString] = [
    "\(kCGImageMetadataPrefixTIFF):\(kCGImagePropertyTIFFOrientation)" as CFString,
    "\(kCGImageMetadataPrefixIPTCCore):\(kCGImagePropertyIPTCImageOrientation)" as CFString,
]
```
Everything else is enumerated and overwritten with `kCFNull` before
`CGImageDestinationCopyImageSource`. **`DateTimeOriginal` is not preserved.**
GPS is not preserved. Camera make/model, lens, serial number: not preserved.

**PNG gets a parallel chunk allowlist** (`pngChunkTypesToKeep`): critical chunks
`IHDR/PLTE/IDAT/IEND`, rendering-relevant ancillary chunks
`tRNS/cHRM/gAMA/iCCP/sRGB/bKGD/pHYs/sPLT`, and APNG chunks `acTL/fcTL/fdAT`.
Note what is **absent** and therefore dropped: `eXIf`, `tEXt`/`iTXt`/`zTXt`
(arbitrary text), and **`tIME`** (last-modification timestamp). Signal is
dropping the PNG timestamp chunk too — timestamps are treated as
metadata-to-remove, not as data-to-keep.

**JPEG never even takes the surgical path.** A dated code comment: **[SOURCE]**
```swift
// 10-18-2023: Due to an issue with corrupt JPEG IPTC metadata causing a
// crash in CGImageDestinationCopyImageSource, stop using the original
// JPEGs and instead go through the recompresing step. This is an iOS bug
// (FB13285956) still present in iOS 17 and should be revisited in the
// future to see if JPEG support can be reenabled.
guard (type as String) != UTType.jpeg.identifier else {
    Logger.warn("falling back to compression for JPEG")
    throw .couldNotRemoveMetadata
}
```
`couldNotRemoveMetadata` here is caught by `stripImage()` (`try?`) and falls
through to `compressImageToQuality()` — a full decode-to-`CGImage` and
re-encode. So **for JPEG on iOS the outcome is the same as Android: total
metadata destruction via re-encode.** Even orientation is not preserved as a
tag; it is baked into pixels, because the decode uses
`kCGImageSourceCreateThumbnailWithTransform: true`.

**Summary of the iOS pipeline:**
- non-JPEG, small enough, right format → surgical strip, keep only orientation tags
- JPEG, or too large, or unsupported format → full re-encode, everything gone
- either way, **DateTimeOriginal and GPS never survive**

### 1e. Signal — HEIC/HEIF (Q4)

**Both platforms convert. Neither ever delivers HEIC.** This is explicit, not
incidental.

*iOS* — [`SignalAttachment.swift`](https://github.com/signalapp/Signal-iOS/blob/main/SignalUI/Attachments/SignalAttachment.swift)
splits input formats from output formats, with the rationale in a comment: **[SOURCE]**
```swift
// We support additional types for input images because we can transcode
// these to a format that's always supported by the receiver.
...
additionalTypes.append(.heif)
additionalTypes.append(.heic)
additionalTypes.append(.webP)
return outputImageUTISet.union(additionalTypes.map(\.identifier))
```
And the output set, from
[`MimeTypeUtil.swift`](https://github.com/signalapp/Signal-iOS/blob/main/SignalServiceKit/Util/MimeTypeUtil.swift):
```swift
public static let supportedImageMimeTypes: Set<String> = [
    imageJpeg, "image/pjpeg", imagePng, imageTiff, imageXTiff, imageBmp, imageXWindowsBmp,
]
public static let supportedInputImageMimeTypes = supportedImageMimeTypes.union([
    imageHeic, imageHeif, imageWebp,
])
```
HEIC/HEIF appear **only** in the input set. The output container enum has
exactly two members:
```swift
private enum ContainerType { case jpg; case png }
```
Selection rule in `compressImageToTier`: **PNG if `mayHaveTransparency`
(sticker-like), otherwise JPEG** at quality 0.6 (0.55 if the larger axis ≥ 3072).

*Android* — [`ImageCompressionUtil.java`](https://github.com/signalapp/Signal-Android/blob/main/app/src/main/java/org/thoughtcrime/securesms/util/ImageCompressionUtil.java): **[SOURCE]**
```java
private static @NonNull Bitmap.CompressFormat mimeTypeToCompressFormat(@Nullable String mimeType) {
  if (MediaUtil.isJpegType(mimeType) ||
      MediaUtil.isHeicType(mimeType) ||
      MediaUtil.isHeifType(mimeType) ||
      MediaUtil.isAvifType(mimeType) ||
      MediaUtil.isVideoType(mimeType)) {
    return Bitmap.CompressFormat.JPEG;
  } else if (MediaUtil.isWebpType(mimeType)) {
    return Bitmap.CompressFormat.WEBP;
  } else {
    return Bitmap.CompressFormat.PNG;
  }
}
```
**HEIC / HEIF / AVIF → JPEG**, explicitly enumerated.

**Relevance to your JPEG-is-1.8-2x-larger-than-HEIF measurement:** Signal
accepts that cost and pays for it with aggressive quality reduction (0.6 JPEG
quality, and a *tiered* retry loop that keeps lowering resolution until the
output fits under a byte cap). Signal is not optimizing for bytes-at-equal-
quality; it is optimizing for **universal decodability at a bounded byte
budget**. The stated reason is receiver compatibility ("a format that's always
supported by the receiver") — an Android 6 or desktop-Linux recipient cannot
necessarily decode HEIC. Note this is a *compatibility* argument, not a
*privacy* argument.

---

## 2. WHATSAPP

### 2a. No vendor documentation exists

**I could not find any official WhatsApp/Meta statement about EXIF handling.**
WhatsApp is closed source; the Help Center is a JS SPA with no indexable page
on the topic; the WhatsApp Security Whitepaper covers the Signal-protocol
crypto, not media pre-processing. **[NOT VERIFIED — vendor silence]**

This is itself a finding: unlike Signal (where the behavior is auditable in
AGPL source and was discussed publicly by the founder), **every claim about
WhatsApp's EXIF behavior is third-party observation.** Nobody can promise it
will not change in the next release.

### 2b. Best available evidence: a 2025 peer-reviewed forensics study

The strongest citable measurement I found is:

> Ahmed et al. (2025), *"Forensic Value of Exif Data: An Analytical Evaluation
> of Metadata Integrity across Image Transfer Methods"*, **Perspectives in
> Legal and Forensic Sciences**. DOI
> [10.70322/plfs.2025.10006](https://doi.org/10.70322/plfs.2025.10006) ·
> full text: https://www.sciepublish.com/article/pii/567

Methodology: 10 Android handsets (Samsung, POCO, Motorola, Redmi, OnePlus,
Realme) + iPhone 7 + iPhone 12, factory reset, plus Flickr CC images.
Extraction via Magnet AXIOM, XRY, FTK and ExifTool, with MD5/SHA-256 compared
before/after.

**Table 2 verbatim (✓ = retained, X = stripped):**

| Exif field | USB | Email | Telegram (Doc) | Telegram (Chat) | Signal (Doc) | Signal (Chat) | WhatsApp (Doc) | WhatsApp (Image) | Instagram | FB Messenger | Snapchat |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Timestamp | ✓ | ✓ | ✓ | X | ✓ | X | ✓ | **X** | X | X | X |
| Geolocation | ✓ | ✓ | ✓ | X | ✓ | X | ✓ | **X** | X | X | X |
| Device Make/Model | ✓ | ✓ | ✓ | X | ✓ | X | ✓ | **X** | X | X | X |
| Resolution | ✓ | ✓ | ✓ | ✓* | ✓ | ✓* | ✓ | ✓* | ✓* | ✓* | ✓* |

(* = present but altered by downscaling)

Study quotes: **[3P-TEST]**
> "When images are transferred as 'images' (i.e., in chat mode) or uploaded
> through social media, aggressive compression algorithms strip Exif metadata."

> "images transmitted using WhatsApp document mode retained nearly identical
> file sizes and full metadata" — versus image mode's "dramatic file size
> reduction (up to 40–80% smaller)"

> "confirming that the retention is a deliberate design choice rather than a
> by-product of compression artifacts"

Hash evidence: document-mode transfers produced **byte-identical** MD5/SHA-256
to the original; image-mode transfers produced entirely different hashes.

**So for WhatsApp the answer is:**
- **Send as photo → EXIF stripped**, including GPS *and* timestamp. Confirmed
  by hash change + forensic extraction. **[3P-TEST]**
- **Send as document → EXIF fully preserved, byte-for-byte.** GPS included.
  **[3P-TEST]**
- WhatsApp's photo path is a **recompression**, not a surgical strip
  ([INFERENCE] from the 40–80% size reduction + hash change + altered
  resolution). There is no evidence WhatsApp keeps a field allowlist the way
  Signal-iOS does.

### 2c. Caveats on this study

Be careful how much weight this carries:
- Published in a new/low-profile SciePublish journal, not a top forensics venue.
- **No app versions or test dates are reported.**
- **The Telegram(Doc), Signal(Doc) and WhatsApp(Doc) columns are identical**,
  which reads more like an assumed model of "document mode = passthrough" than
  three independent measurements.
- Which device (Android vs iOS) was used for which app test is not stated.
- HEIC/HEIF is **never mentioned**, so it does not answer Q4.

### 2d. Independent corroboration that WhatsApp destroys the timestamp

[`ikaruswill/whatsapp-media-tools`](https://github.com/ikaruswill/whatsapp-media-tools)
is a tool that exists *only because* WhatsApp destroys capture time. Its own
help text: **[3P-TEST / artifact]**

> "Restore **discarded** Exif date information in WhatsApp media **based on the
> filename**. For videos, only the created and modified dates are set."

```python
img_filename_regex = re.compile(r'IMG-\d{8}-WA\d{4}\..+')
vid_filename_regex = re.compile(r'VID-\d{8}-WA\d{4}\..+')
...
allowed_extensions = set(['.mp4', '.jpg', '.3gp', '.jpeg'])
```

Two things fall out of this:
1. **WhatsApp strips `DateTimeOriginal`, not just GPS.** The tool has to
   reconstruct it from the filename — and the filename carries only
   `YYYYMMDD`, so **time-of-day is unrecoverable**. WhatsApp's own naming
   scheme preserves date-only.
2. **WhatsApp image output is `.jpg`/`.jpeg`.** The extension allowlist in a
   tool built to walk WhatsApp media directories contains no `.heic`, no
   `.webp`. → see Q4.

---

## 3. THE CAPTURE-TIME QUESTION (Q3)

### 3a. What the two apps actually do with `DateTimeOriginal`

**Both strip it. Neither preserves capture time on the normal send path.**

- **Signal-iOS:** the `preservedMetadata` allowlist is orientation-only —
  `DateTimeOriginal` is set to `kCFNull`. The PNG chunk allowlist also omits
  `tIME`. **[SOURCE]**
- **Signal-Android:** decode-to-`Bitmap` + re-encode. Nothing survives. **[SOURCE]**
- **WhatsApp:** confirmed stripped by the 2025 forensics study (Table 2,
  "Timestamp: X" for WhatsApp Image mode) and by the existence of
  `whatsapp-media-tools`. **[3P-TEST]**

### 3b. But Signal's *stated* policy is GPS-focused — an important nuance

This is the single most useful thing I found for your decision, because it
separates *stated intent* from *implemented behavior*.

Greyson Parrelli — the Signal engineer who authored the 2018 strip commit —
in [Signal-Android#12075](https://github.com/signalapp/Signal-Android/issues/12075),
2022-03-24: **[VENDOR]**

> "So the main goal of EXIF stripping was to remove **location data**, which
> still isn't there. **The goal was _not_ to remove all EXIF data.** Do you
> think any of the remaining EXIF data is identifying?"

And 2022-03-28:
> "I guess I just want to dispell the idea that 'all EXIF data is bad'. Most of
> it is just fine. We just want to make sure there's no **location data or
> other identifying bits**."

So: **Signal's stated threat model is GPS-first.** Timestamps get destroyed as
a consequence of the chosen *mechanism* (full re-encode), not because Signal
argued they were dangerous. The two happen to coincide.

### 3c. Re-encoding does not mean "no metadata" — it means "different metadata"

That same issue is worth reading for a second reason: it is a bug report that
**Signal's re-encode ADDS metadata that was not in the original**, including to
images the user had already scrubbed with ExifTool. Greyson's own dump of a
post-Signal image:

- **JFIF**: version, resolution
- **File**: type, bits per sample, color components, image size, YCbCr subsampling
- **Composite**: megapixels
- **ICC Profile**: full sRGB profile, `Profile Copyright: Google Inc. 2016`,
  `Profile Date Time: 0000:00:00 00:00:00`

Signal's position (issue closed as wontfix):
> "this is the EXIF data that is added by the built-in Android image conversion
> tools... in order to strip off this EXIF data, we'd have to put a lot of
> engineering effort into handwriting some new streaming EXIF editor/image
> converter so the receiver can't see the metadata revealing... the image
> width? Or the color profile?"

**Design lesson for you:** "we re-encode, so there's no metadata" is false.
There is *platform-encoder* metadata. `Profile Copyright: Google Inc. 2016` is
a weak platform fingerprint (it says "encoded by Android/Skia"). It is not
user-identifying, but if your threat model includes "don't reveal which client
sent this", a re-encode alone does not get you there. **[SOURCE + INFERENCE]**

### 3d. Is timestamp-stripping considered good practice, or is GPS the only critical field?

Honest answer: **the industry is split, and the literature is GPS-dominated.**

Evidence that only GPS is treated as critical:
- Signal's own stated rationale above ("the main goal... was to remove location
  data"). **[VENDOR]**
- Apple's photo share sheet has a *Location* toggle specifically — not a
  "remove metadata" toggle. **[NOT VERIFIED — I could not load Apple's support
  page in this session; do not cite this without checking.]**
- My Crossref sweep for EXIF-timestamp deanonymization literature returned
  **nothing on point**. The privacy/deanonymization literature on EXIF is
  overwhelmingly about GPS geotags and about *sensor/camera fingerprinting*
  (PRNU), not timestamps. **[searched, not found]**

Evidence that "strip everything, timestamps included" is the privacy-tooling default:
- **mat2** (the Metadata Anonymisation Toolkit, used by Tails/Whonix ecosystems)
  explicitly names capture time as the problem in its README: **[SOURCE]**
  > "Metadata within a file can tell a lot about you. Cameras record data about
  > **when a picture was taken** and what camera was used... Maybe you don't
  > want to disclose those information. This is precisely the job of mat2:
  > getting rid, as much as possible, of metadata."

  And mat2's per-format allowlists
  ([`libmat2/images.py`](https://github.com/jvoisin/mat2/blob/master/libmat2/images.py))
  contain **no capture-time field of any kind** — only structural fields
  (`ImageWidth`, `BitsPerSample`, `ColorComponents`, ...) plus `Orientation`.
- Both Signal and WhatsApp *in practice* destroy it, whatever their stated rationale.

**My assessment [INFERENCE]:** I found no CVE and no published deanonymization
attack that turns on `DateTimeOriginal` alone. But the correlation argument is
straightforward and does not need a paper to be valid:
- Capture time to the second is a **high-entropy linking key**. Two images with
  the same second-resolution timestamp are near-certainly the same event/device.
  It links a pseudonymous account's uploads to each other, and to any other
  timestamped record an adversary holds.
- Capture time reveals **local time-of-day patterns** (sleep schedule, work
  hours) across a corpus, which is a coarse geolocation and lifestyle signal.
- EXIF stores local wall-clock time, usually with **no timezone**
  (`OffsetTimeOriginal` is newer and inconsistently written). Whether a photo
  says 03:14 or 15:14 leaks the sender's rough longitude when combined with a
  known send time.

So: "GPS is the only privacy-critical field" is a **weaker position than it
looks**, and it is not the position the privacy-tooling ecosystem takes.

---

## 4. HEIC / HEIF (Q4)

### 4a. Signal — verified, converts to JPEG

Already established in §1e from source, on both platforms. **Signal never
delivers HEIC.** HEIC/HEIF are input-only formats; output is JPEG (or PNG for
transparent/sticker-like images).

### 4b. WhatsApp — strongly indicated, converts to JPEG. **[not vendor-confirmed]**

I could **not** find vendor documentation. Indirect evidence:
- WhatsApp's own media naming is `IMG-YYYYMMDD-WA####.jpg`, and forensic
  tooling that walks WhatsApp media directories allowlists
  `{'.mp4', '.jpg', '.3gp', '.jpeg'}` with **no `.heic`**. **[3P-TEST / artifact]**
- The 2025 forensics study measured 40–80% file-size reduction plus altered
  resolution and changed hashes on WhatsApp image mode — a full re-encode.
  **[3P-TEST]**
- The study tested iPhone 7 and iPhone 12 (both HEIC-capable) and never reports
  a HEIC output. (Weak: it also never reports the input format.)

**Verdict: WhatsApp photo-mode almost certainly delivers JPEG, but I am
flagging this as inference, not vendor-verified.** WhatsApp *document* mode
delivers the file byte-for-byte, so a HEIC sent as a document arrives as HEIC —
with all EXIF intact.

### 4c. What this means for your HEIC→JPEG size problem

Your measurement (JPEG 1.8–2x larger than HEIF at equal resolution) is
consistent with the literature and is **not** something Signal or WhatsApp
solved — they *accepted* it. Their compensations:

1. **Aggressive quality.** Signal-iOS ships JPEG quality **0.6**, dropping to
   **0.55** when the larger axis ≥ 3072px
   ([`NormalizedImage.compressionQuality`](https://github.com/signalapp/Signal-iOS/blob/main/SignalUI/Attachments/NormalizedImage.swift)).
   That is *low* — well below the 0.8–0.85 most apps default to.
2. **Tiered resolution fallback.** Both platforms loop over descending
   dimension targets and re-encode until the output fits a byte budget
   (`compressImageToQuality` on iOS; `getImageDimensionTargets()` on Android).
   Resolution is sacrificed before the byte cap is.
3. **The reason is compatibility, not privacy.** Signal-iOS says so directly:
   > "We support additional types for input images because we can transcode
   > these to a format that's **always supported by the receiver**."

   A recipient on an old Android build, or Signal Desktop on Linux, may not
   decode HEIC. That is the argument — not metadata.

**Relevant counter-consideration [SOURCE]:** if you *keep* HEIC, thorough
metadata removal gets harder. mat2 refuses to do a full clean on HEIC:
```python
def remove_all(self) -> bool:
    # exiftool can't rewrite HEIF item properties (the `colr` box), so an
    # embedded ICC profile would survive a thorough cleaning.
    if not self.lightweight_cleaning:
        raise RuntimeError("HEIC files can't be thoroughly cleaned. Use lightweight mode instead.")
```
Note also that mat2's HEIC allowlist is the **only** image allowlist in that
file with **no `Orientation` entry** — HEIC orientation handling is a known
rough edge across the ecosystem.

---

## 5. RECOMMENDATION FOR A PRIVACY-FOCUSED E2EE CHAT (Q5)

### Recommendation: **strip everything except orientation** — and prefer a true strip over a blind re-encode.

That is what both apps converge on in practice, and what mat2 does. Concretely:

| Field group | Action | Why |
|---|---|---|
| GPS (`GPSLatitude`, `GPSLongitude`, `GPSAltitude`, `GPSDateStamp`, ...) | **strip** | Uncontested. Home address leak. |
| `DateTimeOriginal` / `CreateDate` / `ModifyDate` / PNG `tIME` | **strip** | High-entropy cross-image linking key + local-time leak. Signal and WhatsApp both destroy it. |
| `Make` / `Model` / `LensModel` / `BodySerialNumber` / `SerialNumber` | **strip** | Device-linking. `BodySerialNumber` is a hard identifier. |
| `Software` | **strip** | Reveals OS version → fingerprint + attack surface. |
| MakerNotes (proprietary blobs) | **strip** | Opaque, vendor-specific, can contain serials, face-detection boxes, burst IDs. |
| Embedded **thumbnail** | **strip** | Classic bug: the thumbnail is not updated when the main image is cropped/redacted. Redaction bypass. |
| XMP / IPTC (author, copyright, keywords, region-of-interest/person tags) | **strip** | Names of people, author identity. |
| `Orientation` (TIFF/EXIF) | **keep, or bake into pixels** | See below. |
| ICC color profile | **keep** | Wrong colors otherwise. Not user-identifying. |
| Dimensions, bit depth, subsampling, color components | **keep** | Derivable from the pixels anyway; stripping buys nothing. |

### The orientation tradeoff, stated explicitly

This is the one field where stripping actively breaks the product. If you drop
`Orientation` without acting on it, **iPhone photos taken in portrait display
sideways or upside down** on decoders that honor the tag, and inconsistently
across decoders that don't. It is the most common self-inflicted wound here.

Two valid strategies, both in production:

**(A) Bake orientation into the pixels, then strip everything.**
Decode → apply rotation → re-encode. The output is `Orientation = 1` (normal)
or has no tag at all, and renders correctly everywhere.
- Signal-Android does this (Glide decode → `Bitmap` → `compress`). **[SOURCE]**
- Signal-iOS does this for JPEG (`kCGImageSourceCreateThumbnailWithTransform: true`). **[SOURCE]**
- mat2 does this (`GdkPixbuf.Pixbuf.apply_embedded_orientation(pixbuf)`). **[SOURCE]**
- The 2018 Signal commit message says it in one line:
  > "This will keep all of the necessary **visual effects** of the tags (by
  > encoding them directly in the image data) while stripped the EXIF tags themselves."
- **Cost:** mandatory re-encode → generation loss, CPU, and the file grows
  (this is where your HEIC→JPEG 1.8–2x hits). Also **adds** encoder metadata
  (§3c).

**(B) Keep only the orientation tag, strip every other field in place.**
No pixel touch, no generation loss, no size increase, HEIC stays HEIC.
- Signal-iOS does this for non-JPEG formats — `preservedMetadata` is exactly
  `TIFF:Orientation` + `IPTCCore:ImageOrientation`. **[SOURCE]**
- mat2 keeps `Orientation` in the allowlist for PNG/TIFF/WebP/AVIF/JXL. **[SOURCE]**
- **Cost:** you must trust every downstream decoder to honor the tag. And per
  mat2, HEIC specifically can't be cleaned thoroughly with off-the-shelf tools.

**For your app, given the HEIC size finding, (B) is the better default and (A)
is the fallback** — mirroring Signal-iOS exactly: surgical strip when the file
is already acceptable, full re-encode only when you must resize anyway. That
gets you HEIC-sized payloads *and* clean metadata, and you only pay the JPEG
tax when the image needed re-encoding regardless.

### What I would NOT recommend

- **"Strip GPS only."** It is Signal's *stated* goal but not what Signal
  *ships*, it is not what WhatsApp ships, and it leaves `DateTimeOriginal` +
  `Model` + `BodySerialNumber` — a strong device/event linking set.
- **"Preserve everything, let the user decide."** Both projects rejected this.
  Signal's contributor guidance was cited in the thread: "The answer is not
  more options." A privacy default that requires a toggle is not a default.
- **Relying on a re-encode as your privacy mechanism without an explicit strip
  step.** Signal-Android's incidental-scaling era (pre-2018) is the cautionary
  tale: small images bypassed scaling and shipped with full GPS for years.
  Moxie, 2016: *"if an image were small enough to be sent without scaling or
  compression, I'm not sure the metadata would be removed."* If you compress
  conditionally, you strip conditionally. **Make the strip unconditional and
  independent of the size check.**
- **A silent "send as file" bypass.** WhatsApp's document mode preserves GPS
  byte-for-byte with **no warning**, and users reach for it to preserve quality.
  If you offer an original-quality path, either strip on that path too (Signal's
  approach) or warn loudly.

### One implementation detail worth copying from Signal-iOS

Signal treats **failure to strip as a send-blocking error**
(`SignalAttachmentError.couldNotRemoveMetadata`, with a localized user-facing
string). It does not fall back to "send it anyway with metadata". Your
equivalent should fail closed — ideally by falling back to full re-encode, as
Signal-iOS does for JPEG, but never by sending the original.

---

## Open items / not verified

- Whether **current** Signal (Android or iOS) strips EXIF when a JPEG is sent
  via the *file/document* picker. Source code says images cannot escape the
  image path (iOS `genericAttachment` has `owsPrecondition(!inputImageUTISet.contains(dataUTI))`;
  Android gates on content type). The 2025 study claims Signal document mode
  preserves everything. **Unresolved conflict — see §6.**
- WhatsApp HEIC output format: inferred, not vendor-confirmed.
- Apple share-sheet "Location" toggle scope: not verified this session.
- No CVE or published attack found specific to EXIF `DateTimeOriginal`.

## 6. The one real conflict in the evidence

**Claim A (2025 forensics study, Table 2):** Signal *document mode* preserves
timestamp, geolocation and device make/model — identical to USB/email.

**Claim B (Signal source code, read 2026-08-21):** images cannot be sent as
generic attachments at all.
[`PreviewableAttachment.buildAttachment`](https://github.com/signalapp/Signal-iOS/blob/main/SignalUI/Attachments/PreviewableAttachment.swift)
routes on UTI:
```swift
if SignalAttachment.inputImageUTISet.contains(dataUTI) {
    guard types.contains(.image) else { throw SignalAttachmentError.invalidFileFormat }
    return try imageAttachment(dataSource: dataSource, dataUTI: dataUTI)
}
...
return try genericAttachment(dataSource: dataSource, dataUTI: dataUTI, attachmentLimits: attachmentLimits)
```
and `genericAttachment` asserts the input is *not* an image:
```swift
owsPrecondition(!SignalAttachment.inputImageUTISet.contains(dataUTI))
```
On Android the strip is gated on **content type**, not on which picker the user
used, so a `.jpg` chosen via the document picker still resolves to `image/jpeg`
and still hits `canResize()`.

**Corroborating B:** the 2018 bug reporter in
[#7862](https://github.com/signalapp/Signal-Android/issues/7862) explicitly
tested the "send as file" workaround and reported it did **not** work —
*"pics sent via File are still modified; no EXIF and their extension changed
from '.jpg' to '.jpeg'"*.

**My read [INFERENCE]:** Claim B is better-supported. The study's
Telegram(Doc) / Signal(Doc) / WhatsApp(Doc) columns are *character-for-character
identical*, which suggests a general "document mode = passthrough" model was
applied rather than three independent measurements; and the study reports no
app versions, no test dates, and does not say which platform was used per app.
Telegram and WhatsApp genuinely do have image-passthrough document modes;
Signal, per its own source, does not.

**Practical takeaway either way:** do not design around "the user can send as a
file to preserve metadata" *or* around "sending as a file is safe". Whatever
your app does, make it explicit and test it — the two most-cited sources on the
internet disagree.

---

## Sources

**Signal — first-party source & maintainer statements**
- Strip commit (2018-03-19, Greyson Parrelli): https://github.com/signalapp/Signal-Android/commit/7e1e666172e0c8d0582d28a817affae91a02a598
- Signal-Android `AttachmentCompressionJob.java`: https://github.com/signalapp/Signal-Android/blob/main/app/src/main/java/org/thoughtcrime/securesms/jobs/AttachmentCompressionJob.java
- Signal-Android `ImageCompressionUtil.java` (HEIC→JPEG): https://github.com/signalapp/Signal-Android/blob/main/app/src/main/java/org/thoughtcrime/securesms/util/ImageCompressionUtil.java
- Signal-Android `MediaConstraints.java` (`canResize`): https://github.com/signalapp/Signal-Android/blob/main/feature/media-send/src/main/java/org/signal/mediasend/MediaConstraints.java
- Signal-iOS `NormalizedImage.swift` (`preservedMetadata`, PNG chunk allowlist, JPEG fallback): https://github.com/signalapp/Signal-iOS/blob/main/SignalUI/Attachments/NormalizedImage.swift
- Signal-iOS `SignalAttachment.swift` (input vs output UTI sets): https://github.com/signalapp/Signal-iOS/blob/main/SignalUI/Attachments/SignalAttachment.swift
- Signal-iOS `PreviewableAttachment.swift` (`buildAttachment`, `genericAttachment` precondition): https://github.com/signalapp/Signal-iOS/blob/main/SignalUI/Attachments/PreviewableAttachment.swift
- Signal-iOS `MimeTypeUtil.swift` (supported image MIME types): https://github.com/signalapp/Signal-iOS/blob/main/SignalServiceKit/Util/MimeTypeUtil.swift

**Signal — issue tracker (maintainer policy statements)**
- Signal-Android #5968 "Image Meta Data Removal" (moxie0 on incidental stripping): https://github.com/signalapp/Signal-Android/issues/5968
- Signal-Android #7862 "Signal removes EXIF data" (intentional; send-as-file tested): https://github.com/signalapp/Signal-Android/issues/7862
- Signal-Android #12075 "New EXIF metadata gets added" (greyson-signal: goal was location data): https://github.com/signalapp/Signal-Android/issues/12075
- Signal-iOS #1984 "SECURITY ISSUE: Signal doesn't strip EXIF from sent images": https://github.com/signalapp/Signal-iOS/issues/1984

**WhatsApp — third-party (no vendor doc found)**
- Ahmed et al. (2025), "Forensic Value of Exif Data: An Analytical Evaluation of Metadata Integrity across Image Transfer Methods", *Perspectives in Legal and Forensic Sciences*. DOI: https://doi.org/10.70322/plfs.2025.10006 · full text: https://www.sciepublish.com/article/pii/567
- `ikaruswill/whatsapp-media-tools` (restores WhatsApp-discarded EXIF dates from filenames): https://github.com/ikaruswill/whatsapp-media-tools

**Privacy tooling reference implementation**
- mat2 README (metadata philosophy, capture time named): https://github.com/jvoisin/mat2/blob/master/README.md
- mat2 `libmat2/images.py` (per-format allowlists, orientation handling, HEIC limitation): https://github.com/jvoisin/mat2/blob/master/libmat2/images.py

**Explicitly NOT used as evidence** (SEO content farms surfaced by search;
no methodology, no dates, no versions): sammapix.com, privacystrip.com,
editprivacy.com, viallo.app, metaclean.app, 4n6.app, fast.io.

**Method note:** WebSearch quota was exhausted early in this session, so
discovery ran through the GitHub code/issue API, Crossref, arXiv, and direct
WebFetch. Apple support pages and MDPI were blocked (403 / SPA) and are marked
not-verified above.
