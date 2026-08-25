/**
 * Re-asking is a NEW question, and the screen has to treat it as one.
 *
 * THE DEFECT, found on a real phone. A member tapped "Unlock for them", the
 * device turned out not to hold that stretch, and the row settled on "this
 * device does not have that stretch either". Correct so far.
 *
 * Then the asker asked again for a DIFFERENT range. Re-asking replaces the row
 * rather than adding one — that is deliberate, so a screen retrying on every
 * mount cannot build a queue — which means the request keeps its id. The screen
 * keyed its per-row state on that id alone, so the member kept seeing the old
 * answer to a question they had never been asked, and the button they needed
 * was not there.
 *
 * Nothing was broken server-side and nothing looked broken on screen. The row
 * simply said no, permanently, to whatever came next.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage
 *   contract  → same id + same timestamp = the same ask
 *   contract  → same id + NEW timestamp = a different ask
 *   boundary  → a missing timestamp still yields a stable key rather than
 *               collapsing every request into one
 *   integrity → two different requests never share a key
 *   hostile   → an id containing the separator cannot collide with another row
 */
import { describe, it, expect } from 'vitest';
import { askKey } from '../lib/keyRequest';

function req(over: Partial<Parameters<typeof askKey>[0]> = {}) {
  return {
    id: 'r1',
    requesterUserId: '0xasker',
    requesterDeviceId: 'phone-a',
    haveFromEpoch: 3,
    createdAt: '2026-08-26T00:00:00.000Z',
    ...over,
  };
}

describe('when a row counts as already answered', () => {
  it('CONTRACT: the same ask, read twice, is the same row', () => {
    expect(askKey(req())).toBe(askKey(req()));
  });

  it('CONTRACT: a re-ask carries a new timestamp, so it is a NEW row', () => {
    /*
     * This is the whole fix. The id is unchanged by design — the server
     * replaces the request rather than stacking them — so the timestamp is the
     * only thing that says "they asked again".
     */
    const first = askKey(req({ createdAt: '2026-08-26T00:00:00.000Z' }));
    const second = askKey(req({ createdAt: '2026-08-26T01:00:00.000Z' }));
    expect(second).not.toBe(first);
  });

  it('INTEGRITY: two different requesters never share a key', () => {
    expect(askKey(req({ id: 'r1' }))).not.toBe(askKey(req({ id: 'r2' })));
  });

  it('BOUNDARY: a missing timestamp is stable, not a collapse into one row', () => {
    // An older server that does not send `createdAt` must still produce one key
    // per request, or every waiting member would share a single button.
    expect(askKey(req({ createdAt: null }))).toBe(askKey(req({ createdAt: null })));
    expect(askKey(req({ id: 'r1', createdAt: null }))).not.toBe(
      askKey(req({ id: 'r2', createdAt: null })),
    );
    expect(askKey(req({ createdAt: undefined }))).toBe(askKey(req({ createdAt: null })));
  });

  it('HOSTILE: an id containing the separator cannot impersonate another row', () => {
    /*
     * `r1@X` + no timestamp must not equal `r1` + timestamp `X`. Ids are
     * server-generated UUIDs today, so this is not reachable — it is here
     * because "not reachable today" is how key-collision bugs are shipped.
     */
    const a = askKey(req({ id: 'r1@2026', createdAt: null }));
    const b = askKey(req({ id: 'r1', createdAt: '2026' }));
    expect(a).not.toBe(b);
  });
});
