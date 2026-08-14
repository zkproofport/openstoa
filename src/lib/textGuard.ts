/**
 * Shared guard against the NUL byte (U+0000) in free-text fields that flow
 * straight into a Postgres `text` column via Drizzle.
 *
 * Postgres `text`/`varchar` storage is UTF-8 but the server represents
 * strings as null-terminated C strings internally, so ANY occurrence of
 * 0x00 — even mid-string, even as a single byte inside an otherwise valid
 * UTF-8 value — is rejected by the driver with a raw
 * `invalid byte sequence for encoding "UTF8": 0x00` error. Without a guard
 * ahead of the insert, that raw driver message reaches the HTTP client as an
 * uncategorized 500: wrong status code AND an information disclosure (it
 * leaks the driver + storage engine).
 *
 * Deliberately narrow: every OTHER control character (tab, newline, other
 * C0 controls, DEL) is a valid UTF-8 byte sequence that Postgres `text`
 * stores without complaint, and the E2E hostile-input matrix
 * (`apikey-gated-topics.test.ts`) asserts `\n` / `\t` survive byte-identical
 * round trips through this exact validation layer. Widening this guard to
 * reject other control characters would break that intentional behavior —
 * NUL is rejected because it is the one byte that structurally cannot be
 * stored, not because it is "a control character."
 */
const NUL_BYTE = String.fromCharCode(0);

export function hasNulByte(value: string): boolean {
  return value.indexOf(NUL_BYTE) !== -1;
}
