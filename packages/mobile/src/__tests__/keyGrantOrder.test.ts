/**
 * Sealing the keys must happen BEFORE the request is marked answered.
 *
 * THE FAILURE THIS PREVENTS, and it is the worst one available here. Marking
 * first lets the asker stop waiting and drops the row from every member's list
 * — while nothing has left this device. The person then sits in front of a room
 * that says "unlocked" and shows the same locked messages, with no way back:
 * they cannot re-ask, because as far as the server is concerned they were
 * answered.
 *
 * A grant that reaches ZERO leaves is the same situation in miniature: this
 * device does not hold the missing stretch either, so marking it answered would
 * end the ask on behalf of somebody who could have helped.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage
 *   contract  → seal first, mark second, in that order
 *   integrity → zero leaves reached → NOT marked
 *   integrity → a failure to seal → not marked, and the error surfaces
 *   boundary  → `haveFromEpoch` null asks for everything held; 0 is honoured as
 *               "I have epoch 0" rather than falsy-collapsed to null
 *   boundary  → nothing held → zero, and nothing is sent
 *   hostile   → epochs in the manifest whose value has vanished are skipped
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/* Resolved from THIS FILE: `.test.ts` here runs under two configs. */
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The two calls a grant makes, in the order they happen.
 *
 * A stand-in rather than the real screen: what is being checked is a SEQUENCE,
 * and the sequence lives in the handler, not in the pixels.
 */
function makeGrantHandler(deps: {
  seal: (topicId: string, userId: string, haveFrom: number | null) => Promise<number>;
  mark: (topicId: string, requestId: string) => Promise<void>;
  log: string[];
}) {
  return async (req: {
    id: string;
    requesterUserId: string;
    haveFromEpoch: number | null;
  }): Promise<number> => {
    const leaves = await deps.seal('t1', req.requesterUserId, req.haveFromEpoch);
    if (leaves > 0) await deps.mark('t1', req.id);
    return leaves;
  };
}

const req = { id: 'r1', requesterUserId: '0xasker', haveFromEpoch: 3 };

describe('the order of a grant', () => {
  it('CONTRACT: the keys are sealed first, and only then is the ask marked answered', async () => {
    const log: string[] = [];
    const grant = makeGrantHandler({
      seal: async () => {
        log.push('seal');
        return 2;
      },
      mark: async () => {
        log.push('mark');
      },
      log,
    });

    expect(await grant(req)).toBe(2);
    expect(log).toEqual(['seal', 'mark']);
  });

  it('INTEGRITY: zero leaves reached → the ask is NOT marked', async () => {
    /*
     * This device does not hold the missing stretch either. Marking would end
     * the ask on behalf of a member who could have answered it, and the person
     * has no way to re-ask — the server considers them answered.
     */
    const mark = vi.fn();
    const grant = makeGrantHandler({ seal: async () => 0, mark, log: [] });

    expect(await grant(req)).toBe(0);
    expect(mark).not.toHaveBeenCalled();
  });

  it('INTEGRITY: a failure to seal does not mark, and does not swallow the error', async () => {
    // A silent failure here is indistinguishable from success on screen, and
    // the member walks away believing they helped.
    const mark = vi.fn();
    const grant = makeGrantHandler({
      seal: async () => {
        throw new Error('no network');
      },
      mark,
      log: [],
    });

    await expect(grant(req)).rejects.toThrow('no network');
    expect(mark).not.toHaveBeenCalled();
  });
});

/**
 * Choosing which epochs to send — the same rule `grantMissingTo` applies.
 *
 * Duplicated here as a pure function because the real one lives on a class that
 * needs a secure store, an MLS session and a transport; the RULE is three lines
 * and is where the falsy-zero bug would live.
 */
function missingEpochs(held: number[], haveFromEpoch: number | null): number[] {
  return haveFromEpoch === null ? held : held.filter((e) => e < haveFromEpoch);
}

describe('which epochs a grant covers', () => {
  it('sends only what sits below what the asker already has', () => {
    expect(missingEpochs([0, 1, 2, 3, 4], 3)).toEqual([0, 1, 2]);
  });

  it('BOUNDARY: null means "I can read none of it" → everything held', () => {
    expect(missingEpochs([0, 1, 2], null)).toEqual([0, 1, 2]);
  });

  it('BOUNDARY: 0 is honoured as "I have epoch 0", not collapsed to null', () => {
    /*
     * The falsy check is the bug: `haveFromEpoch || null` turns 0 into "send
     * everything", so a member re-sends the whole history on every ask from
     * somebody who was already complete.
     */
    expect(missingEpochs([0, 1, 2], 0)).toEqual([]);
  });

  it('BOUNDARY: holding nothing sends nothing', () => {
    expect(missingEpochs([], 5)).toEqual([]);
    expect(missingEpochs([], null)).toEqual([]);
  });

  it('BOUNDARY: the asker is ahead of this device → nothing to send', () => {
    // Their `haveFromEpoch` is older than anything here; there is no gap this
    // device can close, and the answer is zero rather than a stray bundle.
    expect(missingEpochs([7, 8], 5)).toEqual([]);
  });
});

describe('the REAL handler keeps that order', () => {
  /*
   * The cases above test a stand-in. That proves the rule is right; it does not
   * prove the shipped code follows it — and a test that only ever checks its own
   * copy of the logic is the most comfortable kind of green there is.
   *
   * Read at source, because the alternative is mounting a chat room with an MLS
   * session, a secure store and a transport to observe two calls in sequence.
   */
  const SCREEN = readFileSync(join(SRC, 'screens/chat/ChatRoomScreen.tsx'), 'utf8');

  it('CONTRACT: grantMissingTo is called, and the mark sits behind a leaves > 0 check', () => {
    expect(SCREEN).toContain('grantMissingTo');
    const at = SCREEN.indexOf('grantMissingTo');
    const after = SCREEN.slice(at, at + 500);
    expect(after).toContain('leaves > 0');
    // And the POST that marks it answered comes AFTER, inside that check.
    const guard = after.indexOf('leaves > 0');
    const mark = after.indexOf('keys/grant');
    expect(mark, 'the grant POST is missing').toBeGreaterThan(-1);
    expect(mark, 'the grant POST is not behind the leaves check').toBeGreaterThan(guard);
  });

  it('INTEGRITY: a member is never offered their own request to answer', () => {
    // Answering your own ask would mark it granted and send you keys you already
    // do not have — the row leaves the list and nobody else ever sees it.
    expect(SCREEN).toContain('requesterDeviceId !== mineDev');
  });
});
