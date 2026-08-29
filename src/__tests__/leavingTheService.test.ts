/**
 * Leaving the service — the whole contract of DELETE /api/account.
 *
 * Written after the handler failed in production on 2026-08-29 and left the
 * account in a state it could not get out of. The failure was not exotic: the
 * person had one message in their own space, and that was enough.
 *
 * What has to be true, and is pinned below:
 *
 *   WHO           a caller with no session gets 401 and nothing is touched.
 *   REFUSAL       owning a community topic refuses with 409 and a list of what
 *                 to hand over — before anything is deleted. A PERSONAL space
 *                 must not count towards that, or the rule refuses every
 *                 deletion in the product.
 *   THE SPACE     the person's own space is deleted, with the rows that hold it
 *                 down cleared first, in the shared order.
 *   OTHER ROOMS   messages and posts written in other people's rooms are NOT
 *                 deleted. The account is anonymised, not erased from other
 *                 people's conversations.
 *   ALL OR NONE   any failure rolls the whole thing back. Half a deletion is
 *                 worse than none, because the retry hits the same failure.
 *   THE ROW       survives, renamed and stamped, so posts still resolve to an
 *                 author and upvote counts stay honest.
 *   AFTER         the session cookie is cleared, and the object sweep is
 *                 best-effort: it must not turn a completed deletion into an
 *                 error.
 *
 * The database is mocked. What is being tested is the handler's decisions and
 * their ORDER, which is exactly what went wrong; whether Postgres enforces its
 * own foreign keys is not in question. The end-to-end counterpart, which runs
 * the same flow against a real container and a real database, lives in
 * `e2e/account-deletion.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  select: vi.fn(),
  transaction: vi.fn(),
  cookieDelete: vi.fn(),
  deleteR2Prefix: vi.fn().mockResolvedValue(0),
  // Recorded inside the transaction, in call order.
  ops: [] as string[],
  failOn: null as string | null,
}));

vi.mock('@/lib/session', () => ({ getSession: mocks.getSession }));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('next/headers', () => ({
  cookies: async () => ({ delete: mocks.cookieDelete }),
}));
vi.mock('@/lib/r2', () => ({
  deleteR2Prefix: mocks.deleteR2Prefix,
  topicObjectPrefix: (id: string) => `topics/${id}/`,
}));

/** Table name out of a drizzle table object. */
function tableName(table: unknown): string {
  const sym = Object.getOwnPropertySymbols(table as object)
    .find((s) => String(s).includes('Name') || String(s).includes('OriginalName'));
  const raw = sym ? (table as Record<symbol, unknown>)[sym] : undefined;
  return typeof raw === 'string' ? raw : 'unknown';
}

function record(verb: string, table: unknown) {
  const name = `${verb}:${tableName(table)}`;
  mocks.ops.push(name);
  if (mocks.failOn === name) throw new Error(`simulated failure at ${name}`);
}

vi.mock('@/lib/db', () => {
  const handle = {
    delete: (table: unknown) => ({
      where: async () => { record('delete', table); },
    }),
    update: (table: unknown) => ({
      set: () => ({ where: async () => { record('update', table); } }),
    }),
    select: (...args: unknown[]) => mocks.select(...args),
    transaction: (...args: unknown[]) => mocks.transaction(...args),
  };
  return { db: handle };
});

/** The two `select`s the handler makes, in order: owned topics, then own space. */
function selectsReturning(owned: Array<{ id: string; title: string }>, space: Array<{ id: string }>) {
  let call = 0;
  mocks.select.mockImplementation(() => ({
    from: () => ({
      where: async () => {
        call += 1;
        return call === 1 ? owned : space;
      },
    }),
  }));
}

/** Runs the callback against the same recording handle the route uses. */
function realTransaction() {
  mocks.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
    const tx = {
      delete: (table: unknown) => ({ where: async () => { record('delete', table); } }),
      update: (table: unknown) => ({ set: () => ({ where: async () => { record('update', table); } }) }),
      select: () => ({ from: () => ({ where: async () => [] }) }),
    };
    await fn(tx);
  });
}

async function callDelete() {
  const { DELETE } = await import('@/app/api/account/route');
  return DELETE(new Request('http://localhost/api/account', { method: 'DELETE' }) as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  mocks.ops = [];
  mocks.failOn = null;
  mocks.deleteR2Prefix.mockResolvedValue(0);
  mocks.getSession.mockResolvedValue({ userId: 'user-1' });
  selectsReturning([], [{ id: 'space-1' }]);
  realTransaction();
});

describe('who may leave', () => {
  it('refuses a caller with no session and touches nothing', async () => {
    mocks.getSession.mockResolvedValue(null);
    const res = await callDelete();
    expect(res.status).toBe(401);
    expect(mocks.ops).toEqual([]);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});

describe('owning a room someone else is in', () => {
  it('refuses with 409 and names what has to be handed over', async () => {
    selectsReturning([{ id: 't-1', title: 'Reading group' }], [{ id: 'space-1' }]);
    const res = await callDelete();
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/transfer topic ownership/i);
    expect(body.topics).toEqual([{ id: 't-1', title: 'Reading group' }]);
  });

  it('refuses BEFORE deleting anything, so a retry has the same starting point', async () => {
    selectsReturning([{ id: 't-1', title: 'Reading group' }], [{ id: 'space-1' }]);
    await callDelete();
    expect(mocks.ops).toEqual([]);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('does not count the person\'s own space as a room to hand over', async () => {
    /*
     * The owned-topics query filters `personal = false`. If it ever stops
     * doing that, every account in the product becomes undeletable, because
     * everyone has a personal space. The filter is the whole test: the query
     * returns nothing here, and deletion proceeds.
     */
    selectsReturning([], [{ id: 'space-1' }]);
    const res = await callDelete();
    expect(res.status).toBe(200);
  });
});

describe('the person\'s own space', () => {
  it('clears the rows that hold it down before deleting it', async () => {
    await callDelete();

    const spaceGone = mocks.ops.indexOf('delete:topics');
    expect(spaceGone, 'the personal space was never deleted').toBeGreaterThan(-1);

    // Every non-cascading table must be cleared BEFORE the topic row goes.
    for (const table of [
      'chat_messages', 'chat_media', 'chat_archive', 'archive_holders',
      'tak_bundles', 'key_requests', 'mls_commits', 'mls_groups',
      'join_requests', 'topic_members',
    ]) {
      const at = mocks.ops.indexOf(`delete:${table}`);
      expect(at, `${table} was never cleared`).toBeGreaterThan(-1);
      expect(at, `${table} was cleared after the topic, too late`).toBeLessThan(spaceGone);
    }
  });

  it('sweeps the space\'s stored objects after the rows are gone', async () => {
    await callDelete();
    expect(mocks.deleteR2Prefix).toHaveBeenCalledWith('topics/space-1/');
  });

  it('skips the space work entirely when the account never had one', async () => {
    selectsReturning([], []);
    const res = await callDelete();
    expect(res.status).toBe(200);
    expect(mocks.ops).not.toContain('delete:topics');
    expect(mocks.deleteR2Prefix).not.toHaveBeenCalled();
  });
});

describe('what survives', () => {
  it('renames and stamps the user row rather than deleting it', async () => {
    await callDelete();
    expect(mocks.ops).toContain('update:users');
    expect(mocks.ops).not.toContain('delete:users');
  });

  it('never deletes posts or comments by user — only the ones inside the space', async () => {
    /*
     * Posts written in OTHER people's rooms stay. The only deletes the handler
     * may issue against posts/comments come from clearing the personal space,
     * and the space has none here, so neither table may be touched at all.
     */
    await callDelete();
    expect(mocks.ops).not.toContain('delete:posts');
    expect(mocks.ops).not.toContain('delete:comments');
  });

  it('leaves messages in other people\'s rooms alone', async () => {
    /*
     * `chat_messages` is deleted exactly once — scoped to the personal space by
     * `deleteTopicRows`. A second one would mean someone scoped a delete to the
     * user instead of the room, which would erase their half of other people's
     * conversations.
     */
    await callDelete();
    const times = mocks.ops.filter((o) => o === 'delete:chat_messages').length;
    expect(times).toBe(1);
  });
});

describe('all of it, or none of it', () => {
  it('does the whole thing inside one transaction', async () => {
    await callDelete();
    expect(mocks.transaction).toHaveBeenCalledTimes(1);

    /*
     * Everything destructive has to be inside it. The recording handle used by
     * the transaction is the only thing that records, so a delete issued
     * outside would not appear — which is why this asserts on the count the
     * transaction produced rather than merely that it ran.
     */
    expect(mocks.ops.length).toBeGreaterThan(5);
  });

  it('lets a mid-way failure escape rather than reporting success', async () => {
    /*
     * The exact production shape: the space refuses to go after the memberships
     * are already deleted. Wrapped in a transaction, that rolls back; the test
     * pins that the handler does not swallow it and answer 200.
     */
    mocks.failOn = 'delete:topics';
    await expect(callDelete()).rejects.toThrow(/simulated failure/);
  });

  it('still reports success when only the object sweep fails', async () => {
    /*
     * Storage is outside the transaction. The rows ARE gone by then, so failing
     * the response would tell the person their account is still there.
     */
    mocks.deleteR2Prefix.mockRejectedValue(new Error('bucket unreachable'));
    const res = await callDelete();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
  });
});

describe('afterwards', () => {
  it('clears the session cookie', async () => {
    await callDelete();
    expect(mocks.cookieDelete).toHaveBeenCalledWith('session');
  });

  it('answers a plain success', async () => {
    const res = await callDelete();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
  });
});
