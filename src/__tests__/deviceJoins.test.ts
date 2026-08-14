/**
 * What a Commit says about the device it added, and what gets written down.
 *
 * The interesting half is the reading, and it is testable without a database:
 * every case here runs against a REAL commit produced by the same MLS core the
 * clients use, because the claim is about a wire format rather than about SQL.
 * The write is exercised through a recording executor — enough to pin the
 * statement's shape and its parameters; the statement's behaviour against real
 * Postgres belongs with the other DB-backed suites and is noted at the bottom.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage in this file
 *   contract          → a join Commit yields device + credential + the NEW epoch
 *   integrity         → the epoch recorded is the one that ADMITS the device,
 *                       not the one the Commit asserted
 *   integrity         → `user_id` comes from `userIdOfLeaf`, so the credential
 *                       shape is known in exactly one place
 *   empty/null/undef  → an unattributable credential yields a null account and
 *                       KEEPS the raw identity, so null means "nobody could name
 *                       it" rather than "not looked up"
 *   hostile           → an ordinary Commit, junk, and an empty buffer each
 *                       record NOTHING rather than a guess
 *   boundary          → a re-join is a DIFFERENT device id, so a new row
 *   race / ext-failure→ a rejected insert never throws at the caller
 *   authorization     → N/A here: the route records only ACCEPTED commits, and
 *                       that gate is the CAS above it
 */
import { describe, it, expect, vi } from 'vitest';

const loggerMock = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('@/lib/logger', () => ({ logger: loggerMock }));
import * as gc from '@/lib/mls/groupClient';
import { readDeviceJoin, recordDeviceJoin, scheduleDeviceJoinRecord } from '@/lib/mls/deviceJoins';

const unb64 = (s: string) => Buffer.from(s, 'base64');

/** Captures the statement instead of running it. */
function recorder() {
  const calls: unknown[] = [];
  return {
    calls,
    executor: {
      execute: async (q: unknown) => {
        calls.push(q);
        return { rows: [{ device_id: 'x' }] };
      },
    },
  };
}

async function joinCommit(identity: string) {
  const owner = await gc.createDevice('user-a:dev-A');
  const created = await gc.createTopicGroup('t-joins', owner);
  const joiner = await gc.createDevice(identity);
  return gc.joinTopicGroup(joiner, created.groupInfoB64);
}

describe('readDeviceJoin', () => {
  it('CONTRACT: a join Commit yields the device, its credential and the new epoch', async () => {
    const joined = await joinCommit('nullifier-b:dev-B');
    const join = readDeviceJoin(unb64(joined.commitB64), 1)!;

    expect(join.deviceId).toBeTruthy();
    expect(join.leafIdentity).toBe('nullifier-b:dev-B');
    expect(join.userId).toBe('nullifier-b');
    expect(join.joinedEpoch).toBe(1);
  });

  it('INTEGRITY: the epoch recorded is the one that ADMITS the device', async () => {
    /*
     * The Commit ASSERTS the epoch it builds on (0 here) and produces the next
     * one. Recording the asserted epoch would place the join an epoch early —
     * inside a window the device cannot read — which is the direction that
     * makes a purge delete something it was owed.
     */
    const joined = await joinCommit('nullifier-b:dev-B');
    expect(readDeviceJoin(unb64(joined.commitB64), 1)!.joinedEpoch).toBe(1);
    expect(readDeviceJoin(unb64(joined.commitB64), 7)!.joinedEpoch).toBe(7);
  });

  it('EMPTY: an unattributable credential keeps the raw identity and yields a NULL account', async () => {
    // An agent leaf minted before the `<userId>:<deviceId>` convention. A null
    // here has to mean "nobody could name this leaf", never "not looked up yet"
    // — an eviction path acting on a guess removes an innocent member.
    const joined = await joinCommit('sdk-7f3c9e21');
    const join = readDeviceJoin(unb64(joined.commitB64), 1)!;
    expect(join.leafIdentity).toBe('sdk-7f3c9e21');
    expect(join.userId).toBeNull();
  });

  it('BOUNDARY: a re-join is a DIFFERENT device, so it is a new row not a collision', async () => {
    // A silent collision in a fire-and-forget insert would leave the re-joined
    // device unrecorded, which is the failure that never surfaces.
    const owner = await gc.createDevice('user-a:dev-A');
    const created = await gc.createTopicGroup('t-joins-again', owner);
    const first = await gc.joinTopicGroup(await gc.createDevice('user-b:dev-B'), created.groupInfoB64);
    const again = await gc.joinTopicGroup(await gc.createDevice('user-b:dev-B'), first.groupInfoB64);

    const a = readDeviceJoin(unb64(first.commitB64), 1)!;
    const b = readDeviceJoin(unb64(again.commitB64), 2)!;
    expect(a.leafIdentity).toBe(b.leafIdentity);
    expect(a.deviceId).not.toBe(b.deviceId);
  });

  it('HOSTILE: an ordinary Commit, junk and an empty buffer each yield nothing', async () => {
    const owner = await gc.createDevice('user-a:dev-A');
    const created = await gc.createTopicGroup('t-joins-rm', owner);
    const joined = await gc.joinTopicGroup(await gc.createDevice('user-b:dev-B'), created.groupInfoB64);
    const after = await gc.processCommit(created.state, joined.commitB64);
    const removal = await gc.removeMembers(after, [1]);

    expect(readDeviceJoin(unb64(removal.commitB64), 2)).toBeNull();
    expect(readDeviceJoin(Buffer.alloc(0), 1)).toBeNull();
    expect(readDeviceJoin(Buffer.from([1, 2, 3, 4, 5]), 1)).toBeNull();
  });
});

describe('scheduleDeviceJoinRecord', () => {
  it('CONTRACT: an accepted join Commit writes exactly one row', async () => {
    const joined = await joinCommit('nullifier-b:dev-B');
    const { calls, executor } = recorder();
    scheduleDeviceJoinRecord(executor, 'topic-1', unb64(joined.commitB64), 1);
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toHaveLength(1);
  });

  it('CONTRACT: a Commit that adds nobody writes nothing, and reports nothing', async () => {
    /*
     * Every ordinary Commit passes through this path, so a parser that guessed
     * would fabricate a join on every membership change in the system — and a
     * MISSING early return would turn each one into a rejected insert and an
     * error line, which is how a quiet log becomes useless.
     */
    loggerMock.error.mockClear();
    const { calls, executor } = recorder();
    scheduleDeviceJoinRecord(executor, 'topic-1', Buffer.from([9, 9, 9]), 3);
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toHaveLength(0);
    expect(loggerMock.error).not.toHaveBeenCalled();
  });

  it('EXT-FAILURE: a rejected insert never throws at the caller', async () => {
    /*
     * The Commit is already applied and fanned out by then. Losing this row
     * degrades to discovering the device at its first acknowledgement — exactly
     * the behaviour that predates the table — and must not cost a member their
     * Commit.
     */
    const joined = await joinCommit('nullifier-b:dev-B');
    const broken = {
      execute: vi.fn().mockRejectedValue(new Error('connection reset')),
    };
    expect(() => scheduleDeviceJoinRecord(broken, 'topic-1', unb64(joined.commitB64), 1)).not.toThrow();
    await new Promise((r) => setTimeout(r, 10));
  });
});

describe('recordDeviceJoin', () => {
  it('reports whether a row was actually written', async () => {
    // The caller distinguishes "recorded" from "already known": the FIRST
    // record is the true one, and a later one must not move `joined_at`
    // forward, which would shrink the window of messages the device is owed.
    const join = { deviceId: 'dev', leafIdentity: 'u:d', userId: 'u', joinedEpoch: 1 };
    const wrote = { execute: async () => ({ rows: [{ device_id: 'dev' }] }) };
    const conflicted = { execute: async () => ({ rows: [] }) };
    expect(await recordDeviceJoin(wrote, 't', join)).toBe(true);
    expect(await recordDeviceJoin(conflicted, 't', join)).toBe(false);
  });
});

/*
 * NOT COVERED HERE, BY DESIGN — two claims a recording executor cannot observe:
 *   - the statement against real Postgres (that `ON CONFLICT (topic_id,
 *     device_id) DO NOTHING` keeps the FIRST row, that the cascade drops rows
 *     with their topic, and that a null `user_id` round-trips) now lives in
 *     `deviceJoinsDb.test.ts`, against the local database;
 *   - that the Commit route CALLS any of this lives in
 *     `deviceJoinsRoute.test.ts`. Deleting the call site leaves every test in
 *     THIS file green, which is why that one exists separately.
 */
