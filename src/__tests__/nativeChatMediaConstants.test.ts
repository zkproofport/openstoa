/**
 * The attachment envelope exists in FOUR languages, and only three of them are
 * checked by a compiler.
 *
 * `packages/mls/src/chatMedia.ts` is the source of truth, and the only copy —
 * the web app, the mini-app and the SDK re-export it (`mlsCryptoTwins.test.ts`
 * asserts there is no second implementation anywhere in the repo), so a change
 * there reaches all three or fails to build. The push handlers cannot import
 * it: the iOS Notification Service Extension is Swift in a separate app target,
 * and the Android FCM handler is Kotlin. Both restate the prefix by hand.
 *
 * That is the shape of a defect that never announces itself. Bump the prefix to
 * `v2` here and nothing in Swift or Kotlin fails to compile — the native
 * comparison simply stops matching, and from then on every attachment push
 * either shows a placeholder forever (iOS) or, worse, renders the raw envelope
 * JSON on a lock screen (Android, which has no fetch path and only a prefix
 * check standing between the envelope and the notification body). Nobody files
 * that: a missing thumbnail reads as a slow network.
 *
 * So the drift is made to fail HERE, in the repo that owns the constant, at the
 * moment it is changed.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage in this file
 *   contract          → every 'matches' case below; the native files are read
 *                       from disk, not mocked
 *   boundary          → the prefix must be the WHOLE constant, not a substring
 *   hostile input     → N/A: inputs are two checked-in source files
 *   empty/null        → a missing sibling checkout skips rather than passes
 *                       silently (see `describeIfPresent`)
 *   UTF-8             → the caption is an emoji + ASCII; asserted identical on
 *                       both platforms
 *   authorization / race / very large → N/A: this is a source-text assertion
 *
 * The sibling repo is OPTIONAL. `openstoa` is public and checked out on its own
 * in CI, where `../proofport-app` does not exist; there the suite skips with a
 * message rather than failing for an absence that is not a defect. It runs in
 * the monorepo, which is where the constant actually gets changed.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CHAT_MEDIA_AEAD_OVERHEAD_BYTES,
  CHAT_MEDIA_BODY_PREFIX,
  MAX_CHAT_MEDIA_BYTES,
} from '@/lib/chatMedia';

const APP_ROOT = join(process.cwd(), '..', 'proofport-app');
const SWIFT_ENVELOPE = join(APP_ROOT, 'ios/OpenStoaNSE/ChatMediaEnvelope.swift');
const SWIFT_SERVICE = join(APP_ROOT, 'ios/OpenStoaNSE/NotificationService.swift');
const KOTLIN_HANDLER = join(
  APP_ROOT,
  'android/app/src/main/java/com/masselabs/zkproofport/openstoa/OpenStoaPushHandler.kt',
);

const present = [SWIFT_ENVELOPE, SWIFT_SERVICE, KOTLIN_HANDLER].every((p) => existsSync(p));
const describeIfPresent = present ? describe : describe.skip;

const read = (p: string) => readFileSync(p, 'utf8');

/** `static let name = "value"` / `const val NAME = "value"`. */
function stringConstant(source: string, name: string): string | null {
  const m = new RegExp(`${name}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(source);
  return m ? m[1] : null;
}

/** `static let name = 10 * 1024 * 1024` — evaluated, so the shape may vary. */
function intConstant(source: string, name: string): number | null {
  const m = new RegExp(`${name}\\s*=\\s*([0-9_*+ ]+)`).exec(source);
  if (!m) return null;
  const expr = m[1].replace(/_/g, '').trim();
  if (!/^[0-9*+ ]+$/.test(expr)) return null;
  return Number(new Function(`return ${expr}`)());
}

describeIfPresent('the native push handlers restate chatMedia.ts correctly', () => {
  it('iOS spells the body prefix exactly as TypeScript does', () => {
    const swift = stringConstant(read(SWIFT_ENVELOPE), 'static let bodyPrefix');
    expect(swift).not.toBeNull();
    expect(swift).toBe(CHAT_MEDIA_BODY_PREFIX);
  });

  it('Android spells the body prefix exactly as TypeScript does', () => {
    const kotlin = stringConstant(read(KOTLIN_HANDLER), 'const val CHAT_MEDIA_BODY_PREFIX');
    expect(kotlin).not.toBeNull();
    expect(kotlin).toBe(CHAT_MEDIA_BODY_PREFIX);
  });

  it('iOS agrees on the plaintext cap a sender may attach', () => {
    expect(intConstant(read(SWIFT_ENVELOPE), 'static let maxPlaintextBytes')).toBe(MAX_CHAT_MEDIA_BYTES);
  });

  it('iOS agrees on the AEAD overhead, which now BOUNDS its fetch', () => {
    /*
     * It did not need this constant while the response was base64 inside JSON —
     * the ceiling was simply doubled to cover the 4/3 expansion with slack. The
     * response is the ciphertext now, so an honest one weighs exactly the
     * preview ceiling plus this, and the extension's memory bound is derived
     * from it. A drift here is a bound that is either too tight (a legal
     * thumbnail refused) or too loose (a lying envelope pulling more into a
     * ~24MB budget than it should).
     */
    expect(intConstant(read(SWIFT_ENVELOPE), 'static let aeadOverheadBytes')).toBe(
      CHAT_MEDIA_AEAD_OVERHEAD_BYTES,
    );
  });

  it('CONTRACT: iOS no longer unwraps a JSON response — the body IS the ciphertext', () => {
    /*
     * The read route answers `application/octet-stream` and nothing else. A
     * Swift copy still parsing `{"ciphertext":"<base64>"}` would find no such
     * key in a body of raw bytes, return nil for every attachment, and degrade
     * silently to a caption — which reads as a slow network and gets filed by
     * nobody. So the JSON path must be gone from the native side too.
     */
    const swift = read(SWIFT_ENVELOPE)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*(\/\/|\*).*$/gm, '');
    expect(swift).not.toContain('object["ciphertext"]');
    expect(swift).not.toContain('base64Encoded');
  });

  it('the iOS fetch ceiling is below the sender cap, or the extension is killed', () => {
    // The extension has ~24MB total and is terminated — no notification at all —
    // the moment it crosses that. Fetching the 10MB a sender may attach would do
    // it, so the ceiling existing AND being lower is the guard.
    const swift = read(SWIFT_ENVELOPE);
    const ceiling = intConstant(swift, 'static let maxPreviewPlaintextBytes');
    expect(ceiling).not.toBeNull();
    expect(ceiling!).toBeGreaterThan(0);
    expect(ceiling!).toBeLessThan(MAX_CHAT_MEDIA_BYTES);
  });

  it('both platforms show the same caption for an attachment', () => {
    const ios = stringConstant(read(SWIFT_ENVELOPE), 'static let attachmentBody');
    const android = stringConstant(read(KOTLIN_HANDLER), 'const val MEDIA_PREVIEW_TEXT');
    expect(ios).not.toBeNull();
    expect(android).toBe(ios);
    // Whatever it says, it must not be the thing it exists to replace.
    expect(ios!.startsWith(CHAT_MEDIA_BODY_PREFIX)).toBe(false);
    expect(ios!.length).toBeGreaterThan(0);
  });

  it('the iOS media AEAD context is `media:<mediaId>`, matching takClient', () => {
    // Sealed under `media:<id>` rather than a message id, because an attachment
    // is sealed before the POST that mints one. A port that uses the message id
    // derives a different key and silently shows no picture.
    expect(read(SWIFT_ENVELOPE)).toContain('return "media:\\(mediaId)"');
  });

  it('the iOS object key is built the way chatMediaObjectKey builds it', () => {
    expect(read(SWIFT_ENVELOPE)).toContain('"topics/\\(topicId)/chat/\\(userId)/\\(mediaId).bin"');
  });

  it('neither handler ever reads the live MLS ciphertext', () => {
    // Opening `ct` consumes a forward-secret ratchet key and desyncs the group
    // (§13.6). Both files read `act` only; this fails if a `ct` read appears.
    for (const file of [SWIFT_SERVICE, SWIFT_ENVELOPE, KOTLIN_HANDLER]) {
      const source = read(file);
      const code = source
        // Comments discuss `ct` at length — strip them before looking for reads.
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*(\/\/|\*).*$/gm, '');
      expect(code).not.toMatch(/userInfo\[\s*"ct"\s*\]/);
      expect(code).not.toMatch(/data\[\s*"ct"\s*\]/);
    }
  });

  it('the iOS prefix constant is stated in exactly one place in the target', () => {
    /*
     * The point of a hand-carried constant living once is that the next person
     * changes one line. A second copy in the same target is how the two halves
     * of one file end up disagreeing — so the literal may appear only in
     * ChatMediaEnvelope.swift, and everything else must go through
     * `ChatMedia.bodyPrefix`.
     */
    const service = read(SWIFT_SERVICE).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(service).not.toContain(CHAT_MEDIA_BODY_PREFIX);
  });
});

describe('the drift check is wired to real files', () => {
  it('names paths that exist, or is skipped for a standalone checkout', () => {
    // A test that silently passes because it read nothing is worse than no test.
    // If the sibling repo IS here, every path must resolve — a rename must fail
    // loudly rather than quietly turning the suite above into a no-op.
    if (existsSync(APP_ROOT)) {
      for (const p of [SWIFT_ENVELOPE, SWIFT_SERVICE, KOTLIN_HANDLER]) {
        expect(existsSync(p), `${p} — native push source moved or was renamed`).toBe(true);
      }
    } else {
      expect(present).toBe(false);
    }
  });
});
