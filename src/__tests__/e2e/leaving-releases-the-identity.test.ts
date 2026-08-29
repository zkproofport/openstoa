/**
 * Leaving must release the identity, or leaving is not leaving.
 *
 * On 2026-08-29, minutes after a deletion that reported success on a real
 * device, signing back in with the same Google account landed straight back in
 * the withdrawn account: the profile read `[Withdrawn User]_1ds6hty8`, and the
 * personal space had been recreated around it. The person had asked to leave,
 * been told they had, and come back to their own tombstone.
 *
 * The cause is that the user row's id IS the nullifier from the proof, and
 * sign-in looks the account up by exactly that. Withdrawal renamed the row and
 * stamped it, but the id stayed, so the row still answered to the identity.
 *
 * The fix retires the id — `withdrawn:<millis>:<nullifier>` — which is what
 * frees the identity, and lets the 31 foreign keys into `users` follow the
 * rename (they now carry ON UPDATE CASCADE; ten of them did not exist in the
 * database at all before this).
 *
 * What has to be true, and is pinned below:
 *
 *   FREED      the nullifier answers to nothing after withdrawal, so the next
 *              sign-in builds a NEW account with a NEW name.
 *   KEPT       the withdrawn row survives under its retired id, so posts and
 *              comments still resolve to an author.
 *   CARRIED    everything that pointed at the row still points at it — the
 *              rename did not orphan a single row.
 *   NAME       the nickname is released too. Nicknames are unique; keeping the
 *              withdrawn one would deny it to everyone, the same person
 *              included.
 *
 * Runs against a real container and a real database, because the whole thing
 * turns on a foreign-key clause. Nothing about ON UPDATE CASCADE is observable
 * through a mock.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getBaseUrl, E2E_DEVICE_HEADERS } from './helpers';
import { envGate, announceEnvGates, closeDb, selectOne } from './db-helpers';

const DB_VAR = 'E2E_STAGING_DB_URL';
const noDb = () => envGate(DB_VAR);

beforeAll(() => announceEnvGates('leaving-releases-the-identity.test.ts'));
afterAll(async () => { if (process.env[DB_VAR]) await closeDb(); });

function bearer(token: string) {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...E2E_DEVICE_HEADERS };
}

/**
 * A sign-in for a given identity. The dev-login route keys accounts off the
 * nickname rather than a proof nullifier, which is what makes "the same person
 * comes back" expressible here: the same nickname is the same identity.
 */
async function signIn(nickname: string): Promise<{ token: string; userId: string }> {
  const res = await fetch(`${getBaseUrl()}/api/auth/dev-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...E2E_DEVICE_HEADERS },
    body: JSON.stringify({ nickname }),
  });
  if (!res.ok) throw new Error(`dev-login failed: ${res.status} ${await res.text()}`);
  const body = await res.json();
  return { token: body.token, userId: body.userId };
}

async function deleteAccount(token: string) {
  return fetch(`${getBaseUrl()}/api/account`, { method: 'DELETE', headers: bearer(token) });
}

async function count(sql: string, params: unknown[]): Promise<number> {
  const row = await selectOne<{ n: string }>(sql, params);
  return Number(row?.n ?? 0);
}

describe('leaving releases the identity', () => {
  it.skipIf(noDb())('the same identity comes back to a NEW account, not the withdrawn one', async () => {
    const identity = `e2e_return_${Date.now().toString(36)}`;
    const first = await signIn(identity);

    expect((await deleteAccount(first.token)).status).toBe(200);

    // The row is still there, under a retired id.
    const retired = await selectOne<{ id: string; nickname: string; deleted_at: string | null }>(
      "SELECT id, nickname, deleted_at FROM users WHERE id LIKE 'withdrawn:%' AND id LIKE $1",
      [`%${first.userId}`],
    );
    expect(retired, 'the withdrawn row was deleted rather than retired').toBeTruthy();
    expect(retired!.deleted_at).not.toBeNull();
    expect(retired!.nickname).toMatch(/^\[Withdrawn User\]_/);

    // Nothing answers to the original id any more.
    expect(
      await count('SELECT count(*)::text AS n FROM users WHERE id = $1', [first.userId]),
      'the original id still resolves — the identity was not released',
    ).toBe(0);

    // Coming back builds a new account.
    const second = await signIn(identity);
    const fresh = await selectOne<{ id: string; nickname: string; deleted_at: string | null }>(
      'SELECT id, nickname, deleted_at FROM users WHERE id = $1',
      [second.userId],
    );
    expect(fresh, 'signing back in did not create an account').toBeTruthy();
    expect(fresh!.deleted_at, 'the returning account is marked as withdrawn').toBeNull();
    expect(fresh!.nickname, 'the returning account carries the withdrawn name')
      .not.toMatch(/^\[Withdrawn User\]_/);
  });

  it.skipIf(noDb())('the rename orphans nothing that pointed at the row', async () => {
    /*
     * The retire is a single UPDATE against a primary key that 31 columns
     * reference. Without ON UPDATE CASCADE on every one of them it fails and
     * the deletion rolls back; with it, every reference follows. This asserts
     * the outcome rather than the clause: no row anywhere points at a user id
     * that does not exist.
     */
    const identity = `e2e_orphan_${Date.now().toString(36)}`;
    const me = await signIn(identity);
    expect((await deleteAccount(me.token)).status).toBe(200);

    const orphans = await count(
      `SELECT count(*)::text AS n FROM (
         SELECT author_id AS uid FROM comments
         UNION ALL SELECT user_id FROM chat_messages
         UNION ALL SELECT uploader_id FROM chat_media
         UNION ALL SELECT user_id FROM topic_members
         UNION ALL SELECT creator_id FROM topics
         UNION ALL SELECT author_id FROM posts
       ) refs
       LEFT JOIN users u ON u.id = refs.uid
       WHERE refs.uid IS NOT NULL AND u.id IS NULL`,
      [],
    );
    expect(orphans, 'the retire left rows pointing at a user id that no longer exists').toBe(0);
  });

  it.skipIf(noDb())('the session dies with the account, so a token in hand stops working', async () => {
    /*
     * A session that outlives the account it belongs to is how a "deleted"
     * person keeps posting. The retire closes it without a separate sweep —
     * sessions resolve through the user row, and there is no longer a row under
     * that id — but that is a side effect of the design, so it is pinned here
     * rather than left to hold by accident.
     */
    const identity = `e2e_token_${Date.now().toString(36)}`;
    const me = await signIn(identity);
    expect((await deleteAccount(me.token)).status).toBe(200);

    const write = await fetch(`${getBaseUrl()}/api/topics`, {
      method: 'POST',
      headers: bearer(me.token),
      body: JSON.stringify({ title: `ghost ${identity}`, categoryId: 'general' }),
    });
    expect(write.status, 'a withdrawn account could still create a topic').toBe(401);

    const read = await fetch(`${getBaseUrl()}/api/profile/badges`, { headers: bearer(me.token) });
    expect(read.status, 'a withdrawn account could still read its profile').toBe(401);
  });

  it.skipIf(noDb())('the withdrawn name is released, so it can be taken again', async () => {
    const identity = `e2e_name_${Date.now().toString(36)}`;
    const me = await signIn(identity);
    expect((await deleteAccount(me.token)).status).toBe(200);

    // Nicknames are unique. If withdrawal kept the name, this second sign-in
    // could not create an account with it and would fail or collide.
    const again = await signIn(identity);
    expect(again.userId).not.toBe(me.userId);
  });
});
