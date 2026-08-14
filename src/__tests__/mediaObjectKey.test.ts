/**
 * `parseMediaObjectKey` (M-5) — the gate route's first line of defense: is
 * this even a shape `uploadObjectKey` could have produced?
 *
 * It is deliberately the INVERSE of `uploadObjectKey` (see r2KeyLayout.test.ts
 * for that function's own contract). Every case here either round-trips
 * through both functions, or is a shape neither `uploadObjectKey` nor a real
 * object key could ever be — the two suites are meant to be read together.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage in this file
 *   boundary          → 4, 5, 6-segment inputs; the exact 5-segment shape
 *   hostile input     → traversal segments (`..`, `.`), wrong root, wrong
 *                       folder name, non-UUID topic/media ids
 *   empty/null/undef  → empty array, empty-string segments
 *   UTF-8             → Korean/emoji filenames still classify correctly
 *   large             → a very long filename segment still classifies
 *   contract          → every `uploadObjectKey` output round-trips back to
 *                       the SAME kind/id `parseMediaObjectKey` reports
 *   result integrity  → two different topics/users never cross-classify
 */
import { describe, it, expect } from 'vitest';
import { parseMediaObjectKey, uploadObjectKey } from '@/lib/r2';

const TOPIC = '11111111-2222-4333-8444-555555555555';
const OTHER_TOPIC = '99999999-8888-4777-8666-555555555555';
const USER = '0xabc123';

describe('parseMediaObjectKey — contract with uploadObjectKey', () => {
  it('CONTRACT: a post image round-trips to topic-post', () => {
    const key = uploadObjectKey('post', USER, TOPIC, 'photo.jpg');
    expect(parseMediaObjectKey(key.split('/'))).toEqual({ kind: 'topic-post', topicId: TOPIC });
  });

  it("CONTRACT: a topic's own picture round-trips to topic-image", () => {
    const key = uploadObjectKey('topic', USER, TOPIC, 'cover.webp');
    expect(parseMediaObjectKey(key.split('/'))).toEqual({ kind: 'topic-image', topicId: TOPIC });
  });

  it('CONTRACT: an avatar round-trips to avatar, keyed by uploader not topic', () => {
    const key = uploadObjectKey('avatar', USER, TOPIC, 'me.png');
    expect(parseMediaObjectKey(key.split('/'))).toEqual({ kind: 'avatar', userId: USER });
  });

  it('CONTRACT: a no-topic upload round-trips to user-upload', () => {
    const key = uploadObjectKey('post', USER, null, 'draft.png');
    expect(parseMediaObjectKey(key.split('/'))).toEqual({ kind: 'user-upload', userId: USER });
  });

  it('INTEGRITY: a key for one topic never classifies as another topic', () => {
    const key = uploadObjectKey('post', USER, TOPIC, 'a.jpg');
    const parsed = parseMediaObjectKey(key.split('/'));
    expect(parsed).not.toEqual({ kind: 'topic-post', topicId: OTHER_TOPIC });
  });
});

describe('parseMediaObjectKey — boundary segment counts', () => {
  it('BOUNDARY: exactly 5 segments is the only accepted shape', () => {
    const good = uploadObjectKey('post', USER, TOPIC, 'a.jpg').split('/');
    expect(good.length).toBe(5);
    expect(parseMediaObjectKey(good)).not.toBeNull();
  });

  it('BOUNDARY: 4 segments (one short) is rejected', () => {
    const key = uploadObjectKey('post', USER, TOPIC, 'a.jpg').split('/').slice(0, 4);
    expect(parseMediaObjectKey(key)).toBeNull();
  });

  it('BOUNDARY: 6 segments (one extra — e.g. a filename with a literal slash) is rejected', () => {
    const key = [...uploadObjectKey('post', USER, TOPIC, 'a.jpg').split('/'), 'extra'];
    expect(parseMediaObjectKey(key)).toBeNull();
  });

  it('EMPTY: an empty segment array is rejected', () => {
    expect(parseMediaObjectKey([])).toBeNull();
  });
});

describe('parseMediaObjectKey — hostile input', () => {
  it('HOSTILE: a `..` segment anywhere is rejected, not just at the end', () => {
    expect(parseMediaObjectKey(['topics', TOPIC, 'posts', '..', 'a.jpg'])).toBeNull();
    expect(parseMediaObjectKey(['topics', '..', 'posts', TOPIC, 'a.jpg'])).toBeNull();
  });

  it('HOSTILE: a `.` segment is rejected', () => {
    expect(parseMediaObjectKey(['topics', TOPIC, 'posts', '.', 'a.jpg'])).toBeNull();
  });

  it('HOSTILE: an empty-string segment (a `//` in the path) is rejected', () => {
    expect(parseMediaObjectKey(['topics', TOPIC, 'posts', '', 'a.jpg'])).toBeNull();
  });

  it('HOSTILE: a root that is neither topics nor users is rejected', () => {
    expect(parseMediaObjectKey(['etc', TOPIC, 'posts', TOPIC, 'passwd'])).toBeNull();
  });

  it('HOSTILE: a folder that is not posts/image (topics) is rejected', () => {
    expect(parseMediaObjectKey(['topics', TOPIC, 'chat', TOPIC, 'a.jpg'])).toBeNull();
  });

  it('HOSTILE: a folder that is not profile/uploads (users) is rejected', () => {
    expect(parseMediaObjectKey(['users', USER, 'secrets', TOPIC, 'a.jpg'])).toBeNull();
  });

  it('HOSTILE: a non-UUID topicId is rejected, even if shaped like a real segment', () => {
    expect(parseMediaObjectKey(['topics', 'not-a-uuid', 'posts', TOPIC, 'a.jpg'])).toBeNull();
  });

  it('HOSTILE: a non-UUID media-id folder is rejected', () => {
    expect(parseMediaObjectKey(['topics', TOPIC, 'posts', 'not-a-uuid', 'a.jpg'])).toBeNull();
  });

  it('HOSTILE: swapping topics/{id} for users/{id} does not silently reclassify', () => {
    // Same UUID value, wrong root — must not be treated as an avatar.
    expect(parseMediaObjectKey(['users', TOPIC, 'profile', TOPIC, 'a.jpg'])).toEqual({
      kind: 'avatar',
      userId: TOPIC,
    });
    // ...but the topic root with a 'profile' folder (not a real shape) is rejected.
    expect(parseMediaObjectKey(['topics', TOPIC, 'profile', TOPIC, 'a.jpg'])).toBeNull();
  });
});

describe('parseMediaObjectKey — UTF-8 and large filenames', () => {
  it('UTF-8: Korean and emoji filenames still classify as topic-post', () => {
    for (const name of ['사진.jpg', '🖼️.png', 'ある.jpeg']) {
      const key = uploadObjectKey('post', USER, TOPIC, name).split('/');
      expect(parseMediaObjectKey(key), name).toEqual({ kind: 'topic-post', topicId: TOPIC });
    }
  });

  it('LARGE: a very long filename segment still classifies correctly', () => {
    const key = uploadObjectKey('post', USER, TOPIC, `${'a'.repeat(5000)}.jpg`).split('/');
    expect(parseMediaObjectKey(key)).toEqual({ kind: 'topic-post', topicId: TOPIC });
  });
});
