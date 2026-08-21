/**
 * What a saved attachment is called.
 *
 * Saving a chat picture did not exist at all until now, which matters more
 * here than in an ordinary app: an attachment is only readable on a device
 * holding the topic's key, so without a save there is nowhere else the picture
 * can go. Adding the control adds a filename, and a filename built from the
 * wrong input is a way to hand somebody else's browser a path.
 *
 * The mime rides INSIDE the sealed envelope, composed by whichever member sent
 * the message. It is not the server's, and it is not this device's. So the
 * declared type is never interpolated — it only ever looks up a suffix from a
 * fixed table.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage here
 *   contract   → each allowed image type maps to its conventional extension
 *   hostile    → a mime carrying separators, traversal, a second extension, a
 *                leading dot or a NUL cannot influence the name
 *   hostile    → the same for the mediaId, which is hex everywhere it enters
 *                the system but is not trusted to still be hex here
 *   empty      → null, undefined and '' produce a real extension, never a bare
 *                name the OS would have to guess about
 *   boundary   → an unknown-but-plausible image type falls back rather than
 *                inventing a suffix from the string
 *   UTF-8      → non-ASCII in either input cannot reach the name
 *   integrity  → two attachments in one conversation get distinguishable names
 *   very large → an over-long id is bounded
 *   authz / race → N/A: a pure function over two values already in hand.
 */
import { describe, it, expect } from 'vitest';
import { CHAT_MEDIA_MIME_ALLOWLIST, chatMediaFilename } from '@/lib/chatMedia';

const ID = 'a'.repeat(32);

/** Anything that could change which file is written, or where. */
const DANGEROUS = /[/\\:*?"<>|\u0000]|\.\./;

describe('chatMediaFilename', () => {
  it('CONTRACT: every allowed type maps to its conventional extension', () => {
    const got = CHAT_MEDIA_MIME_ALLOWLIST.map((m) => chatMediaFilename(m, ID).split('.').pop());
    expect(got).toEqual(['jpg', 'png', 'gif', 'webp', 'bmp']);
  });

  it('CONTRACT: the name carries the attachment id, so two saves are distinguishable', () => {
    // The sender's own filename is read once to help sniff the type and then
    // dropped, so there is no original name to restore — the id stands in.
    const a = chatMediaFilename('image/png', 'a'.repeat(32));
    const b = chatMediaFilename('image/png', 'b'.repeat(32));

    expect(a).not.toBe(b);
    expect(a).toContain('a'.repeat(32));
  });

  it.each([
    ['a path separator', 'image/../../etc/passwd'],
    ['a windows separator', 'image\\..\\evil'],
    ['a second extension', 'image/png.exe'],
    ['a leading dot', 'image/.bashrc'],
    ['a NUL', 'image/png\u0000.exe'],
    ['a drive letter', 'C:/image/png'],
    ['a quoted break-out', 'image/png" onload="'],
  ])('HOSTILE: %s in the mime cannot reach the filename', (_label, mime) => {
    /*
     * The whole reason the extension comes from a table. This mime was written
     * by another member of the topic; if it were interpolated, they would be
     * choosing what the recipient's browser writes and where.
     */
    const name = chatMediaFilename(mime, ID);

    expect(name).not.toMatch(DANGEROUS);
    expect(name).toBe(`openstoa-${ID}.bin`);
  });

  it.each([
    ['traversal', '../../secret'],
    ['a separator', 'a/b'],
    ['a NUL', `${'a'.repeat(8)}\u0000`],
    ['non-ASCII', '사진🎉'],
  ])('HOSTILE: %s in the mediaId cannot reach the filename', (_label, id) => {
    const name = chatMediaFilename('image/png', id);

    expect(name).not.toMatch(DANGEROUS);
    expect(name.endsWith('.png')).toBe(true);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty', ''],
    ['whitespace', '   '],
  ])('EMPTY: a %s mime still yields an extension', (_label, mime) => {
    // A file with no suffix is one the operating system has to guess about,
    // and a guess is exactly what this avoids.
    const name = chatMediaFilename(mime as string | null | undefined, ID);

    expect(name).toBe(`openstoa-${ID}.bin`);
    expect(name.split('.').pop()).toBeTruthy();
  });

  it('BOUNDARY: a plausible but unlisted image type falls back, it does not invent', () => {
    // `image/svg+xml` would produce ".svg+xml" if the suffix came from the
    // string — and an SVG is script, which is why it is not on the allowlist.
    expect(chatMediaFilename('image/svg+xml', ID)).toBe(`openstoa-${ID}.bin`);
    expect(chatMediaFilename('image/heic', ID)).toBe(`openstoa-${ID}.bin`);
  });

  it('VERY LARGE: an over-long id is bounded rather than passed through', () => {
    const name = chatMediaFilename('image/jpeg', 'f'.repeat(5000));

    expect(name.length).toBeLessThan(64);
    expect(name.endsWith('.jpg')).toBe(true);
  });

  it('EMPTY: an id that sanitises away still names something', () => {
    // Never an empty stem: `.png` alone is a hidden file on unix and confusing
    // everywhere else.
    const name = chatMediaFilename('image/png', '///');

    expect(name).toBe('openstoa-attachment.png');
  });
});
