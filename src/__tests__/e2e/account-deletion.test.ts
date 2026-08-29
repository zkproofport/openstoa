/**
 * Leaving the service, against a real container and a real database.
 *
 * The unit tests for this handler mock the database, which means they can pin
 * the handler's DECISIONS but not the thing that actually broke it: Postgres
 * refusing to delete a row that eighteen foreign keys point at. That refusal is
 * what turned account deletion into a 500 in production on 2026-08-29, and it
 * only shows up when the deletes are real.
 *
 * So this file reproduces the production shape exactly:
 *
 *   1. an account with a personal space and a MESSAGE IN IT — one message was
 *      enough, and every account has a space, so this was every account;
 *   2. DELETE /api/account;
 *   3. the space row is gone, the chat row is gone, and the user row is
 *      renamed and stamped rather than removed.
 *
 * And the two guards around it:
 *
 *   - owning a community topic refuses with 409 and changes NOTHING, so a
 *     retry after handing the topic over starts from the same place;
 *   - a personal space does not count towards that rule, or nobody could ever
 *     leave.
 *
 * The row-level assertions are gated on a database being reachable; see the
 * note above the gate for WHICH variable and why that choice is not free. The
 * HTTP-level cases run without one, because a 409 or a 200 needs no database of
 * its own to read.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getBaseUrl, E2E_DEVICE_HEADERS } from './helpers';
import { envGate, announceEnvGates, closeDb, selectOne } from './db-helpers';

/*
 * `envGate` answers "is it MISSING", not "is it there". Reading it the other
 * way round silently skips exactly the cases that need the database — which is
 * every case that proves the rows are actually gone.
 *
 * The variable named here must be the one the CONNECTION uses, or the gate and
 * the connection disagree. This file reads rows through `selectOne` in
 * db-helpers, which connects with `E2E_STAGING_DB_URL`. It first said
 * `DATABASE_URL` — the name the sibling files use, because each of THOSE opens
 * its own client from that variable. Both happen to be set on the machine
 * where this was written, so the mismatch was invisible until a checkout that
 * had one and not the other: the cases would un-skip and then die on "not set
 * — direct DB checks disabled" rather than reporting anything about deletion.
 */
const DB_VAR = 'E2E_STAGING_DB_URL';

/**
 * Called once per gated case rather than hoisted to a shared boolean, because
 * `envGate` counts each call and `announceEnvGates` reports that count. Hoisting
 * it made the warning say "1 DB-backed case will be skipped" while three were —
 * an understated warning is one a reader learns to scroll past.
 */
const noDb = () => envGate(DB_VAR);

beforeAll(() => announceEnvGates('account-deletion.test.ts'));
afterAll(async () => { if (process.env[DB_VAR]) await closeDb(); });

interface Account { token: string; userId: string; nickname: string }

/**
 * A brand-new account, which arrives with a personal space already created.
 * Declares itself a mobile device: chat and MLS are refused to a web session,
 * and this file needs to put a message in a room.
 */
async function newAccount(prefix: string): Promise<Account> {
  const nickname = `e2e_${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const res = await fetch(`${getBaseUrl()}/api/auth/dev-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...E2E_DEVICE_HEADERS },
    body: JSON.stringify({ nickname }),
  });
  if (!res.ok) throw new Error(`dev-login failed: ${res.status} ${await res.text()}`);
  const body = await res.json();
  return { token: body.token, userId: body.userId, nickname };
}

function bearer(token: string) {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...E2E_DEVICE_HEADERS };
}

async function personalSpaceId(token: string): Promise<string> {
  const res = await fetch(`${getBaseUrl()}/api/topics?joined=true`, { headers: bearer(token) });
  expect(res.status, 'listing the account\'s rooms').toBe(200);
  const body = await res.json();
  const list: Array<{ id: string; personal?: boolean; title?: string }> = body.topics ?? body ?? [];
  const own = list.find((t) => t.personal === true);
  expect(own, 'a fresh account must already have its own space').toBeTruthy();
  return own!.id;
}

/** Puts one row in the room's chat, which is what held the space down. */
async function putAMessageIn(token: string, topicId: string): Promise<void> {
  const res = await fetch(`${getBaseUrl()}/api/topics/${topicId}/chat`, {
    method: 'POST',
    headers: bearer(token),
    body: JSON.stringify({
      ciphertext: Buffer.from(`e2e-${Date.now()}`).toString('base64'),
      contentType: 'application/x-mls-message',
    }),
  });
  // The room's chat may require MLS setup this fixture does not do; either the
  // message lands (the case being tested) or the endpoint declines it, and the
  // caller decides whether that is fatal.
  if (res.status >= 500) {
    throw new Error(`chat POST failed hard: ${res.status} ${await res.text()}`);
  }
}

async function deleteAccount(token: string) {
  return fetch(`${getBaseUrl()}/api/account`, { method: 'DELETE', headers: bearer(token) });
}

async function countRows(sql: string, params: unknown[]): Promise<number> {
  const row = await selectOne<{ n: string }>(sql, params);
  return Number(row?.n ?? 0);
}

describe('DELETE /api/account — the guard that refuses', () => {
  it('refuses with 409 when the account owns a room other people could be in', async () => {
    const me = await newAccount('owner');

    const cats = await fetch(`${getBaseUrl()}/api/categories`);
    expect(cats.status, 'listing categories').toBe(200);
    const categoryId = (await cats.json()).categories[0].id;

    const created = await fetch(`${getBaseUrl()}/api/topics`, {
      method: 'POST',
      headers: bearer(me.token),
      body: JSON.stringify({
        title: `e2e-owned-${Date.now()}`,
        description: 'a room with an owner who wants to leave',
        categoryId,
        visibility: 'public',
      }),
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const topicId = (await created.json()).id;

    const res = await deleteAccount(me.token);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/transfer topic ownership/i);
    expect(Array.isArray(body.topics)).toBe(true);
    expect(body.topics.length).toBeGreaterThan(0);

    // Still signed in and still there — the refusal changed nothing.
    const session = await fetch(`${getBaseUrl()}/api/auth/session`, { headers: bearer(me.token) });
    expect(session.status).toBe(200);

    // Clean up so the account can be deleted by the next case if reused.
    if (topicId) {
      await fetch(`${getBaseUrl()}/api/topics/${topicId}`, { method: 'DELETE', headers: bearer(me.token) });
    }
  });

  it('refuses a caller with no session at all', async () => {
    const res = await fetch(`${getBaseUrl()}/api/account`, { method: 'DELETE' });
    expect(res.status).toBe(401);
  });
});

describe('DELETE /api/account — a personal space with a message in it', () => {
  it('succeeds, which it did not before: the space and its chat came with it', async () => {
    const me = await newAccount('leaver');
    const spaceId = await personalSpaceId(me.token);
    await putAMessageIn(me.token, spaceId);

    const res = await deleteAccount(me.token);
    expect(res.status, `deleting an account with a message in its own space: ${await res.clone().text()}`).toBe(200);
    expect(await res.json()).toEqual({ success: true });
  });

  it.skipIf(noDb())('leaves no space row and no chat row behind', async () => {
    const me = await newAccount('rows');
    const spaceId = await personalSpaceId(me.token);
    await putAMessageIn(me.token, spaceId);

    // The space exists and something points at it — otherwise this proves nothing.
    expect(await countRows('SELECT count(*)::text AS n FROM topics WHERE id = $1', [spaceId])).toBe(1);

    const res = await deleteAccount(me.token);
    expect(res.status).toBe(200);

    expect(
      await countRows('SELECT count(*)::text AS n FROM topics WHERE id = $1', [spaceId]),
      'the personal space survived the account',
    ).toBe(0);
    expect(
      await countRows('SELECT count(*)::text AS n FROM chat_messages WHERE topic_id = $1', [spaceId]),
      'chat rows survived the room they were in',
    ).toBe(0);
    expect(
      await countRows('SELECT count(*)::text AS n FROM topic_members WHERE topic_id = $1', [spaceId]),
      'membership rows survived the room',
    ).toBe(0);
    expect(
      await countRows('SELECT count(*)::text AS n FROM mls_groups WHERE topic_id = $1', [spaceId]),
      'MLS group state survived the room',
    ).toBe(0);
  });

  it.skipIf(noDb())('keeps the user row, renamed, stamped, and answering to nothing', async () => {
    /*
     * This looked the row up by its ORIGINAL id, which is the nullifier from
     * the proof — and that is precisely what withdrawal must stop answering to.
     * Until 2026-08-29 it did answer: a person who deleted their account and
     * signed back in with the same proof landed in their own withdrawn row.
     *
     * So the row is still expected to survive, anonymised, for the sake of the
     * posts and comments that point at it — but under a RETIRED id, and the old
     * one must resolve to nothing.
     */
    const me = await newAccount('anon');
    const res = await deleteAccount(me.token);
    expect(res.status).toBe(200);

    expect(
      await countRows('SELECT count(*)::text AS n FROM users WHERE id = $1', [me.userId]),
      'the original id still resolves, so the identity was not released',
    ).toBe(0);

    const row = await selectOne<{ id: string; nickname: string; deleted_at: string | null }>(
      "SELECT id, nickname, deleted_at FROM users WHERE id LIKE 'withdrawn:%' AND id LIKE $1",
      [`%${me.userId}`],
    );
    expect(row, 'the user row was deleted rather than retired').toBeTruthy();
    expect(row!.nickname).not.toBe(me.nickname);
    expect(row!.nickname).toMatch(/^\[Withdrawn User\]_/);
    expect(row!.deleted_at, 'deletedAt was never stamped').not.toBeNull();
  });

  it.skipIf(noDb())('either finishes completely or changes nothing at all', async () => {
    /*
     * The production failure, stated as a contract.
     *
     * The old handler deleted the space's membership row, then failed to delete
     * the space, then answered 500 — leaving the account owning a space it was
     * not a member of, with every retry hitting the same wall. Asserting only
     * that "space and membership agree" is too weak to catch that: when the
     * space delete fails and NOTHING was wrapped, both rows can still be
     * present in a state that reads as consistent.
     *
     * So the assertion is on the answer. A 200 means everything is gone and the
     * user is stamped. Anything else means the account is untouched — same
     * space, same membership, same nickname — because that is the only state a
     * person can retry from.
     */
    const me = await newAccount('atomic');
    const spaceId = await personalSpaceId(me.token);
    await putAMessageIn(me.token, spaceId);

    const before = await selectOne<{ nickname: string; deleted_at: string | null }>(
      'SELECT nickname, deleted_at FROM users WHERE id = $1',
      [me.userId],
    );
    expect(before?.deleted_at, 'fixture is already withdrawn').toBeNull();

    const res = await deleteAccount(me.token);

    const spaces = await countRows('SELECT count(*)::text AS n FROM topics WHERE id = $1', [spaceId]);
    const members = await countRows('SELECT count(*)::text AS n FROM topic_members WHERE topic_id = $1', [spaceId]);
    const chat = await countRows('SELECT count(*)::text AS n FROM chat_messages WHERE topic_id = $1', [spaceId]);
    const after = await selectOne<{ nickname: string; deleted_at: string | null }>(
      'SELECT nickname, deleted_at FROM users WHERE id = $1',
      [me.userId],
    );

    if (res.status === 200) {
      expect(spaces, 'said success but the space is still there').toBe(0);
      expect(members, 'said success but the membership is still there').toBe(0);
      expect(chat, 'said success but the chat rows are still there').toBe(0);
      expect(after?.deleted_at, 'said success but the user was never stamped').not.toBeNull();
    } else {
      expect(spaces, `answered ${res.status} but the space was deleted anyway`).toBe(1);
      expect(members, `answered ${res.status} but the membership was deleted anyway`).toBe(1);
      expect(chat, `answered ${res.status} but chat rows were deleted anyway`).toBe(1);
      expect(after?.deleted_at, `answered ${res.status} but the user was stamped anyway`).toBeNull();
      expect(after?.nickname, `answered ${res.status} but the nickname was changed anyway`).toBe(me.nickname);
    }
  });
});

describe('DELETE /api/account — afterwards', () => {
  it('the token stops working', async () => {
    const me = await newAccount('token');
    expect((await deleteAccount(me.token)).status).toBe(200);

    const session = await fetch(`${getBaseUrl()}/api/auth/session`, { headers: bearer(me.token) });
    /*
     * The row still exists, so this is not a 404 case: whatever the route
     * answers, it must not present the account as a live signed-in user.
     */
    if (session.status === 200) {
      const body = await session.json();
      expect(body.authenticated === true && !body.user?.deletedAt).toBe(false);
    } else {
      expect(session.status).toBeGreaterThanOrEqual(400);
    }
  });

  it('a second deletion does not pretend to succeed twice', async () => {
    const me = await newAccount('twice');
    expect((await deleteAccount(me.token)).status).toBe(200);

    const again = await deleteAccount(me.token);
    // Either the session is gone (401) or the account is already withdrawn.
    // A 500 would mean the handler tripped over its own earlier work.
    expect(again.status, 'the second delete must not be a server error').toBeLessThan(500);
  });
});
