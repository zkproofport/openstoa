/**
 * A failed write says what happened, and says the server's own reason.
 *
 * The bug this pins was three layers deep and each layer looked fine on its
 * own. `openstoaClient` flattened the status and the server's sentence into one
 * message string; screens handed that string to `host.showError`; and the
 * host's `showError` was a `console.warn` with a comment promising it would be
 * wired up later. The result on a device: you type a nickname the server
 * reserves, press Save, and NOTHING happens — no modal, no inline text, no
 * hint that a request was even made. The reason existed the whole time, in
 * words written for a person, and no layer put it on screen.
 *
 * So the assertions here are about what reaches the person, not about internal
 * shapes: the host is called, with a code that has a registered modal, and
 * carrying the sentence the server sent.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage here
 *   contract   → the host IS called for every failure kind (the silent path is
 *                what regressed, so its absence is the assertion)
 *   integrity  → a 4xx shows the server's own sentence, both in the modal
 *                detail and inline under the field
 *   boundary   → 400 / 409 / 499 / 500 / 503 either side of the 4xx-vs-5xx cut
 *   hostile    → a body that is not JSON, is JSON without `error`, has a
 *                non-string `error`, or is an HTML proxy page → never shown as
 *                an explanation
 *   empty      → empty body, whitespace-only `error`
 *   external   → the request never reaching the server is its OWN code, not a
 *                server fault, because the remedy differs
 *   UTF-8      → a Korean server sentence survives intact
 *   very large → a 5 000-character body is passed through, never truncated
 *                (CLAUDE.md: no truncation)
 *   authz      → N/A here: 401 never reaches this classifier — the client
 *                converts it to `GuestAuthRequiredError` and the sign-in sheet
 *                handles it (`sessionLifecycle.test.ts`)
 *   race       → N/A: pure classification, no async state
 */
import { describe, it, expect, vi } from 'vitest';
import type { HostApi } from '@openstoa/miniapp-bridge';
import { describeFailure, reportFailure, NETWORK_ERROR_CODE } from '../api/failure';
import { OpenStoaApiError, OpenStoaNetworkError } from '../api/openstoaClient';

const PATH = '/api/profile/nickname';
const ACTION_CODE = 'E9003';

/** An error shaped exactly as `openstoaClient` builds one from a response. */
function apiError(status: number, body: string): OpenStoaApiError {
  let serverMessage: string | null = null;
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    serverMessage =
      typeof parsed.error === 'string' && parsed.error.trim() ? parsed.error : null;
  } catch {
    serverMessage = null;
  }
  return new OpenStoaApiError(status, PATH, serverMessage, `PUT ${PATH} → ${status}: ${body}`);
  // NB: the 4th argument is `debugMessage` — logs only. `message` is derived
  // from `serverMessage`, which is what the assertions below rely on.
}

function hostSpy(): { host: HostApi; calls: Array<[string, Record<string, unknown> | undefined]> } {
  const calls: Array<[string, Record<string, unknown> | undefined]> = [];
  const host = {
    showError: (code: string, details?: Record<string, unknown>) => {
      calls.push([code, details]);
    },
  } as unknown as HostApi;
  return { host, calls };
}

describe('a refusal the server explained is shown to the person', () => {
  it('INTEGRITY: the reserved-name refusal reaches BOTH the modal and the field', () => {
    // The exact 400 that made the Save button look broken.
    const failure = describeFailure(
      apiError(400, JSON.stringify({ error: 'That name is reserved.' })),
      ACTION_CODE,
    );

    expect(failure.code).toBe(ACTION_CODE);
    expect(failure.detail).toBe('That name is reserved.');
    expect(failure.inline).toBe('That name is reserved.');
  });

  it('INTEGRITY: a taken name says it is taken, not something generic', () => {
    const failure = describeFailure(
      apiError(409, JSON.stringify({ error: 'Nickname already taken' })),
      ACTION_CODE,
    );

    expect(failure.inline).toBe('Nickname already taken');
  });

  it('UTF-8: a Korean sentence from the server survives intact', () => {
    const korean = '이미 사용 중인 닉네임이에요.';
    const failure = describeFailure(
      apiError(409, JSON.stringify({ error: korean })),
      ACTION_CODE,
    );

    expect(failure.inline).toBe(korean);
  });

  it('VERY LARGE: a long server sentence is passed through whole, never cut', () => {
    // CLAUDE.md forbids truncating log/detail output. A 5 000-character reason
    // is pathological, but silently keeping the first 100 characters of an
    // explanation is worse than showing all of it.
    const long = 'x'.repeat(5000);
    const failure = describeFailure(apiError(400, JSON.stringify({ error: long })), ACTION_CODE);

    expect(failure.inline).toHaveLength(5000);
    expect(failure.detail).toHaveLength(5000);
  });
});

describe('a fault is admitted, not explained away', () => {
  it.each([500, 503])('BOUNDARY: %i keeps the modal copy and offers no inline text', (status) => {
    // A 5xx body carries an errorId, not an explanation (see `apiError` on the
    // server). Putting that in front of someone as the reason would be a lie
    // dressed as help.
    const failure = describeFailure(
      apiError(status, JSON.stringify({ error: 'Internal server error', errorId: 'abc123' })),
      ACTION_CODE,
    );

    expect(failure.code).toBe(ACTION_CODE);
    expect(failure.inline).toBeNull();
    expect(failure.detail).not.toContain('/api/');
  });

  it('BOUNDARY: 499 is still the server declining, 500 is not', () => {
    const declined = describeFailure(apiError(499, JSON.stringify({ error: 'Declined' })), ACTION_CODE);
    const faulted = describeFailure(apiError(500, JSON.stringify({ error: 'Declined' })), ACTION_CODE);

    expect(declined.inline).toBe('Declined');
    expect(faulted.inline).toBeNull();
  });
});

describe('HOSTILE / EMPTY bodies never become an explanation', () => {
  it.each([
    ['not JSON at all', 'Bad Gateway'],
    ['an HTML proxy page', '<html><body>502 Bad Gateway</body></html>'],
    ['JSON without an error field', '{"ok":false}'],
    ['a non-string error field', '{"error":{"code":42}}'],
    ['an array error field', '{"error":["a","b"]}'],
    ['a null error field', '{"error":null}'],
    ['an empty body', ''],
    ['a whitespace-only error', '{"error":"   "}'],
  ])('%s yields no inline reason', (_label, body) => {
    const failure = describeFailure(apiError(400, body), ACTION_CODE);

    expect(failure.inline).toBeNull();
    // The modal still opens and still says something — but never the endpoint.
    // A body the server did not write is not an explanation, and the request
    // line is not a substitute for one.
    expect(failure.code).toBe(ACTION_CODE);
    expect(failure.detail.trim()).not.toBe('');
    expect(failure.detail).not.toContain(PATH);
    expect(failure.detail).not.toContain('/api/');
  });
});

describe('EXTERNAL FAILURE: an unreachable server is its own answer', () => {
  it('gets the network code, not the action code — nothing was attempted', () => {
    const failure = describeFailure(
      new OpenStoaNetworkError(PATH, new TypeError('Network request failed')),
      ACTION_CODE,
    );

    expect(failure.code).toBe(NETWORK_ERROR_CODE);
    expect(failure.code).not.toBe(ACTION_CODE);
    // Not a field-level problem: there is nothing to correct in the input.
    expect(failure.inline).toBeNull();
  });

  it('CONTRACT: reportFailure opens the network modal for it', () => {
    const { host, calls } = hostSpy();
    reportFailure(host, new OpenStoaNetworkError(PATH, new Error('offline')), ACTION_CODE);

    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe(NETWORK_ERROR_CODE);
  });
});

describe('CONTRACT: the host is always told — silence is the regression', () => {
  it.each([
    ['a server refusal', apiError(400, JSON.stringify({ error: 'That name is reserved.' }))],
    ['a server fault', apiError(500, '{}')],
    ['an unreachable server', new OpenStoaNetworkError(PATH, new Error('offline'))],
    ['an error from nowhere in particular', new Error('boom')],
    ['a thrown non-Error', 'just a string' as unknown as Error],
  ])('%s reaches host.showError', (_label, thrown) => {
    const { host, calls } = hostSpy();
    reportFailure(host, thrown, ACTION_CODE);

    expect(calls, 'nothing was reported to the host').toHaveLength(1);
    const [code, details] = calls[0];
    expect(code).toMatch(/^E\d{4}$/);
    // A modal with no text is what an unregistered code used to produce, so the
    // detail must never be empty either.
    expect(String(details?.detail ?? '')).not.toBe('');
  });

  it('the action code names the action, so the modal title can say which one', () => {
    const { host, calls } = hostSpy();
    reportFailure(host, apiError(400, '{}'), 'E9005');

    expect(calls[0][0]).toBe('E9005');
  });

  it('a thrown non-Error still produces readable detail rather than "[object Object]"', () => {
    const { host, calls } = hostSpy();
    reportFailure(host, { unexpected: true }, ACTION_CODE);

    // Not a promise about the exact wording — only that something was said.
    expect(String(calls[0][1]?.detail ?? '')).not.toBe('');
  });
});

describe('the endpoint never reaches the screen', () => {
  /*
   * Around twenty screens render `err.message` straight into a <Text> or an
   * Alert. That is not going to change, and does not need to: the fix is that
   * `message` is a sentence for a person. What it must never be again is the
   * request line, which is how "Could not reach the server for /api/topics" and
   * "PUT /api/profile/nickname → 400: {…}" ended up in front of users — the
   * API's shape on a phone, saying nothing anyone could act on.
   *
   * Asserted on the error classes themselves rather than per screen, because
   * that is the one place it can be guaranteed for call sites not written yet.
   */
  it('CONTRACT: a network error names no endpoint', () => {
    const e = new OpenStoaNetworkError('/api/topics', new TypeError('Network request failed'));

    expect(e.message).not.toContain('/api/');
    expect(e.message).not.toContain('topics');
    // Still available for the log — moved, not deleted.
    expect(e.path).toBe('/api/topics');
  });

  it('CONTRACT: an API error shows the server sentence, and the request line only on `debugMessage`', () => {
    const e = apiError(400, JSON.stringify({ error: 'That name is reserved.' }));

    expect(e.message).toBe('That name is reserved.');
    expect(e.message).not.toContain('/api/');
    expect(e.debugMessage).toContain('/api/');
  });

  it.each([
    ['no body', ''],
    ['a proxy HTML page', '<html>502</html>'],
    ['JSON without error', '{"ok":false}'],
  ])('CONTRACT: with %s the message is generic, never the request line', (_label, body) => {
    const e = apiError(502, body);

    expect(e.message).not.toContain('/api/');
    expect(e.message).not.toContain('502');
    expect(e.message.trim()).not.toBe('');
  });

  it('CONTRACT: no HTTP method or status leaks into the message either', () => {
    const e = apiError(409, JSON.stringify({ error: 'Nickname already taken' }));

    for (const leak of ['PUT', 'POST', 'GET', 'DELETE', '409', '→']) {
      expect(e.message).not.toContain(leak);
    }
  });
});

describe('the client builds the error the classifier expects', () => {
  it('CONTRACT: a fetch that throws becomes OpenStoaNetworkError, not a raw TypeError', async () => {
    // The one place the two modules meet. If `openstoaClient` stops wrapping,
    // every network failure silently falls to the generic branch and the
    // "check your connection" modal is never reached again.
    const { OpenStoaClient } = await import('../api/openstoaClient');
    const failing = vi.fn(async () => {
      throw new TypeError('Network request failed');
    });
    const original = global.fetch;
    global.fetch = failing as unknown as typeof global.fetch;

    const host = {
      getEnvironment: () => ({
        isEmbedded: true,
        hostName: 'test',
        openstoaBaseUrl: 'https://openstoa.test',
      }),
      getOpenStoaToken: async () => 'token',
      setOpenStoaToken: async () => {},
      logoutFromOpenStoa: async () => {},
    } as unknown as HostApi;

    const client = new OpenStoaClient({ host });
    client.setMode('authenticated');

    await expect(client.put('/api/profile/nickname', { nickname: 'x' })).rejects.toBeInstanceOf(
      OpenStoaNetworkError,
    );

    global.fetch = original;
  });
});
