/**
 * What an answer from `/api/auth/session` means for the stored token.
 *
 * THE DEFECT THIS EXISTS FOR, found on a real device (SM-A235N). The boot path
 * asked the server whether the stored token was still good, and returned the
 * same `false` for "the server refused it" as for "there was no server to ask".
 * The caller reads a refusal as a reason to call `session.clear()` — so with
 * wifi and mobile data switched off, relaunching the app showed the Welcome
 * screen to an account signed in seconds earlier, AND discarded the token, so
 * coming back into range did not restore it. A tunnel, a lift or a flight was
 * enough to lose the session.
 *
 * The token was never invalid. Nobody could be asked.
 */

export type SessionVerdict =
  /** The server answered and the token is good. */
  | 'ok'
  /** The server answered and refused it. The ONLY verdict that may sign out. */
  | 'rejected'
  /** Nobody answered. The token is untouched and still on the device. */
  | 'unreachable';

/**
 * Map one HTTP status to a verdict.
 *
 * A thrown request — offline, DNS, TLS, a deadline — is `unreachable` and is
 * handled by the caller's `catch`; this function only sees statuses.
 */
export function sessionVerdictForStatus(status: number): SessionVerdict {
  /*
   * NOT A REAL STATUS. `0` is what a status variable holds when the request
   * never completed — and `NaN` or a negative number means the same thing by a
   * different route. Falling through to `rejected` here would sign the account
   * out for a reason nobody ever gave, which is the whole defect this file
   * exists to prevent, arriving through the door left open while fixing it.
   *
   * Caught by the hostile cases in `offlineKeepsSession.test.ts`, which is
   * exactly why they are there.
   */
  if (!Number.isFinite(status) || status < 100) return 'unreachable';
  if (status >= 200 && status < 300) return 'ok';
  /*
   * 5xx is the SERVER failing, not the account. Reading it as a refusal would
   * sign every user out during a bad deploy — the same defect as the offline
   * one with a different trigger, and a far louder one.
   */
  if (status >= 500) return 'unreachable';
  return 'rejected';
}

/**
 * May this verdict end the account's session?
 *
 * Written as a question rather than as an `if` at the call site, because the
 * defect was precisely that two different situations reached the same clearing
 * branch. One verdict clears. `clearsSessionCount` pins that it stays one.
 */
export function verdictClearsSession(verdict: SessionVerdict): boolean {
  return verdict === 'rejected';
}

/** Every verdict, so a test can assert the whole set rather than sample it. */
export const SESSION_VERDICTS: readonly SessionVerdict[] = ['ok', 'rejected', 'unreachable'];


/**
 * The account id carried in a session token.
 *
 * WHY THIS AND NOT A STORED COPY. An offline launch keeps the session (see
 * above) but cannot ask the server who it belongs to — and the chat list is
 * cached per account, so without an id the offline room list cannot be found
 * either. Two offline fixes cancelling each other out, caught on the device
 * with the list still saying "Couldn't load chats" after both had shipped.
 *
 * The first attempt persisted the id to `localStore` and was reverted: read
 * state moved to the SERVER in `feat(chat): move the read cursor to the
 * server`, and a second device-local copy of who-you-are is exactly the
 * duplication that decision removed. The token already names the account.
 *
 * NOT AN AUTHORISATION CHECK. The signature is not verified here and must not
 * be trusted for anything: the server checks it on every request. All this
 * decides is which account's cached rooms to paint, and a forged id would show
 * its own author an empty cache.
 */
export function userIdFromToken(token: string | null | undefined): string {
  if (typeof token !== 'string') return '';
  const parts = token.split('.');
  // header.payload.signature — anything else is not a JWT.
  if (parts.length !== 3) return '';
  try {
    /*
     * base64URL, which is not what `atob` expects: `-` and `_` stand in for
     * `+` and `/`, and the padding is dropped. Feeding it in raw fails on
     * roughly one token in four, which is the sort of bug that looks like
     * "sometimes the offline list is empty".
     */
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    /*
     * `atob` gives LATIN-1, one byte per character — it has no idea the bytes
     * are UTF-8. A Korean or emoji nickname in the payload comes back as
     * mojibake and `JSON.parse` either throws or hands back a corrupted id, so
     * the bytes are decoded explicitly. Caught by the base64URL case in
     * `offlineKeepsSession.test.ts`, which put non-ASCII in the id on purpose.
     */
    const json =
      typeof atob === 'function'
        ? new TextDecoder().decode(Uint8Array.from(atob(padded), (c) => c.charCodeAt(0)))
        : Buffer.from(padded, 'base64').toString('utf8');
    const payload: unknown = JSON.parse(json);
    if (typeof payload !== 'object' || payload === null) return '';
    const id = (payload as { userId?: unknown }).userId;
    return typeof id === 'string' ? id : '';
  } catch {
    // A token this cannot read is a token whose cache cannot be found. The
    // list falls back to the server, which is where it came from anyway.
    return '';
  }
}
