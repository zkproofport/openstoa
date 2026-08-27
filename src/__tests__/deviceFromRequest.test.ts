/**
 * What a client says it is, and what the server refuses to take its word for.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage
 *   empty/absent  → no header at all, empty string, whitespace only
 *   boundary      → id at 0 / 1 / 128 / 129 / 10k characters
 *   hostile       → unknown kind, casing tricks, control characters, markup,
 *                   a User-Agent that contradicts the declaration
 *   UTF-8         → Korean and emoji in the id survive intact
 *   integrity     → the default is the RESTRICTED kind, never the trusted one
 */
import { describe, it, expect } from 'vitest';
import {
  deviceFromRequest,
  DEVICE_KIND_HEADER,
  DEVICE_ID_HEADER,
} from '@/lib/deviceFromRequest';

/*
 * A headers bag rather than a real `Request`.
 *
 * WHY, and it is worth knowing: an HTTP header value is a ByteString, so
 * `new Request` REFUSES a Korean character or a raw control byte outright —
 * the cases below cannot be constructed through it at all. That is a genuine
 * protection, but it is the platform's, not this module's: a header arriving
 * from a proxy, an SDK, or a hand-rolled client is a string this code is handed
 * and must still bound. Testing through `Request` would have proved only that
 * `Request` validates, and left the module's own guard unexercised.
 */
function req(headers: Record<string, string>): Request {
  const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    headers: { get: (k: string) => lower.get(k.toLowerCase()) ?? null },
  } as unknown as Request;
}

describe('deviceFromRequest', () => {
  it('reads an honest declaration', () => {
    const d = deviceFromRequest(req({ [DEVICE_KIND_HEADER]: 'mobile', [DEVICE_ID_HEADER]: 'abc123' }));
    expect(d).toEqual({ kind: 'mobile', id: 'abc123' });
  });

  it('EMPTY: no headers at all → web, and an id that is unique to this request', () => {
    /*
     * NOT the literal `'unknown'`, and the change is the fix rather than a
     * loosened assertion. Every device that failed to identify itself used to
     * receive the SAME id, so the server merged distinct phones into one row —
     * one person's key state overwriting another's, which is how a device that
     * had never been seen appeared to be an existing one.
     */
    const d = deviceFromRequest(req({}));
    expect(d.kind).toBe('web');
    expect(d.id).toMatch(/^unknown-[0-9a-f-]{36}$/);
  });

  it('ACCUMULATING: ten unidentified requests get ten different ids', () => {
    /*
     * THE AXIS THE DEFECT LIVED ON. A single call cannot tell a unique id from
     * a constant one — the old code passed every single-call assertion in this
     * file while collapsing every anonymous device into one row.
     */
    const ids = new Set(Array.from({ length: 10 }, () => deviceFromRequest(req({})).id));
    expect(ids.size).toBe(10);
  });

  it('EMPTY: empty and whitespace-only are not the same as absent, and both still fall back', () => {
    expect(deviceFromRequest(req({ [DEVICE_KIND_HEADER]: '' })).kind).toBe('web');
    expect(deviceFromRequest(req({ [DEVICE_KIND_HEADER]: '   ' })).kind).toBe('web');
    // Whitespace is not an identity either — it falls back the same way absence
    // does, to an id nothing else will collide with.
    expect(deviceFromRequest(req({ [DEVICE_ID_HEADER]: '   ' })).id).toMatch(/^unknown-/);
  });

  it('INTEGRITY: the fallback is the RESTRICTED kind', () => {
    // The whole point. If an unrecognised value fell back to `mobile`, every
    // gate built on this would be opened by sending nonsense.
    for (const bogus of ['desktop', 'MOBILE-ish', 'agentic', 'mobil', 'null', 'undefined']) {
      expect(deviceFromRequest(req({ [DEVICE_KIND_HEADER]: bogus })).kind).toBe('web');
    }
  });

  it('accepts the three real kinds, case-insensitively', () => {
    expect(deviceFromRequest(req({ [DEVICE_KIND_HEADER]: 'MOBILE' })).kind).toBe('mobile');
    expect(deviceFromRequest(req({ [DEVICE_KIND_HEADER]: ' Web ' })).kind).toBe('web');
    expect(deviceFromRequest(req({ [DEVICE_KIND_HEADER]: 'Agent' })).kind).toBe('agent');
  });

  it('HOSTILE: a contradicting User-Agent changes nothing', () => {
    const d = deviceFromRequest(
      req({
        'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
        [DEVICE_KIND_HEADER]: 'web',
      }),
    );
    // The UA claims an iPhone; the declaration says web. The declaration wins,
    // because the UA is not consulted at all — which is the intended design.
    expect(d.kind).toBe('web');
  });

  it('HOSTILE: control characters are stripped from the id', () => {
    const d = deviceFromRequest(req({ [DEVICE_ID_HEADER]: 'ab\u0000\r\n\u007fcd' }));
    expect(d.id).toBe('abcd');
  });

  it('HOSTILE: markup is stored verbatim, not executed anywhere', () => {
    // Not escaped here on purpose: escaping at the boundary hides what was
    // sent. The renderer escapes; this only bounds and de-controls.
    const d = deviceFromRequest(req({ [DEVICE_ID_HEADER]: '<script>x</script>' }));
    expect(d.id).toBe('<script>x</script>');
  });

  it('BOUNDARY: one character survives; 128 survives whole; 129 and 10k are cut to 128', () => {
    expect(deviceFromRequest(req({ [DEVICE_ID_HEADER]: 'x' })).id).toBe('x');
    const at = 'a'.repeat(128);
    expect(deviceFromRequest(req({ [DEVICE_ID_HEADER]: at })).id).toBe(at);
    expect(deviceFromRequest(req({ [DEVICE_ID_HEADER]: 'a'.repeat(129) })).id).toHaveLength(128);
    expect(deviceFromRequest(req({ [DEVICE_ID_HEADER]: 'a'.repeat(10_000) })).id).toHaveLength(128);
  });

  it('UTF-8: Korean and emoji come through', () => {
    // A device id is generated by us and is hex, so this is not expected in
    // practice — it is here because "not expected" is how mojibake ships.
    expect(deviceFromRequest(req({ [DEVICE_ID_HEADER]: '내폰-📱' })).id).toBe('내폰-📱');
  });
});
