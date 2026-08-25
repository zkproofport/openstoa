/**
 * The MLS transport reads an HTTP status off the error, never out of its text.
 *
 * `getGroupInfo` has to tell "there is no group yet" (404 → be genesis) from a
 * real fault (rethrow). `postCommit` has to tell "someone committed first"
 * (409 → rebuild and retry) from a fault. Both asked a regex over
 * `err.message` for `→ 404:`.
 *
 * That regex held only while `message` happened to be the flattened
 * `METHOD path → STATUS: body` string. When `OpenStoaApiError` started putting
 * the server's own sentence in `message` — so a refusal could be shown to a
 * person instead of the API's shape — the marker left, `statusOf` began
 * returning null for every request, and:
 *
 *   - `getGroupInfo` rethrew on 404 instead of answering null, so MLS bootstrap
 *     never reached its genesis branch. Every topic created from the Android
 *     mini-app got NO `mls_groups` row: a room nobody can ever send in.
 *     Verified on-device 2026-08-25 — `select count(*) from mls_groups where
 *     topic_id = <the topic just created>` returned 0.
 *   - `postCommit` lost its 409 retry, so a join that raced another commit gave
 *     up instead of rebuilding.
 *
 * Nothing said a word. So these tests are written against the ERROR SHAPE the
 * client actually throws today, and one of them holds the failing shape
 * directly: a 404 whose `message` is the server's sentence with no status in
 * it, which is precisely what the device saw.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage here
 *   contract   → 404 → null (genesis path), NOT a rethrow
 *   contract   → 409 on commit → `{ ok: false }`, so the caller retries
 *   integrity  → the failing shape itself: `message` carries only the server's
 *                sentence, `status` carries 404 — the exact on-device case
 *   boundary   → 403 / 500 are NOT 404: they must rethrow, so a permission
 *                error can never be mistaken for "no group yet" and silently
 *                start a second group
 *   hostile    → an error whose `message` contains a decoy `→ 404:` but whose
 *                real status is 500 must be treated as 500
 *   empty      → `null` / `undefined` / a bare string thrown: no status, so a
 *                rethrow, never a false 404
 *   external   → a network failure (no status at all) rethrows
 *   contract   → the legacy flattened string still resolves, so anything not
 *                yet throwing the typed error keeps working
 */
import { describe, it, expect, vi } from 'vitest';
import { createMlsTransport } from '../crypto/mobileTransport';
import type { OpenStoaClient } from '../api/openstoaClient';

/** The shape `OpenStoaClient` throws today: sentence in `message`, typed status. */
function apiError(status: number, serverMessage: string): Error {
  const err = new Error(serverMessage) as Error & {
    kind: string;
    status: number;
    serverMessage: string;
    debugMessage: string;
  };
  err.kind = 'API_ERROR';
  err.status = status;
  err.serverMessage = serverMessage;
  err.debugMessage = `GET /api/topics/x/mls/group-info → ${status}: {"error":"${serverMessage}"}`;
  return err;
}

function clientWith(get: () => Promise<unknown>, post?: () => Promise<unknown>): OpenStoaClient {
  return {
    get: vi.fn(get),
    post: vi.fn(post ?? (async () => ({}))),
  } as unknown as OpenStoaClient;
}

const TOPIC = '0144a656-2866-4ffd-baa7-5ccb5449e23a';

describe('mobile MLS transport — status resolution', () => {
  it('answers null for a 404 whose message is only the server sentence', async () => {
    // The on-device shape verbatim: no "→ 404:" anywhere in `message`.
    const err = apiError(404, 'No GroupInfo available');
    expect(err.message).not.toMatch(/404/);

    const transport = createMlsTransport(
      clientWith(async () => {
        throw err;
      }),
    );

    await expect(transport.getGroupInfo(TOPIC)).resolves.toBeNull();
  });

  it('returns the GroupInfo when the group exists', async () => {
    const transport = createMlsTransport(clientWith(async () => ({ groupInfo: 'Z2k=' })));
    await expect(transport.getGroupInfo(TOPIC)).resolves.toBe('Z2k=');
  });

  it.each([
    ['403 Forbidden', 403, 'Not a member of this topic'],
    ['500 Internal', 500, 'Something went wrong'],
    ['401 Unauthorized', 401, 'Not authenticated'],
  ])('rethrows %s rather than reporting "no group yet"', async (_label, status, sentence) => {
    const transport = createMlsTransport(
      clientWith(async () => {
        throw apiError(status, sentence);
      }),
    );

    // A false null here would make the client try to be genesis for a group it
    // may not even be allowed to read.
    await expect(transport.getGroupInfo(TOPIC)).rejects.toThrow(sentence);
  });

  it('trusts the status field over a decoy status in the text', async () => {
    const err = apiError(500, 'upstream said → 404: nope');
    const transport = createMlsTransport(
      clientWith(async () => {
        throw err;
      }),
    );

    await expect(transport.getGroupInfo(TOPIC)).rejects.toThrow(err);
  });

  it.each([
    ['a bare string', 'boom'],
    ['null', null],
    ['undefined', undefined],
    ['a plain Error', new Error('socket hung up')],
  ])('rethrows %s, which carries no status at all', async (_label, thrown) => {
    const transport = createMlsTransport(
      clientWith(async () => {
        throw thrown;
      }),
    );

    /*
     * The assertion is that it REJECTS, whatever the value — `undefined` is a
     * legal thing to throw, and `.rejects.toBeDefined()` would fail on it for
     * a reason that has nothing to do with this code. What must never happen
     * is resolving to null: that is "no group yet", and it would start a
     * second group on a transient network fault.
     */
    let resolved = true;
    await transport.getGroupInfo(TOPIC).catch(() => {
      resolved = false;
    });
    expect(resolved).toBe(false);
  });

  it('still resolves the legacy flattened message', async () => {
    const legacy = new Error('GET /api/topics/x/mls/group-info → 404: {"error":"No GroupInfo available"}');
    const transport = createMlsTransport(
      clientWith(async () => {
        throw legacy;
      }),
    );

    await expect(transport.getGroupInfo(TOPIC)).resolves.toBeNull();
  });

  it('reports a 409 commit as a retryable conflict, not a failure', async () => {
    const transport = createMlsTransport(
      clientWith(
        async () => ({ groupInfo: 'Z2k=' }),
        async () => {
          throw apiError(409, 'Epoch conflict');
        },
      ),
    );

    await expect(transport.postCommit(TOPIC, 'YwA=', 'Z2k=')).resolves.toEqual({ ok: false });
  });

  it('rethrows a commit that failed for any other reason', async () => {
    const transport = createMlsTransport(
      clientWith(
        async () => ({ groupInfo: 'Z2k=' }),
        async () => {
          throw apiError(400, 'Malformed commit');
        },
      ),
    );

    await expect(transport.postCommit(TOPIC, 'YwA=', 'Z2k=')).rejects.toThrow('Malformed commit');
  });
});
