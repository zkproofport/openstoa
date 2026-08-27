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

import { randomUUID } from 'node:crypto';
export const DEVICE_KIND_HEADER = 'x-openstoa-device-kind';
export const DEVICE_ID_HEADER = 'x-openstoa-device-id';
/**
 * The device's Ed25519 public key, base64, as a CLAIM — not as proof.
 *
 * It is not a credential and is never treated as one. Its only use is grouping:
 * `deviceTakeoverGate` asks "which ids has this account registered under this
 * key", so one phone whose install id changed stops looking like a second
 * phone. Presenting somebody else's key buys nothing an attacker does not
 * already have, because reaching this header at all means holding the account's
 * proof — and the one thing it could suppress (the takeover warning) is a
 * warning ABOUT the holder's own other session.
 *
 * The key is PROVEN separately, at `POST /api/auth/device/challenge`, which is
 * what writes `device_signing_keys` and stamps `last_proved_at`. Nothing is
 * registered from this header.
 */
export const DEVICE_KEY_HEADER = 'x-openstoa-device-key';

const KINDS: readonly DeviceKind[] = ['mobile', 'web', 'agent'];

/**
 * The id for a client that did not send one.
 *
 * DISTINCT PER REQUEST, and that is the whole point. It used to be the constant
 * `'unknown'`, which made every header-less caller the SAME device — so two real
 * phones that both failed to declare themselves were merged, and the one-device
 * rule stayed silent about a takeover that was really happening. That is the one
 * direction this rule must never fail in: the warning it skips is the one that
 * says the other phone's chat keys are about to be lost.
 *
 * A missing id does not mean "the same device". It means "not known", and two
 * unknowns are not equal. Minting a fresh value says so.
 *
 * THE COST IS HONEST AND SMALL: such a client looks new on every request, so the
 * one-device rule nags it. The host app already accepts exactly this trade when
 * its keystore is unavailable ("the install looks new after each launch, so the
 * one-device rule nags"), and a nag is recoverable where a skipped warning is
 * not. Real ZKProofport builds always send an id.
 *
 * Prefixed so a log line still reads as "this caller declared nothing" rather
 * than as a plausible install id.
 */
function anonymousId(): string {
  return `unknown-${randomUUID()}`;
}

export interface DeclaredDevice {
  kind: DeviceKind;
  /** Opaque, client-generated, stable per install. Never used for identity. */
  id: string;
  /**
   * Base64 Ed25519 public key, when the client has one. Absent on a first
   * sign-in — the key is made by the mini-app, which has not run yet — and the
   * gate falls back to the id alone, which is the behaviour that predates it.
   */
  publicKey?: string;
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
      .slice(0, 128) || anonymousId();

  /*
   * Shape-checked, not just length-checked. A 32-byte Ed25519 key is 44 base64
   * characters; anything else is a client bug or a probe, and letting it through
   * would put arbitrary text into a `WHERE publicKey = ?` comparison that then
   * silently matches nothing — a bug that looks exactly like "the grouping does
   * not work" rather than like bad input.
   */
  const rawKey = req.headers.get(DEVICE_KEY_HEADER)?.trim() ?? '';
  const publicKey = /^[A-Za-z0-9+/]{43}=$/.test(rawKey) ? rawKey : undefined;

  return { kind, id, publicKey };
}
