/**
 * An unsent MESSAGE has to still be there when the app comes back.
 *
 * THE DEFECT. A failed send left a bubble with Retry and Discard, and that
 * bubble lived in component state. Leaving the room, or Android reclaiming a
 * backgrounded app, took the sentence with it — no row, no error, nothing in
 * the composer. The user did nothing wrong and had no way to tell the message
 * had gone; the next time they looked, the conversation simply did not contain
 * it.
 *
 * The same defect was found and fixed for ATTACHMENTS. Words were left behind,
 * which produced the odd result that a photo nobody watched fail survived a
 * restart while a sentence someone did watch fail did not.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage
 *   contract   → a text row round-trips, and Retry reads the exact string
 *   boundary   → 0 / 1 / cap / cap+1 rows; 1 char / limit / limit+1 chars
 *   empty      → '' vs '   ' vs null vs undefined, each its own case
 *   UTF-8      → Korean, emoji, newlines and tabs come back byte-identical
 *   large      → an over-long draft is REFUSED, never silently truncated
 *   hostile    → corrupt JSON, wrong shape, unknown kind, injected media fields
 *   integrity  → a text row never claims to have expired attachment bytes
 *   race       → both kinds share one store, one cap, one expiry
 */
import { describe, it, expect } from 'vitest';
import {
  CHAT_FAILED_ROW_TTL_MS,
  CHAT_MEDIA_RETRY_WINDOW_MS,
  MAX_PERSISTED_FAILED_ROWS,
  MAX_PERSISTED_FAILED_TEXT_CHARS,
  addFailedRow,
  buildChatMediaBody,
  isFailedMediaExpired,
  parseFailedRows,
  removeFailedRow,
  serializeFailedRows,
  type PersistedFailedRow,
} from '@/lib/chatMedia';

const NOW = 1_800_000_000_000;
const TOPIC = '11111111-2222-3333-4444-555555555555';
const MEDIA_KEY = `topics/${TOPIC}/chat/0xabc123/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.bin`;

function text(over: Partial<Extract<PersistedFailedRow, { kind: 'text' }>> = {}): PersistedFailedRow {
  return { kind: 'text', rowId: 'row-1', text: 'the message that never sent', createdAt: NOW, ...over };
}

function media(over: Partial<Extract<PersistedFailedRow, { kind: 'media' }>> = {}): PersistedFailedRow {
  return {
    kind: 'media',
    rowId: 'media-1',
    body: buildChatMediaBody({
      v: 1,
      key: MEDIA_KEY,
      mediaId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      takVersion: 0,
      mime: 'image/png',
      size: 3,
    }),
    key: MEDIA_KEY,
    createdAt: NOW,
    ...over,
  };
}

describe('an unsent message survives a restart', () => {
  it('REGRESSION: the words come back, which is the whole point', () => {
    const restored = parseFailedRows(serializeFailedRows([text()]), NOW + 60_000);
    expect(restored).toEqual([text()]);
  });

  it('CONTRACT: Retry gets the exact string, not a normalised one', () => {
    /*
     * Retry re-seals from this field. Anything that trims, collapses or
     * re-encodes here sends words the person did not write, and they have no
     * way to notice — the bubble would show the altered text as though it were
     * theirs.
     */
    const original = '  spaces   kept  \n\ttabs too  ';
    const [row] = parseFailedRows(serializeFailedRows([text({ text: original })]), NOW);
    expect((row as Extract<PersistedFailedRow, { kind: 'text' }>).text).toBe(original);
  });

  it('UTF-8: Korean, emoji and mixed scripts come back identical', () => {
    for (const s of ['안녕하세요, 오늘 회의 늦어요', '🙂🔥 나중에 봐요', 'mixed 한글 and English 🇰🇷', '줄1\n줄2\t끝']) {
      const [row] = parseFailedRows(serializeFailedRows([text({ text: s })]), NOW);
      expect((row as Extract<PersistedFailedRow, { kind: 'text' }>).text).toBe(s);
    }
  });

  it('BOUNDARY: an empty store is empty, not an error', () => {
    expect(parseFailedRows(serializeFailedRows([]), NOW)).toEqual([]);
  });

  it('EMPTY: blank drafts are dropped — each blank shape checked separately', () => {
    /*
     * Four different absences, collapsed nowhere. A '' and a '   ' both mean
     * there is nothing to send and nothing to show, so restoring one would put
     * an empty bubble in the room holding a slot under the cap. A missing or
     * null field is a corrupt row and takes the same exit by a different route.
     */
    for (const t of ['', '   ', '\n\t ', null, undefined]) {
      const raw = JSON.stringify([{ kind: 'text', rowId: 'r', text: t, createdAt: NOW }]);
      expect(parseFailedRows(raw, NOW)).toEqual([]);
    }
  });

  it('BOUNDARY: one character is a real message and is kept', () => {
    expect(parseFailedRows(serializeFailedRows([text({ text: 'ㅇ' })]), NOW)).toHaveLength(1);
  });

  it('LARGE: at the limit it is kept, past it REFUSED rather than truncated', () => {
    /*
     * The transport would reject a longer body anyway (the chat route caps a
     * ciphertext at 4096 bytes), so keeping it only fills the quota with
     * something that can never be sent. Refusing beats truncating: a shortened
     * draft restores as words the person did not write.
     */
    const atLimit = 'ㄱ'.repeat(MAX_PERSISTED_FAILED_TEXT_CHARS);
    expect(parseFailedRows(serializeFailedRows([text({ text: atLimit })]), NOW)).toHaveLength(1);
    const over = 'ㄱ'.repeat(MAX_PERSISTED_FAILED_TEXT_CHARS + 1);
    expect(parseFailedRows(serializeFailedRows([text({ text: over })]), NOW)).toEqual([]);
  });

  it('BOUNDARY: the cap holds, and the row it drops is the OLDEST', () => {
    let list: PersistedFailedRow[] = [];
    for (let i = 0; i <= MAX_PERSISTED_FAILED_ROWS; i++) {
      list = addFailedRow(list, text({ rowId: `r${i}`, text: `m${i}`, createdAt: NOW + i }));
    }
    expect(list).toHaveLength(MAX_PERSISTED_FAILED_ROWS);
    expect(list.some((r) => r.rowId === 'r0')).toBe(false);
    expect(list[0].rowId).toBe(`r${MAX_PERSISTED_FAILED_ROWS}`);
  });

  it('CONTRACT: a successful retry removes exactly its own row', () => {
    const list = addFailedRow(addFailedRow([], text({ rowId: 'a' })), text({ rowId: 'b' }));
    expect(removeFailedRow(list, 'a').map((r) => r.rowId)).toEqual(['b']);
  });

  it('CONTRACT: re-failing the same row replaces it rather than stacking', () => {
    // Retry keeps the row id, so a second failure must not leave two bubbles.
    const once = addFailedRow([], text({ rowId: 'a', text: 'first' }));
    const twice = addFailedRow(once, text({ rowId: 'a', text: 'first', createdAt: NOW + 5 }));
    expect(twice).toHaveLength(1);
  });

  it('TTL: a row nobody ever touched stops being litter after a day', () => {
    const raw = serializeFailedRows([text()]);
    expect(parseFailedRows(raw, NOW + CHAT_FAILED_ROW_TTL_MS)).toHaveLength(1);
    expect(parseFailedRows(raw, NOW + CHAT_FAILED_ROW_TTL_MS + 1)).toEqual([]);
  });

  it('INTEGRITY: a text row never expires the way an attachment does', () => {
    /*
     * The attachment window exists because the bytes get collected. Words are
     * right here, so a retry an hour later sends exactly what a retry a second
     * later would — showing "the attachment expired" on a sentence would be a
     * false explanation for a message that can still be sent.
     */
    const old = text({ createdAt: NOW - CHAT_MEDIA_RETRY_WINDOW_MS - 1 });
    expect(parseFailedRows(serializeFailedRows([old]), NOW)).toHaveLength(1);
    // The media rule still says what it always said, for media.
    expect(isFailedMediaExpired({ createdAt: NOW - CHAT_MEDIA_RETRY_WINDOW_MS - 1 }, NOW)).toBe(true);
  });

  it('INTEGRITY: both kinds share one list, newest first', () => {
    const list = addFailedRow(addFailedRow([], text({ rowId: 't', createdAt: NOW })), media({ createdAt: NOW + 1 }));
    expect(list.map((r) => r.kind)).toEqual(['media', 'text']);
    expect(parseFailedRows(serializeFailedRows(list), NOW + 1000)).toHaveLength(2);
  });

  it('HOSTILE: garbage in storage costs a row, never the room', () => {
    for (const raw of ['', 'not json', '{}', '[', 'null', JSON.stringify({ kind: 'text' }), JSON.stringify(42)]) {
      expect(parseFailedRows(raw, NOW)).toEqual([]);
    }
  });

  it('HOSTILE: a row with no kind, or an unknown one, is dropped', () => {
    /*
     * `kind` is the only thing separating "show these words" from "fetch and
     * render this object". A row that does not say which it is must not be
     * guessed at — guessing is how a body of attacker-chosen JSON becomes a
     * fetch.
     */
    const shapes = [
      { rowId: 'r', text: 'hi', createdAt: NOW },
      { kind: 'sms', rowId: 'r', text: 'hi', createdAt: NOW },
      { kind: 42, rowId: 'r', text: 'hi', createdAt: NOW },
    ];
    for (const shape of shapes) expect(parseFailedRows(JSON.stringify([shape]), NOW)).toEqual([]);
  });

  it('HOSTILE: media fields smuggled onto a text row are not carried through', () => {
    // A restored text row must not arrive holding a key that Discard would then
    // ask the server to delete.
    const raw = JSON.stringify([{ kind: 'text', rowId: 'r', text: 'hi', createdAt: NOW, key: MEDIA_KEY, body: 'x' }]);
    expect(parseFailedRows(raw, NOW)).toEqual([{ kind: 'text', rowId: 'r', text: 'hi', createdAt: NOW }]);
  });

  it('HOSTILE: a rowId that is missing or empty is dropped', () => {
    for (const rowId of ['', null, undefined, 7]) {
      const raw = JSON.stringify([{ kind: 'text', rowId, text: 'hi', createdAt: NOW }]);
      expect(parseFailedRows(raw, NOW)).toEqual([]);
    }
  });

  it('HOSTILE: a non-finite timestamp cannot dodge the TTL', () => {
    for (const createdAt of [Number.NaN, Infinity, '2026', null]) {
      const raw = JSON.stringify([{ kind: 'text', rowId: 'r', text: 'hi', createdAt }]);
      expect(parseFailedRows(raw, NOW)).toEqual([]);
    }
  });
});
