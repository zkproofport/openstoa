/**
 * The body a chat row carries when this device cannot open it.
 *
 * ONE DEFINITION, because this string is a contract between three layers that
 * never call each other: the cipher and the transport WRITE it when an open
 * fails, and the room screen READS it to decide whether a bubble draws locked,
 * whether a repaired plaintext may replace it, and how many rows the
 * "unreadable" banner counts.
 *
 * It used to be a literal copied into all of them — one exported const beside
 * one producer, and eight hand-typed copies in the screen. Changing the value
 * would have left every consumer comparing against the old one: no lock icon,
 * a banner reading zero, and a recovered message that never replaces its
 * placeholder. All silent, none caught by a type. That is the same shape of
 * defect as the MLS transport reading an HTTP status out of an error's text,
 * and it is fixed the same way — stop re-typing the string.
 *
 * Not a user-facing string and never rendered: both clients map it to a locked
 * bubble in the reader's own language (see the web's `lockedHistory` contract
 * test, which asserts these exact characters never reach the DOM).
 */
export const UNREADABLE_BODY = '[unable to decrypt]';
