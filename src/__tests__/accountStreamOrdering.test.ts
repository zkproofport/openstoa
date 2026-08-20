/**
 * The connect-time replay does not depend on Redis.
 *
 * `pendingKeyNeeded` reads the DATABASE. It was originally placed after
 * `sub.subscribe(...)`, inside the same `try`, which quietly made it depend on
 * the broker: if `subscribe` throws, the catch runs `cleanup()` and the replay
 * never happens.
 *
 * That is not hypothetical. Staging has had NO Redis since the 2026-06-04 cost
 * cutdown (`.claude/agents/openstoa-dev.md`), so behind `subscribe` the replay
 * would have been dead in the one environment most likely to exercise it — and
 * dead silently, because losing it looks exactly like "nobody needed a key".
 *
 * Asserted on the SOURCE, deliberately. The behaviour is an ordering between
 * two statements in one stream handler; reproducing it at runtime means a
 * broker that fails on subscribe but not on construction, which is a harness
 * more fragile than the thing it checks. The regression this guards against is
 * somebody tidying the replay back inside the try — a textual move.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage here
 *   contract   → the replay is issued before `subscribe`, and outside its try
 *   integrity  → it is still fire-and-forget with its own catch, so a failed
 *                query cannot reject into the stream
 *   boundary   → exactly one replay call site; a second would double every
 *                reconnect
 *   empty / hostile / UTF-8 / very large / authz / race → N/A: this reads a
 *                checked-in source file, not input.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const SOURCE = join(process.cwd(), 'src/app/api/me/events/route.ts');
const src = readFileSync(SOURCE, 'utf8');

describe('the account stream orders its work so Redis cannot take the replay with it', () => {
  it('CONTRACT: the replay is issued before subscribe', () => {
    const replayAt = src.indexOf('pendingKeyNeeded(db, userId)');
    const subscribeAt = src.indexOf('sub.subscribe(');

    expect(replayAt, 'the replay call site is gone').toBeGreaterThan(-1);
    expect(subscribeAt, 'the subscribe call site is gone').toBeGreaterThan(-1);
    expect(
      replayAt,
      'the replay moved after subscribe — it dies with Redis again, silently',
    ).toBeLessThan(subscribeAt);
  });

  it('CONTRACT: and outside the try that handles a broker failure', () => {
    // Ordering alone is not enough: inside the same try, a throw from
    // `subscribe` still aborts the surrounding scope before the replay's
    // promise chain is observed.
    const replayAt = src.indexOf('pendingKeyNeeded(db, userId)');
    const tryAt = src.indexOf('await sub.subscribe(');
    const tryOpen = src.lastIndexOf('try {', tryAt);

    expect(tryOpen).toBeGreaterThan(-1);
    expect(replayAt, 'the replay sits inside the broker try').toBeLessThan(tryOpen);
  });

  it('INTEGRITY: it stays fire-and-forget, with its own catch', () => {
    // A rejection escaping here would surface as an unhandled rejection in a
    // stream handler, for a query whose failure costs only a delay.
    const replayAt = src.indexOf('pendingKeyNeeded(db, userId)');
    const block = src.slice(replayAt - 10, replayAt + 900);

    expect(block).toContain('void pendingKeyNeeded');
    expect(block).toContain('.catch(');
  });

  it('BOUNDARY: exactly one replay call site', () => {
    // Two would double the work on every reconnect — and this file has already
    // carried a duplicate once, mid-edit.
    const count = src.split('pendingKeyNeeded(db, userId)').length - 1;
    expect(count).toBe(1);
  });
});
