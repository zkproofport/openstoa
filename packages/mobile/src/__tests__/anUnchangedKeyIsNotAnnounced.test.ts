/**
 * Recording a key the manifest ALREADY lists must announce nothing.
 *
 * WHAT IT COST, measured through the load balancer 2026-08-27. Arming the
 * backup retry RESETS its ladder to the shortest delay, so an announcement that
 * fires on unchanged material means the ladder never grows. Every mount and
 * every join re-records keys that are already listed — and one phone read
 * `/api/keys/backup` FIFTY-SIX times in a minute, crossed the edge's limit of a
 * hundred, and was banned for five. During the ban the person's recovery could
 * not run, and the screen told them, in English, that something had gone wrong.
 *
 * The sibling that writes room roots already had this rule, with the reason
 * written above it. This one was missing it.
 *
 * The repetition cases are the whole point: one re-record is harmless, and it
 * is what N of them cost that banned the phone.
 */
import { describe, expect, it } from 'vitest';
import { TakSessionStore } from '../crypto/takSession';

function memoryStore() {
  const m = new Map<string, string>();
  return {
    get: async (k: string) => m.get(k) ?? null,
    set: async (k: string, v: string) => void m.set(k, v),
  };
}

/** A store wired to count announcements, and a way to record a key through it. */
function subject() {
  let announced = 0;
  const store = memoryStore();
  // The constructor subscribes to epoch changes; a bare object is not enough.
  const mls = { setEpochListener: () => {} };
  const tak = new TakSessionStore(
    mls as never,
    {} as never,
    store,
    () => {
      announced += 1;
    },
  );
  // `recordKey` is private by design — reach it the way the class's own callers
  // do, through the manifest it maintains.
  const record = (key: string) =>
    (tak as unknown as { recordKey: (k: string) => Promise<void> }).recordKey(key);
  return { record, announcedCount: () => announced };
}

describe('an unchanged key is not announced', () => {
  it('THE DEFECT: recording the same key twice announces ONCE', async () => {
    const s = subject();
    await s.record('tak.root.topic-a');
    await s.record('tak.root.topic-a');
    expect(s.announcedCount()).toBe(1);
  });

  it('REPETITION: fifty re-records of one key still announce ONCE', async () => {
    const s = subject();
    for (let i = 0; i < 50; i += 1) await s.record('tak.root.topic-a');
    expect(s.announcedCount()).toBe(1);
  });

  it('CONTRACT: a genuinely new key IS announced', async () => {
    const s = subject();
    await s.record('tak.root.topic-a');
    await s.record('tak.root.topic-b');
    expect(s.announcedCount()).toBe(2);
  });

  it('REPETITION: ten new keys announce ten times, no more', async () => {
    const s = subject();
    for (let i = 0; i < 10; i += 1) await s.record(`tak.root.topic-${i}`);
    expect(s.announcedCount()).toBe(10);
  });

  it('INTEGRITY: re-recording an old key after a new one still announces nothing', async () => {
    const s = subject();
    await s.record('tak.root.topic-a');
    await s.record('tak.root.topic-b');
    await s.record('tak.root.topic-a');
    expect(s.announcedCount()).toBe(2);
  });

  it('BOUNDARY: a store with no manifest yet announces the first key', async () => {
    const s = subject();
    await s.record('tak.epoch.topic-a.1');
    expect(s.announcedCount()).toBe(1);
  });
});
