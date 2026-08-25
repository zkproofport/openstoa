/**
 * Which kind of client is asking — read from a header the client sets.
 *
 * WHY A HEADER AND NOT THE USER-AGENT. A User-Agent is a string the caller
 * writes, and every scraper on earth already lies in it; gating on it would be
 * both unreliable and misleading, because it LOOKS like the server knows
 * something it does not.
 *
 * WHY A DECLARATION IS ENOUGH HERE — and where it is not. This value decides
 * two things: whether a session counts as "a device this person is signed in
 * on", and whether chat is available. Neither is a permission a stranger gains
 * by lying. Someone who forges `mobile` from a browser still cannot read a
 * conversation, because the keys are on the phone and never leave it; all they
 * achieve is signing their own other device out. The real protection is that
 * the key material is not there, and no header changes that.
 *
 * So this is deliberately NOT treated as authentication. It is how an honest
 * client says what it is, so the server can apply the one-device rule and keep
 * chat off the web. Anything that must actually be enforced — who you are, what
 * you may write — is decided by the session and the API key, not by this.
 */

import type { NextRequest } from 'next/server';
import type { DeviceKind } from '@/lib/sessionStore';

/** Set by the mobile app and by the web client's fetch wrapper. */
export const DEVICE_KIND_HEADER = 'x-openstoa-device-kind';
export const DEVICE_ID_HEADER = 'x-openstoa-device-id';

const KINDS: readonly DeviceKind[] = ['mobile', 'web', 'agent'];

export interface DeclaredDevice {
  kind: DeviceKind;
  /** Opaque, client-generated, stable per install. Never used for identity. */
  id: string;
}

/**
 * Read the declaration, falling back to `web`.
 *
 * `web` is the safe default because it is the MOST restricted kind: a client
 * that says nothing gets no chat and counts as a device. Defaulting to `mobile`
 * would hand the full-trust answer to anyone who simply omitted the header,
 * which is the wrong direction for a default to fail in.
 */
export function deviceFromRequest(req: NextRequest | Request): DeclaredDevice {
  const rawKind = req.headers.get(DEVICE_KIND_HEADER)?.trim().toLowerCase() ?? '';
  const kind = (KINDS as readonly string[]).includes(rawKind) ? (rawKind as DeviceKind) : 'web';

  /*
   * Bounded and stripped. This string is stored and shown back to a person as
   * "your other device", so an unbounded header would be both a storage
   * question and a place to put markup. Control characters go for the same
   * reason: a device id containing a newline turns one log line into two.
   */
  const rawId = req.headers.get(DEVICE_ID_HEADER) ?? '';
  const id =
    rawId
      .split('')
      .filter((c) => c.charCodeAt(0) >= 0x20 && c.charCodeAt(0) !== 0x7f)
      .join('')
      .trim()
      .slice(0, 128) || 'unknown';

  return { kind, id };
}
