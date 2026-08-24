import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import {
  authGet,
  authPut,
  authPost,
  publicPut,
  publicGet,
  secondUserPut,
  secondUserGet,
  secondUserPost,
  getSecondUserToken,
  getUserId,
  getAuthToken,
  getBaseUrl,
  fetchCategorySlugs,
  deleteTopic,
} from './helpers';
import { placeholderGroupCipher } from '@/lib/crypto/groupCipherPlaceholder';
import { envGate, announceEnvGates } from './db-helpers';

/**
 * The ACCOUNT-level chat read cursor, over real HTTP against a real container.
 *
 * What this replaces: the read mark used to be an in-process `Map` in the
 * mini-app, so it died on restart and never crossed devices. A person reading
 * on their phone still saw the badge on the web, and a cold start re-badged
 * every room not opened in that process. `chat_reads` makes it durable and
 * per-account; `PUT /api/topics/{topicId}/chat/read` is how it moves.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) -> coverage in this file
 *   boundary        -> 0 / 1 / N unread; a mark AT the message's own instant
 *                      (inclusive); messageId at the length cap and cap+1
 *   hostile         -> provisional `pending-` id, ilike wildcards, script tags,
 *                      SQL shapes, a NUL byte, a far-future timestamp
 *   empty/null      -> absent body, {}, empty string, whitespace, null, wrong
 *                      type - each asserted separately, never collapsed
 *   UTF-8           -> Korean + emoji message id
 *   large           -> 10 KB message id
 *   authz           -> guest 401 / non-member 403 (PUT and GET) / member 200
 *   race            -> monotonic: an older mark is accepted and IGNORED
 *   contract        -> the cursor is keyed by the SESSION's user, so one member
 *                      moving theirs never moves another's; and the route never
 *                      asks whether the message was readable, which is what
 *                      lets an undecryptable row advance it
 *   result integrity-> unreadCount is consistent with lastReadAt: advancing the
 *                      cursor drives it to 0, and own / system rows never count
 *
 * ONE case needs direct Postgres: nothing in the HTTP API can create a
 * `type='join'` system row any more (only real membership transitions used to
 * persist them), so the "system rows are not counted" rule is unreachable from
 * the outside. It is gated on `DATABASE_URL` and announced, per the file
 * convention - see `.env.test.local.example`.
 */

const DB_URL = process.env.DATABASE_URL ?? null;
let client: Client | null = null;
function db(): Client {
  if (!client) throw new Error('DATABASE_URL required for this case - see .env.test.local');
  return client;
}

let categoryId: string;
/** A topic User B never joins - the non-member surface. */
let closedTopicId: string;
/** A topic both users are in - everything about counting happens here. */
let sharedTopicId: string;
const createdTopicIds: string[] = [];

interface ReadState {
  lastReadAt: string | null;
  lastReadMessageId: string | null;
  unreadCount: number;
}

async function createTopic(title: string): Promise<string> {
  const res = await authPost('/api/topics', {
    title: `${title} ${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    description: 'chat read cursor E2E',
    visibility: 'public',
    categoryId,
  });
  expect(res.status).toBe(201);
  const id = (await res.json()).topic.id as string;
  createdTopicIds.push(id);
  return id;
}

type Poster = (path: string, body?: unknown) => Promise<Response>;

async function send(
  topicId: string,
  text: string,
  post: Poster = authPost,
): Promise<{ id: string; createdAt: string }> {
  const sealed = await placeholderGroupCipher.seal(topicId, text);
  const res = await post(`/api/topics/${topicId}/chat`, {
    ciphertext: sealed.ciphertext,
    epoch: sealed.epoch,
  });
  expect(res.status).toBe(201);
  const m = (await res.json()).message;
  return { id: m.id, createdAt: m.createdAt };
}

async function readState(topicId: string): Promise<ReadState> {
  const res = await authGet(`/api/topics/${topicId}/chat/read`);
  expect(res.status).toBe(200);
  return res.json();
}

async function markRead(topicId: string, messageId: string, readAt: string): Promise<Response> {
  return authPut(`/api/topics/${topicId}/chat/read`, { messageId, readAt });
}

/** The newest message in a room, as the clients see it (history is newest-first). */
async function newestMessage(topicId: string): Promise<{ id: string; createdAt: string }> {
  const res = await authGet(`/api/topics/${topicId}/chat?limit=50`);
  expect(res.status).toBe(200);
  const messages = (await res.json()).messages as Array<{ id: string; createdAt: string }>;
  expect(messages.length).toBeGreaterThan(0);
  return messages[0];
}

/** The joined-topics row for one topic, from the list the clients actually use. */
async function topicRow(topicId: string): Promise<Record<string, unknown> | undefined> {
  const res = await authGet('/api/topics');
  expect(res.status).toBe(200);
  const json = await res.json();
  return (json.topics as Array<Record<string, unknown>>).find((t) => t.id === topicId);
}

describe.sequential('Chat read cursor - account-level, server-side', () => {
  beforeAll(async () => {
    if (DB_URL) {
      client = new Client({ connectionString: DB_URL });
      await client.connect();
    }
    announceEnvGates('chat-read.test.ts');
  });

  afterAll(async () => {
    for (const id of createdTopicIds) await deleteTopic(id).catch(() => undefined);
    if (client) await client.end();
  });

  // -- Setup ---------------------------------------------------------------

  it('setup: categories, two topics, User B joins only one', async () => {
    const cats = await fetchCategorySlugs();
    expect(cats.length).toBeGreaterThan(0);
    categoryId = cats[0].id;

    closedTopicId = await createTopic('E2E Read Closed');
    sharedTopicId = await createTopic('E2E Read Shared');

    const { userId } = await getSecondUserToken();
    expect(userId).toBeTruthy();
    const join = await secondUserPost(`/api/topics/${sharedTopicId}/join`, {});
    expect(join.status, 'join returns 201 Created').toBe(201);
  });

  // -- Authorization -------------------------------------------------------

  it('1. AUTHZ: a guest cannot write a cursor -> 401', async () => {
    const res = await publicPut(`/api/topics/${sharedTopicId}/chat/read`, {
      messageId: '00000000-0000-4000-8000-000000000000',
      readAt: new Date().toISOString(),
    });
    expect(res.status).toBe(401);
  });

  it('2. AUTHZ: a guest cannot read a cursor -> 401', async () => {
    const res = await publicGet(`/api/topics/${sharedTopicId}/chat/read`);
    expect(res.status).toBe(401);
  });

  it('3. AUTHZ: a non-member cannot write a cursor -> 403', async () => {
    const res = await secondUserPut(`/api/topics/${closedTopicId}/chat/read`, {
      messageId: '00000000-0000-4000-8000-000000000000',
      readAt: new Date().toISOString(),
    });
    expect(res.status).toBe(403);
  });

  it('4. AUTHZ: a non-member cannot read a cursor -> 403', async () => {
    const res = await secondUserGet(`/api/topics/${closedTopicId}/chat/read`);
    expect(res.status).toBe(403);
  });

  it('5. AUTHZ: a member gets 200 and a never-read cursor', async () => {
    const state = await readState(sharedTopicId);
    expect(state.lastReadAt).toBeNull();
    expect(state.lastReadMessageId).toBeNull();
    expect(state.unreadCount).toBe(0);
  });

  // -- Input validation ----------------------------------------------------

  it('6. HOSTILE: a non-UUID topicId -> 400, never a driver error', async () => {
    const res = await authPut('/api/topics/not-a-uuid/chat/read', {
      messageId: '00000000-0000-4000-8000-000000000000',
      readAt: new Date().toISOString(),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/topicId/i);
  });

  it('7. EMPTY: absent body and an empty object are each rejected with 400', async () => {
    const noBody = await fetch(`${getBaseUrl()}/api/topics/${sharedTopicId}/chat/read`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${getAuthToken()}` },
    });
    expect(noBody.status).toBe(400);

    const empty = await authPut(`/api/topics/${sharedTopicId}/chat/read`, {});
    expect(empty.status).toBe(400);
    expect((await empty.json()).error).toMatch(/messageId/i);
  });

  it('8. EMPTY: empty string, whitespace-only, null, absent and wrong-type messageId are each 400', async () => {
    const now = new Date().toISOString();
    for (const messageId of ['', '   ', null, undefined, 12345, [], {}]) {
      const res = await authPut(`/api/topics/${sharedTopicId}/chat/read`, { messageId, readAt: now });
      expect(res.status, `messageId=${JSON.stringify(messageId)}`).toBe(400);
    }
  });

  it('9. CONTRACT: a provisional pending- id is refused, and says why', async () => {
    // A row on screen before the server has stored it carries a device-clock
    // `createdAt`. A phone running an hour fast would otherwise park the cursor
    // an hour ahead and mark an hour of real messages read.
    const res = await authPut(`/api/topics/${sharedTopicId}/chat/read`, {
      messageId: 'pending-000000000001',
      readAt: new Date().toISOString(),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/provisional/i);
  });

  it('10. HOSTILE + UTF-8: wildcards, tags, SQL shapes, NUL and Korean/emoji ids -> 400', async () => {
    const now = new Date().toISOString();
    const hostile = [
      '%',
      '_',
      '\\',
      '%_%',
      '\u0000',
      '00000000-0000-4000-8000-00000000000\u0000',
      "' OR 1=1 --",
      '<script>alert(1)</script>',
      'a b',
      '안녕하세요',
      '\u{1f31f}\u{1f31f}\u{1f31f}',
      '00000000-0000-4000-8000-000000000000 OR 1=1',
      '{00000000-0000-4000-8000-000000000000}',
      '00000000-0000-4000-8000-00000000000 ',
      ' ',
    ];
    for (const messageId of hostile) {
      const res = await authPut(`/api/topics/${sharedTopicId}/chat/read`, { messageId, readAt: now });
      expect(res.status, `messageId=${JSON.stringify(messageId)}`).toBe(400);
    }
  });

  it('11. LARGE + BOUNDARY: 10 KB and cap+1 message ids -> 400 naming the cap', async () => {
    const now = new Date().toISOString();
    const huge = await authPut(`/api/topics/${sharedTopicId}/chat/read`, {
      messageId: 'a'.repeat(10_000),
      readAt: now,
    });
    expect(huge.status).toBe(400);
    expect((await huge.json()).error).toMatch(/128 characters or fewer/);

    // Exactly cap+1 - the boundary itself, not just "something long".
    const capPlusOne = await authPut(`/api/topics/${sharedTopicId}/chat/read`, {
      messageId: 'a'.repeat(129),
      readAt: now,
    });
    expect(capPlusOne.status).toBe(400);
    expect((await capPlusOne.json()).error).toMatch(/128 characters or fewer/);

    // At the cap it is refused for being the wrong SHAPE, not for length -
    // proving the length check is a separate guard and not the only one.
    const atCap = await authPut(`/api/topics/${sharedTopicId}/chat/read`, {
      messageId: 'a'.repeat(128),
      readAt: now,
    });
    expect(atCap.status).toBe(400);
    expect((await atCap.json()).error).not.toMatch(/characters or fewer/);
  });

  it('12. EMPTY: absent, empty and unparsable readAt are each 400', async () => {
    const messageId = '00000000-0000-4000-8000-000000000000';
    for (const readAt of [undefined, null, '', '   ', 'not-a-date', 1700000000000]) {
      const res = await authPut(`/api/topics/${sharedTopicId}/chat/read`, { messageId, readAt });
      expect(res.status, `readAt=${JSON.stringify(readAt)}`).toBe(400);
    }
  });

  // -- Counting ------------------------------------------------------------

  it("13. INTEGRITY: B's messages count as unread for A, one per message", async () => {
    const first = await send(sharedTopicId, 'from B #1', secondUserPost);
    expect(await readState(sharedTopicId).then((s) => s.unreadCount)).toBe(1);

    await send(sharedTopicId, 'from B #2', secondUserPost);
    const third = await send(sharedTopicId, 'from B #3', secondUserPost);
    expect(await readState(sharedTopicId).then((s) => s.unreadCount)).toBe(3);
    expect(first.id).not.toBe(third.id);
  });

  it('14. INTEGRITY: marking read at the newest drives the count to 0', async () => {
    const newest = await newestMessage(sharedTopicId);
    const res = await markRead(sharedTopicId, newest.id, newest.createdAt);
    expect(res.status).toBe(200);
    const state: ReadState = await res.json();
    expect(state.unreadCount).toBe(0);
    expect(state.lastReadMessageId).toBe(newest.id);
    expect(new Date(state.lastReadAt as string).getTime()).toBe(new Date(newest.createdAt).getTime());

    // BOUNDARY: the cursor is INCLUSIVE - the message at exactly this instant
    // is read, not still unread.
    expect(await readState(sharedTopicId).then((s) => s.unreadCount)).toBe(0);
  });

  it('15. RACE: an OLDER mark is accepted and ignored - the cursor never rewinds', async () => {
    const before = await readState(sharedTopicId);
    const history = await authGet(`/api/topics/${sharedTopicId}/chat?limit=50`);
    const messages = (await history.json()).messages as Array<{ id: string; createdAt: string }>;
    const oldest = messages[messages.length - 1];
    expect(oldest.id).not.toBe(before.lastReadMessageId);

    const res = await markRead(sharedTopicId, oldest.id, oldest.createdAt);
    expect(res.status, 'a rewind is not an error, it is a no-op').toBe(200);
    const after: ReadState = await res.json();
    expect(after.lastReadAt).toBe(before.lastReadAt);
    // The id must follow the timestamp, never drift onto a message the cursor
    // is no longer at.
    expect(after.lastReadMessageId).toBe(before.lastReadMessageId);
    expect(after.unreadCount).toBe(0);
  });

  it('16. HOSTILE: a far-future readAt is clamped, and never outruns the row', async () => {
    /*
     * Two paths, because the clamp only ever fires on one of them.
     *
     * A real message takes its instant from its own ROW, so the request's
     * timestamp is not consulted at all - a caller cannot walk the cursor past
     * the message they named.
     */
    const newest = await newestMessage(sharedTopicId);
    const res = await markRead(sharedTopicId, newest.id, '9999-01-01T00:00:00.000Z');
    expect(res.status).toBe(200);
    const state: ReadState = await res.json();
    expect(new Date(state.lastReadAt as string).getUTCFullYear()).toBeLessThan(9000);
    expect(new Date(state.lastReadAt as string).getTime()).toBeLessThan(Date.now() + 60_000);

    /*
     * A message the server has never stored falls back to the request's value -
     * and THAT is the path the clamp guards. A room of its own, so a clamped
     * "now" cannot mark the shared room's real messages read.
     */
    const fresh = await createTopic('E2E Read Clamp');
    const future = await markRead(fresh, '00000000-0000-4000-8000-0000000000ff', '9999-01-01T00:00:00.000Z');
    expect(future.status).toBe(200);
    const clamped: ReadState = await future.json();
    expect(clamped.lastReadAt).toBeTruthy();
    expect(
      new Date(clamped.lastReadAt as string).getUTCFullYear(),
      'a caller must not be able to park the cursor in the year 9999',
    ).toBeLessThan(9000);
    expect(new Date(clamped.lastReadAt as string).getTime()).toBeLessThan(Date.now() + 60_000);
  });

  it('16b. AUTHZ: a messageId from ANOTHER topic is refused', async () => {
    // Naming a room you may not be in must not move a cursor in a room you are.
    const elsewhere = await newestMessage(sharedTopicId);
    const fresh = await createTopic('E2E Read Foreign');
    const res = await markRead(fresh, elsewhere.id, elsewhere.createdAt);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/not a message in this topic/i);
    expect((await readState(fresh)).lastReadAt).toBeNull();
  });

  it('17. CONTRACT: my OWN messages never count, and neither does anything under one', async () => {
    // Sending is being in the room. Before this rule a room whose newest rows
    // were mine still badged the older ones underneath them.
    const fresh = await createTopic('E2E Read Own');
    const join = await secondUserPost(`/api/topics/${fresh}/join`, {});
    expect(join.status, 'join returns 201 Created').toBe(201);

    await send(fresh, 'B speaks first', secondUserPost);
    await send(fresh, 'B again', secondUserPost);
    expect(await readState(fresh).then((s) => s.unreadCount)).toBe(2);

    await send(fresh, 'A replies'); // my own message, newer than both
    expect(
      await readState(fresh).then((s) => s.unreadCount),
      'my own message is itself a read mark',
    ).toBe(0);

    // ...and a later message from B counts again, so the rule is a threshold
    // and not a permanent mute.
    await send(fresh, 'B after my reply', secondUserPost);
    expect(await readState(fresh).then((s) => s.unreadCount)).toBe(1);
  });

  it('18. CONTRACT: the route never asks whether the message was readable', async () => {
    /*
     * The undecryptable-row rule, at the layer that can actually be tested over
     * HTTP. A locked row is a CLIENT-side judgement - the server holds opaque
     * bytes and cannot tell a decryptable message from an undecryptable one -
     * so the server-side half of the rule is that it never tries: any stored
     * message id in this topic is accepted, including one whose body this
     * caller has no key for.
     *
     * The client half (that `readMarkOf` does NOT skip a row flagged
     * `undecryptable`, unlike `chatDeliveryAck.claimable` which does) is pinned
     * in `src/__tests__/chatReadSync.test.ts`.
     */
    const fresh = await createTopic('E2E Read Locked');
    const join = await secondUserPost(`/api/topics/${fresh}/join`, {});
    expect(join.status, 'join returns 201 Created').toBe(201);

    const locked = await send(fresh, 'sealed by someone else', secondUserPost);
    const res = await markRead(fresh, locked.id, locked.createdAt);
    expect(res.status, 'refusing here would strand the badge forever').toBe(200);
    expect((await res.json()).unreadCount).toBe(0);
  });

  it.skipIf(envGate('DATABASE_URL'))(
    '19. CONTRACT: system join/leave rows are never counted',
    async () => {
      // No HTTP route persists a system row any more, so this is the only way
      // to produce one. The rule still ships in the count SQL (type='message')
      // and a row like this is exactly what would break a badge.
      const fresh = await createTopic('E2E Read System');
      const join = await secondUserPost(`/api/topics/${fresh}/join`, {});
      expect(join.status, 'join returns 201 Created').toBe(201);
      const { userId: bId } = await getSecondUserToken();

      expect(await readState(fresh).then((s) => s.unreadCount)).toBe(0);

      await db().query(
        `INSERT INTO chat_messages (topic_id, user_id, system_text, type, created_at)
         VALUES ($1, $2, 'joined', 'join', now())`,
        [fresh, bId],
      );

      expect(
        await readState(fresh).then((s) => s.unreadCount),
        'a join notice is public furniture, not something to be unread about',
      ).toBe(0);

      // ...and it does not HIDE a real message that lands after it either.
      await send(fresh, 'a real one', secondUserPost);
      expect(await readState(fresh).then((s) => s.unreadCount)).toBe(1);
    },
  );

  // -- Cross-device / cross-user -------------------------------------------

  it('20. INTEGRITY: a SECOND session of the same account sees the same cursor', async () => {
    /*
     * The whole point of moving this server-side. Two JWTs for one account are
     * two devices as far as anything downstream is concerned - reading on one
     * must clear the badge on the other.
     */
    const fresh = await createTopic('E2E Read Devices');
    const join = await secondUserPost(`/api/topics/${fresh}/join`, {});
    expect(join.status, 'join returns 201 Created').toBe(201);
    const m1 = await send(fresh, 'unread on both devices', secondUserPost);

    const refreshed = await fetch(`${getBaseUrl()}/api/auth/refresh`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${getAuthToken()}` },
    });
    expect(refreshed.status).toBe(200);
    const secondDevice = (await refreshed.json()).token as string;
    expect(secondDevice).toBeTruthy();

    const asDeviceTwo = (path: string) =>
      fetch(`${getBaseUrl()}${path}`, { headers: { Authorization: `Bearer ${secondDevice}` } });

    const beforeTwo = await asDeviceTwo(`/api/topics/${fresh}/chat/read`);
    expect(beforeTwo.status).toBe(200);
    expect((await beforeTwo.json()).unreadCount).toBe(1);

    // Device one reads it.
    expect((await markRead(fresh, m1.id, m1.createdAt)).status).toBe(200);

    const afterTwo = await asDeviceTwo(`/api/topics/${fresh}/chat/read`);
    const state: ReadState = await afterTwo.json();
    expect(state.unreadCount, 'reading on one device must clear the badge on the other').toBe(0);
    expect(state.lastReadMessageId).toBe(m1.id);
  });

  it("21. AUTHZ: one member cannot move - or see - another member's cursor", async () => {
    const fresh = await createTopic('E2E Read Isolation');
    const join = await secondUserPost(`/api/topics/${fresh}/join`, {});
    expect(join.status, 'join returns 201 Created').toBe(201);
    const mine = await send(fresh, 'A speaks', authPost);
    const theirs = await send(fresh, 'B speaks', secondUserPost);

    // A has read nothing; B reads everything.
    const bRead = await secondUserPut(`/api/topics/${fresh}/chat/read`, {
      messageId: theirs.id,
      readAt: theirs.createdAt,
    });
    expect(bRead.status).toBe(200);
    expect((await bRead.json()).unreadCount, "B has read A's message").toBe(0);

    // A's cursor is untouched, and A still has B's message unread.
    const aState = await readState(fresh);
    expect(aState.lastReadAt, "B's read must not have written A's cursor").toBeNull();
    expect(aState.unreadCount).toBe(1);

    /*
     * ...and no body field can redirect the write. The account comes from the
     * SESSION and the body is never consulted for it, so these are ignored
     * rather than honoured - asserted by A's cursor still being untouched.
     */
    const spoof = await secondUserPut(`/api/topics/${fresh}/chat/read`, {
      messageId: mine.id,
      readAt: mine.createdAt,
      userId: getUserId(),
      user_id: getUserId(),
    });
    expect(spoof.status).toBe(200);
    expect(
      (await readState(fresh)).lastReadAt,
      "a body field must not name someone else's cursor",
    ).toBeNull();
  });

  // -- The list surfaces both clients actually read ------------------------

  it('22. CONTRACT: GET /api/topics carries the cursor and the count per room', async () => {
    const fresh = await createTopic('E2E Read List');
    const join = await secondUserPost(`/api/topics/${fresh}/join`, {});
    expect(join.status, 'join returns 201 Created').toBe(201);
    await send(fresh, 'badge me', secondUserPost);

    const unread = await topicRow(fresh);
    expect(unread, 'the joined-topics list must include the room').toBeTruthy();
    expect(unread?.unreadCount).toBe(1);
    expect(unread?.lastReadAt).toBeNull();
    expect(unread?.lastReadMessageId).toBeNull();

    const newest = await newestMessage(fresh);
    expect((await markRead(fresh, newest.id, newest.createdAt)).status).toBe(200);

    const read = await topicRow(fresh);
    expect(read?.unreadCount).toBe(0);
    expect(read?.lastReadMessageId).toBe(newest.id);
    expect(read?.lastReadAt).toBeTruthy();
  });

  it('23. CONTRACT: GET /api/dm carries the same fields for a DM channel', async () => {
    const { userId: peerId } = await getSecondUserToken();
    const created = await authPost('/api/dm', { userId: peerId });
    expect([200, 201]).toContain(created.status);
    const dmTopicId = (await created.json()).topicId as string;
    expect(dmTopicId).toBeTruthy();

    await send(dmTopicId, 'dm from B', secondUserPost);

    const list = await authGet('/api/dm');
    expect(list.status).toBe(200);
    const row = ((await list.json()).dms as Array<Record<string, unknown>>).find(
      (d) => d.topicId === dmTopicId,
    );
    expect(row, "the DM must appear in the caller's list").toBeTruthy();
    expect(row?.unreadCount).toBe(1);
    expect(row?.lastReadAt).toBeNull();

    const newest = await newestMessage(dmTopicId);
    expect((await markRead(dmTopicId, newest.id, newest.createdAt)).status).toBe(200);

    const after = await authGet('/api/dm');
    const readRow = ((await after.json()).dms as Array<Record<string, unknown>>).find(
      (d) => d.topicId === dmTopicId,
    );
    expect(readRow?.unreadCount).toBe(0);
    expect(readRow?.lastReadAt).toBeTruthy();
  });

  it('24. BOUNDARY: a room nobody has spoken in reports 0, not an error', async () => {
    // The `IN ()` guard's sibling: a room that exists and has never been spoken
    // in must report zero rather than failing the whole list.
    const silent = await createTopic('E2E Read Silent');
    const row = await topicRow(silent);
    expect(row?.unreadCount).toBe(0);
    expect(row?.lastReadAt).toBeNull();
  });
});
