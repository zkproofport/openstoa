/*
 * The declared device key is SHAPE-CHECKED, and anything else is simply absent.
 *
 * WHY A BAD KEY MUST BECOME `undefined` RATHER THAN A STRING. The value's only
 * consumer is `idsSharingKey`, which asks "which install ids has this account
 * registered under this key". Passing arbitrary text through would put it into a
 * `r.publicKey === publicKey` comparison that then matches nothing — and a
 * grouping that silently matches nothing looks exactly like "the key grouping
 * does not work", which is a day of reading `deviceTakeoverGate` for a defect
 * that is not there. `undefined` takes the documented fallback instead: the id
 * alone, which is the behaviour that predates keys.
 *
 * The second reason is narrower and worse. The mini-app must send STANDARD
 * base64; a client that switched to base64url would emit `-` and `_`, the shape
 * check would reject every key, and the takeover prompt would come back on every
 * sign-in with nothing in any log to say why. `deviceProofPostsTheKeyTheServerAccepts`
 * holds the other end of that same pairing.
 *
 * The kind/id half of this module is covered by `deviceFromRequest.test.ts`; the
 * cases here only re-assert that the new field did not disturb it.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage
 *   contract   → a real 44-character Ed25519 key comes back verbatim
 *   boundary   → 43, 45, 0 characters; padding in the wrong place
 *   hostile    → base64url, whitespace-only, control characters, markup,
 *                SQL-shaped text, a 10 KB header
 *   empty      → absent / empty / whitespace-only kept as separate cases
 *   UTF-8      → Korean and emoji rejected rather than stored
 *   integrity  → id and kind parse identically whatever the key header says
 *   integrity  → no input throws
 */
import { describe, it, expect } from 'vitest';
import {
  deviceFromRequest,
  DEVICE_KIND_HEADER,
  DEVICE_ID_HEADER,
  DEVICE_KEY_HEADER,
} from '@/lib/deviceFromRequest';

/*
 * A headers bag rather than a real `Request`, for the reason
 * `deviceFromRequest.test.ts` records: an HTTP header value is a ByteString, so
 * `new Request` refuses a Korean character or a raw control byte outright and
 * the hostile cases below could not be constructed at all. That refusal is the
 * platform's, not this module's, and a header handed over by a proxy or an SDK
 * is a string this code must still bound on its own.
 */
function req(headers: Record<string, string>): Request {
  const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    headers: { get: (k: string) => lower.get(k.toLowerCase()) ?? null },
  } as unknown as Request;
}

/** A genuine Ed25519 public key, base64: 32 raw bytes → 43 characters and `=`. */
const REAL_KEY = '+sm2ELed3Uuu93ksPH7t6D4EWnCiI9jTTLjE+8Z2N/Y=';

/** Just the key header, since that is all these cases vary. */
function keyFrom(raw: string): string | undefined {
  return deviceFromRequest(req({ [DEVICE_KEY_HEADER]: raw })).publicKey;
}

describe('the device key header', () => {
  it('CONTRACT: a real 44-character key is returned unchanged', () => {
    expect(keyFrom(REAL_KEY)).toBe(REAL_KEY);
  });

  it('CONTRACT: the key rides alongside kind and id, not instead of them', () => {
    const d = deviceFromRequest(
      req({
        [DEVICE_KIND_HEADER]: 'mobile',
        [DEVICE_ID_HEADER]: 'phone-1',
        [DEVICE_KEY_HEADER]: REAL_KEY,
      }),
    );

    expect(d).toEqual({ kind: 'mobile', id: 'phone-1', publicKey: REAL_KEY });
  });

  it('EMPTY: absent, empty and whitespace-only are separate inputs and all give undefined', () => {
    // Absent is the ordinary case — a first sign-in, before the mini-app has run.
    expect(deviceFromRequest(req({})).publicKey).toBeUndefined();
    expect(keyFrom('')).toBeUndefined();
    expect(keyFrom('   ')).toBeUndefined();
    expect(keyFrom('\t\n ')).toBeUndefined();
  });

  it('BOUNDARY: 43 characters is one short and 45 is one long', () => {
    /*
     * 43 is what an unpadded encoder emits for the same 32 bytes, so this is
     * the likeliest real-world near-miss rather than a contrived one.
     */
    expect(keyFrom(REAL_KEY.slice(0, 43))).toBeUndefined();
    expect(keyFrom('A'.repeat(43))).toBeUndefined();
    expect(keyFrom(`${REAL_KEY}A`)).toBeUndefined();
    expect(keyFrom(`${'A'.repeat(44)}=`)).toBeUndefined();
  });

  it('BOUNDARY: 44 characters with the padding in the wrong place is not a key', () => {
    // Right length, wrong encoding — the case a length-only check would admit.
    expect(keyFrom(`${'A'.repeat(42)}=B`)).toBeUndefined();
    expect(keyFrom(`=${'A'.repeat(43)}`)).toBeUndefined();
    expect(keyFrom('A'.repeat(44))).toBeUndefined();
  });

  it('HOSTILE: base64url is rejected — the encoding both ends must agree on', () => {
    /*
     * THE pairing that would fail silently. `-` and `_` are what base64url uses
     * where standard base64 uses `+` and `/`; a client that switched would
     * present a key the server drops on every request, and the only visible
     * symptom is the takeover prompt returning forever.
     */
    expect(keyFrom(`${'-'.repeat(43)}=`)).toBeUndefined();
    expect(keyFrom(`${'_'.repeat(43)}=`)).toBeUndefined();
    expect(keyFrom(REAL_KEY.replace(/\//g, '_').replace(/\+/g, '-'))).toBeUndefined();
  });

  it('HOSTILE: control characters do not sneak through by being invisible', () => {
    /*
     * Unlike the device id, control characters here are not STRIPPED and then
     * accepted — the whole value is rejected. Stripping would turn a key with a
     * NUL in it into a DIFFERENT, valid-looking key, which is how one device
     * would come to group with another.
     */
    expect(keyFrom(`${'A'.repeat(42)}\u0000=`)).toBeUndefined();
    expect(keyFrom(`${'A'.repeat(42)}\u007f=`)).toBeUndefined();
    expect(keyFrom(`${'A'.repeat(42)}\r\n=`)).toBeUndefined();
    // A newline inside a stored value also turns one log line into two.
    expect(keyFrom(`${REAL_KEY.slice(0, 22)}\n${REAL_KEY.slice(23)}`)).toBeUndefined();
  });

  it('HOSTILE: markup and SQL-shaped text are not keys', () => {
    expect(keyFrom('<script>alert(1)</script>')).toBeUndefined();
    expect(keyFrom("' OR '1'='1")).toBeUndefined();
    expect(keyFrom('%')).toBeUndefined();
    expect(keyFrom('_')).toBeUndefined();
    expect(keyFrom("'; DROP TABLE device_signing_keys; --")).toBeUndefined();
  });

  it('UTF-8: Korean and emoji are rejected, not stored', () => {
    expect(keyFrom('내폰의열쇠')).toBeUndefined();
    expect(keyFrom('🔑')).toBeUndefined();
    expect(keyFrom(`${'가'.repeat(43)}=`)).toBeUndefined();
  });

  it('LARGE: a 10 KB header is rejected and does not hang the parse', () => {
    /*
     * The regex is anchored at both ends and fixed-length, so there is nothing
     * to backtrack — asserted here rather than assumed, because a later change
     * to a quantified pattern is exactly how that stops being true.
     */
    const started = Date.now();
    expect(keyFrom('A'.repeat(10_000))).toBeUndefined();
    expect(keyFrom(`${'A'.repeat(10_000)}=`)).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('INTEGRITY: whitespace AROUND a real key is trimmed, not treated as corruption', () => {
    // A proxy that pads header values must not cost the account its grouping.
    expect(keyFrom(`  ${REAL_KEY}  `)).toBe(REAL_KEY);
    expect(keyFrom(`\t${REAL_KEY}\n`)).toBe(REAL_KEY);
    // Whitespace INSIDE is a different thing and stays a rejection.
    expect(keyFrom(`${REAL_KEY.slice(0, 20)} ${REAL_KEY.slice(21)}`)).toBeUndefined();
  });

  it('INTEGRITY: kind and id parse identically whatever the key header carries', () => {
    /*
     * The regression this exists for is a future edit that reads all three
     * headers through one shared cleanup: bounding or de-controlling the key the
     * way the id is bounded would change what counts as a valid key, and the
     * takeover grouping would drift without any test of the key itself failing.
     */
    for (const bogus of ['', '   ', 'A'.repeat(10_000), '🔑', '<script>', "' OR 1=1"]) {
      const d = deviceFromRequest(
        req({
          [DEVICE_KIND_HEADER]: 'mobile',
          [DEVICE_ID_HEADER]: 'ab cd',
          [DEVICE_KEY_HEADER]: bogus,
        }),
      );
      expect(d.kind).toBe('mobile');
      expect(d.id).toBe('abcd');
      expect(d.publicKey).toBeUndefined();
    }
  });

  it('INTEGRITY: nothing above throws — a malformed header is data, not an error', () => {
    for (const bogus of [
      '',
      '   ',
      ' ',
      'A'.repeat(10_000),
      '🔑',
      '내폰',
      '<script>x</script>',
      "'; DROP TABLE device_signing_keys; --",
      REAL_KEY,
    ]) {
      expect(() => keyFrom(bogus)).not.toThrow();
    }
  });
});
