/**
 * WHERE OBJECTS LIVE — the key layout, as a rule rather than a convention.
 *
 * The old layout partitioned by uploader (`posts/{userId}/…`), so a topic's
 * images were scattered across every uploader's folder and NO prefix reached
 * them: deleting a topic left every picture in it behind, permanently. The fix
 * is not a cleanup routine, it is the key — partition by the dimension deletion
 * actually walks.
 *
 * These tests are pure string assertions on purpose. The property that matters
 * ("one prefix reaches everything a topic owns") is decidable from the key
 * alone, and a test that needed a bucket could not run at all — this repo has
 * no R2 credentials outside deploy.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage in this file
 *   contract          → 'every topic-scoped key starts with the topic prefix',
 *                       'the chat key agrees with chatMedia's own builder',
 *                       'a user-scoped key is NEVER under a topic prefix'
 *   result integrity  → 'one topic's prefix never matches another topic's key',
 *                       'a userId can never be mistaken for a topicId'
 *   boundary          → the no-topic case (null) for every purpose
 *   hostile input     → 'a filename cannot escape its folder' (traversal,
 *                       leading slash), 'a hostile filename cannot forge a
 *                       different topic's prefix'
 *   UTF-8             → 'a Korean or emoji filename is carried, not corrupted,
 *                       and still cannot change the prefix'
 *   empty/null/undef  → null topicId asserted separately from '' topicId
 *   authorization     → N/A here: enforced at the route (upload membership
 *                       check) and covered in r2KeyLayout-routes.test.ts.
 *   race / large      → N/A: pure key construction.
 */
import { describe, it, expect } from 'vitest';
import {
  topicObjectPrefix,
  uploadObjectKey,
  userObjectPrefix,
} from '@/lib/r2';
import { chatMediaObjectKey } from '@/lib/chatMedia';

const TOPIC = '11111111-2222-4333-8444-555555555555';
const OTHER_TOPIC = '99999999-8888-4777-8666-555555555555';
const USER = '0xabc123';

describe('topic-scoped keys', () => {
  it('CONTRACT: a post image lands under its topic', () => {
    const key = uploadObjectKey('post', USER, TOPIC, 'photo.jpg');
    expect(key.startsWith(topicObjectPrefix(TOPIC))).toBe(true);
    expect(key).toMatch(/^topics\/[0-9a-f-]{36}\/posts\/[0-9a-f-]{36}\/photo\.jpg$/i);
  });

  it("CONTRACT: a topic's own picture lands under it too", () => {
    const key = uploadObjectKey('topic', USER, TOPIC, 'cover.webp');
    expect(key.startsWith(topicObjectPrefix(TOPIC))).toBe(true);
    expect(key).toContain('/image/');
  });

  it('CONTRACT: the chat key agrees with the same prefix', () => {
    /*
     * Chat attachments are built by `chatMedia.ts` (their key is sealed inside
     * the message body, so that module owns the shape). The two builders have
     * to agree about the topic prefix or the sweep misses one of them — which
     * is exactly the bug this task exists to close, one level down.
     */
    const key = chatMediaObjectKey(TOPIC, USER, 'a'.repeat(32));
    expect(key.startsWith(topicObjectPrefix(TOPIC))).toBe(true);
    // `chatMediaTopicPrefix` is gone: `topicObjectPrefix` owns the topic prefix
    // and the chat SUBPATH derives from it, so the invariant is asserted on a
    // real key rather than on a second prefix helper that could drift.
    expect(chatMediaObjectKey(TOPIC, 'u1', 'a'.repeat(32)).startsWith(topicObjectPrefix(TOPIC))).toBe(true);
  });

  it('CONTRACT: one sweep of the topic prefix covers all three kinds', () => {
    const keys = [
      uploadObjectKey('post', USER, TOPIC, 'a.jpg'),
      uploadObjectKey('topic', USER, TOPIC, 'b.jpg'),
      chatMediaObjectKey(TOPIC, USER, 'c'.repeat(32)),
    ];
    for (const key of keys) {
      expect(key.startsWith(topicObjectPrefix(TOPIC)), key).toBe(true);
    }
  });

  it('CONTRACT: every purpose is classified — inside the topic sweep, or knowingly outside', () => {
    /*
     * The invariant a topic deletion rests on: for each kind of object we
     * store, either the topic prefix reaches it, or we have decided out loud
     * that it does not belong to a topic at all. A purpose added later without
     * a decision fails here rather than quietly becoming an object nothing
     * deletes — which is precisely how post images became permanent orphans.
     */
    const CLASSIFIED: Array<[string, string, boolean]> = [
      ['post', uploadObjectKey('post', USER, TOPIC, 'a.jpg'), true],
      ['topic picture', uploadObjectKey('topic', USER, TOPIC, 'b.jpg'), true],
      ['chat attachment', chatMediaObjectKey(TOPIC, USER, 'c'.repeat(32)), true],
      // Deliberately outside: a profile picture is the person's, not the room's.
      ['profile', uploadObjectKey('avatar', USER, TOPIC, 'me.png'), false],
      // Deliberately outside, and documented: no topic existed at upload time.
      ['no-topic upload', uploadObjectKey('post', USER, null, 'a.jpg'), false],
    ];
    for (const [name, key, insideSweep] of CLASSIFIED) {
      expect(key.startsWith(topicObjectPrefix(TOPIC)), name).toBe(insideSweep);
    }
  });

  it('INTEGRITY: one topic’s prefix never matches another topic’s object', () => {
    // The property a deletion depends on: sweeping topic A cannot take B's.
    const mine = uploadObjectKey('post', USER, TOPIC, 'a.jpg');
    const theirs = uploadObjectKey('post', USER, OTHER_TOPIC, 'a.jpg');
    expect(mine.startsWith(topicObjectPrefix(OTHER_TOPIC))).toBe(false);
    expect(theirs.startsWith(topicObjectPrefix(TOPIC))).toBe(false);
  });

  it('two uploads of the same filename in one topic do not collide', () => {
    const a = uploadObjectKey('post', USER, TOPIC, 'photo.jpg');
    const b = uploadObjectKey('post', USER, TOPIC, 'photo.jpg');
    expect(a).not.toBe(b);
  });
});

describe('user-scoped keys — the residue', () => {
  it('BOUNDARY: an avatar is user-scoped even when a topic is supplied', () => {
    // A profile picture belongs to the person, not to whatever room they
    // happened to be looking at.
    const key = uploadObjectKey('avatar', USER, TOPIC, 'me.png');
    expect(key.startsWith(userObjectPrefix(USER))).toBe(true);
    expect(key.startsWith('topics/')).toBe(false);
    expect(key).toContain('/profile/');
  });

  it('EMPTY: a null topicId files the object under the uploader', () => {
    /*
     * The honest residue: an image chosen while a topic is still being CREATED
     * has no topic to be filed under, so a later topic deletion cannot reach
     * it. Asserted rather than hidden — this is the known gap in AGENTS.md.
     */
    const key = uploadObjectKey('post', USER, null, 'photo.jpg');
    expect(key.startsWith(userObjectPrefix(USER))).toBe(true);
    expect(key).toContain('/uploads/');
    expect(key.startsWith('topics/')).toBe(false);
  });

  it('EMPTY: an empty-string topicId is treated as no topic, not as a folder', () => {
    // Separate case from null: `topics//posts/...` would be a prefix that
    // matches every topic's sweep, which is worse than being outside it.
    const key = uploadObjectKey('post', USER, '', 'photo.jpg');
    expect(key.startsWith(userObjectPrefix(USER))).toBe(true);
    expect(key).not.toContain('topics//');
  });

  it('INTEGRITY: a user prefix can never collide with a topic prefix', () => {
    // Different first segment, so no userId — however odd — can be swept by a
    // topic deletion, and no topicId can be swept by a user's.
    expect(userObjectPrefix(USER).startsWith('users/')).toBe(true);
    expect(topicObjectPrefix(TOPIC).startsWith('topics/')).toBe(true);
    expect(userObjectPrefix('topics')).not.toBe(topicObjectPrefix('topics'));
  });
});

describe('hostile filenames', () => {
  it('HOSTILE: a traversal filename cannot climb out of its topic', () => {
    /*
     * The filename is the one attacker-controlled part of the key. It sits in
     * the LAST segment, after a random uuid, so the prefix is already fixed by
     * the time it appears — `..` can make an ugly key, never a key belonging to
     * a different topic. (`deleteR2Prefix` refuses a prefix containing `..`
     * separately, so a sweep cannot be steered either.)
     */
    const key = uploadObjectKey('post', USER, TOPIC, '../../../etc/passwd');
    expect(key.startsWith(topicObjectPrefix(TOPIC))).toBe(true);
    expect(key.startsWith(topicObjectPrefix(OTHER_TOPIC))).toBe(false);
  });

  it('HOSTILE: a filename naming another topic does not move the object', () => {
    const key = uploadObjectKey('post', USER, TOPIC, `${OTHER_TOPIC}.jpg`);
    expect(key.startsWith(topicObjectPrefix(TOPIC))).toBe(true);
  });

  it('HOSTILE: a leading slash does not produce an absolute key', () => {
    const key = uploadObjectKey('post', USER, TOPIC, '/etc/passwd');
    expect(key.startsWith('/')).toBe(false);
    expect(key.startsWith(topicObjectPrefix(TOPIC))).toBe(true);
  });

  it('UTF-8: Korean and emoji filenames are carried without changing the prefix', () => {
    for (const name of ['사진.jpg', '🖼️.png', 'ある.jpeg']) {
      const key = uploadObjectKey('post', USER, TOPIC, name);
      expect(key.startsWith(topicObjectPrefix(TOPIC)), name).toBe(true);
      expect(key.endsWith(name), name).toBe(true);
    }
  });

  it('LARGE: a very long filename still cannot change the prefix', () => {
    const key = uploadObjectKey('post', USER, TOPIC, `${'a'.repeat(5000)}.jpg`);
    expect(key.startsWith(topicObjectPrefix(TOPIC))).toBe(true);
  });
});
