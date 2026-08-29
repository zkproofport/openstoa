/**
 * What the server accepts as a post's attachments, and what it does with the
 * authors' own descriptions of their pictures.
 *
 * Creating a post and editing one used to hold two near-identical copies of
 * these checks — the edit route's comment said "Normalise the same way the POST
 * route does", which is how two rules drift into disagreeing. Both now call the
 * one function this file tests, so a rule proved here is a rule on both paths.
 *
 * Edge-case matrix:
 *   boundary   — 0, 1, the cap, and one over, for pictures, videos and the
 *                length of a description
 *   hostile    — markup, wildcards, an escape character and a very long string
 *                in a description; a `javascript:` address as a picture
 *   empty      — absent, null, empty string and whitespace-only are FOUR
 *                separate answers, checked separately
 *   UTF-8      — Korean, emoji, mixed scripts, newlines and tabs
 *   large      — a description far past the cap is refused, never trimmed
 *   integrity  — a description whose picture is not in the post is dropped, so
 *                removing a picture cannot leave its words behind
 *   contract   — a description of "" survives, because empty means decorative
 *                and that is a different answer from never having been asked
 *   authz      — N/A: this function is pure and runs after the route has
 *                already decided who may post
 *   race       — N/A: no async work, no shared state
 */
import { describe, it, expect } from 'vitest';
import {
  normalisePostMedia,
  MAX_IMAGES,
  MAX_IMAGE_ALT,
  MAX_VIDEOS,
} from '@/lib/normalisePostMedia';

const A = 'https://cdn.test/a.jpg';
const B = '/api/media/topics/t/posts/p/b.jpg';
const YT = 'https://youtu.be/aaaaaaaaaaa';

/** The real rule the routes pass in. */
const isVideo = (u: string) => /youtu\.be\/|youtube\.com\/|vimeo\.com\//.test(u);

function ok(input: unknown) {
  const r = normalisePostMedia(input, isVideo);
  if (!r.ok) throw new Error(`expected acceptance, got: ${r.error}`);
  return r.media;
}

function refused(input: unknown): string {
  const r = normalisePostMedia(input, isVideo);
  if (r.ok) throw new Error('expected a refusal, got acceptance');
  return r.error;
}

describe('a description belongs to its picture', () => {
  it('a description is stored against the picture it describes', () => {
    expect(ok({ images: [A], imageAlts: { [A]: 'The queue outside the hall' } })).toEqual({
      images: [A],
      imageAlts: { [A]: 'The queue outside the hall' },
    });
  });

  it('INTEGRITY: a description for a picture that is not in the post is dropped', () => {
    // Removing a picture and forgetting its description is the client being
    // ordinary. Keeping the orphan would let it reattach if that same picture
    // were added back later.
    expect(ok({ images: [A], imageAlts: { [A]: 'kept', [B]: 'orphan' } })).toEqual({
      images: [A],
      imageAlts: { [A]: 'kept' },
    });
  });

  it('CONTRACT: an empty description is KEPT — it means decorative', () => {
    expect(ok({ images: [A], imageAlts: { [A]: '' } })).toEqual({
      images: [A],
      imageAlts: { [A]: '' },
    });
  });

  it('EMPTY vs ABSENT vs NULL vs WHITESPACE are four separate answers', () => {
    // absent: the author was never asked
    expect(ok({ images: [A] })).toEqual({ images: [A] });
    // null: the same as absent, not an error
    expect(ok({ images: [A], imageAlts: null })).toEqual({ images: [A] });
    // empty: the author said there is nothing to announce
    expect(ok({ images: [A], imageAlts: { [A]: '' } })).toEqual({
      images: [A],
      imageAlts: { [A]: '' },
    });
    // whitespace-only: the same statement as empty, stored the same way
    expect(ok({ images: [A], imageAlts: { [A]: '   \t\n  ' } })).toEqual({
      images: [A],
      imageAlts: { [A]: '' },
    });
  });

  it('surrounding space is trimmed; space inside a sentence is not', () => {
    expect(ok({ images: [A], imageAlts: { [A]: '  two  words  ' } })).toEqual({
      images: [A],
      imageAlts: { [A]: 'two  words' },
    });
  });

  it('UTF-8: Korean, emoji, mixed scripts, newlines and tabs survive', () => {
    const text = '투표소 앞 줄 🗳️\tqueue\n두 번째 줄';
    expect(ok({ images: [A], imageAlts: { [A]: text } })?.imageAlts?.[A]).toBe(text);
  });

  it('HOSTILE: markup, wildcards and an escape character are stored as text', () => {
    const nasty = `<script>alert(1)</script> & <img src=x onerror=y> 100% _ \\ ' "`;
    expect(ok({ images: [A], imageAlts: { [A]: nasty } })?.imageAlts?.[A]).toBe(nasty);
  });

  it('BOUNDARY: a description at the cap is accepted, one over is refused', () => {
    const atCap = 'x'.repeat(MAX_IMAGE_ALT);
    expect(ok({ images: [A], imageAlts: { [A]: atCap } })?.imageAlts?.[A]).toBe(atCap);

    const over = 'x'.repeat(MAX_IMAGE_ALT + 1);
    expect(refused({ images: [A], imageAlts: { [A]: over } })).toContain('too long');
  });

  it('LARGE: a very long description is refused, never silently trimmed', () => {
    const huge = '가'.repeat(MAX_IMAGE_ALT * 20);
    const why = refused({ images: [A], imageAlts: { [A]: huge } });
    expect(why).toContain(String(MAX_IMAGE_ALT));
    // The refusal says how much was written, so the author knows what to cut.
    expect(why).toContain(String(huge.length));
  });

  it('a description that is not text is refused rather than coerced', () => {
    expect(refused({ images: [A], imageAlts: { [A]: 42 } })).toContain('must be text');
    expect(refused({ images: [A], imageAlts: { [A]: null } })).toContain('must be text');
    expect(refused({ images: [A], imageAlts: { [A]: ['a'] } })).toContain('must be text');
  });

  it('a list where a map was expected is refused, not ignored', () => {
    expect(refused({ images: [A], imageAlts: ['a', 'b'] })).toContain('imageAlts');
  });

  it('descriptions alone, with no pictures, store nothing', () => {
    expect(ok({ imageAlts: { [A]: 'about a picture that is not here' } })).toBeNull();
  });

  // ── the rules that were already there, now proved on both routes ──────────

  it('BOUNDARY: pictures at the cap pass, one over is refused', () => {
    const at = Array.from({ length: MAX_IMAGES }, (_, i) => `https://cdn.test/${i}.jpg`);
    expect(ok({ images: at })?.images).toHaveLength(MAX_IMAGES);
    expect(refused({ images: [...at, 'https://cdn.test/extra.jpg'] })).toContain('Too many images');
  });

  it('BOUNDARY: videos at the cap pass, one over is refused', () => {
    const at = Array.from({ length: MAX_VIDEOS }, (_, i) => `https://youtu.be/${'a'.repeat(10)}${i}`);
    expect(ok({ videos: at })?.videos).toHaveLength(MAX_VIDEOS);
    expect(refused({ videos: [...at, YT] })).toContain('Too many videos');
  });

  it('HOSTILE: a script address is not a picture', () => {
    expect(refused({ images: ['javascript:alert(1)'] })).toContain('Invalid image URL');
    expect(refused({ images: ['data:image/png;base64,AAAA'] })).toContain('Invalid image URL');
  });

  it("our own uploads are root-relative and must not be rejected as 'not a URL'", () => {
    // This check was once `^https?://`-only and 400'd every real upload.
    expect(ok({ images: [B] })).toEqual({ images: [B] });
  });

  it('a video that is neither YouTube nor Vimeo is refused', () => {
    expect(refused({ videos: ['https://example.test/clip.mp4'] })).toContain('Unsupported video');
  });

  it('BOUNDARY: nothing attached stores nothing at all', () => {
    expect(ok({})).toBeNull();
    expect(ok({ images: [], videos: [] })).toBeNull();
    expect(ok(null)).toBeNull();
    expect(ok(undefined)).toBeNull();
    expect(ok('not an object')).toBeNull();
  });
});
