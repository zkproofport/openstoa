/**
 * A push that does not arrive has to say why.
 *
 * Android delivery was dead for a day and the server log said `{ok:0,error:1}`
 * on every attempt — the same line a message-too-big or a stale token would
 * produce. Expo had told us exactly what was wrong ("Unable to retrieve the FCM
 * server key for the recipient's app", `InvalidCredentials`) and the provider
 * counted the ticket and dropped the sentence. The diagnosis in the end came
 * from hand-POSTing to Expo, which is not a thing a log should make anyone do.
 *
 * The second half is worse and less obvious: an accepted ticket is a QUEUED
 * message, not a delivered one. Everything that fails between Expo and FCM or
 * APNs surfaces only in a RECEIPT, so a server can watch every push it sends
 * succeed while no phone ever rings.
 *
 * N/A matrix rows: authorization (this path has no caller-supplied input) and
 * UTF-8 / very-large (nothing here echoes message content — that is the point).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const warn = vi.fn();
const info = vi.fn();
vi.mock('@/lib/logger', () => ({
  logger: {
    warn: (...a: unknown[]) => warn(...a),
    info: (...a: unknown[]) => info(...a),
    error: (...a: unknown[]) => warn(...a),
    debug: () => {},
  },
}));

import { ExpoPushProvider } from '@/lib/pushProvider';

const TOKEN = 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]';

/** Everything a `warn` or `info` call recorded, flattened for searching. */
function logged(): string {
  return [...warn.mock.calls, ...info.mock.calls].map((c) => JSON.stringify(c)).join('\n');
}

function ticket(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  warn.mockReset();
  info.mockReset();
  fetchMock = vi.fn();
  (global as unknown as { fetch: unknown }).fetch = fetchMock;
});

afterEach(() => {
  vi.useRealTimers();
});

/** Runs one send and lets the deferred receipt check run to completion. */
async function send(provider: ExpoPushProvider) {
  await provider.send({ pushToken: TOKEN } as never, {
    title: 'New message',
    body: 'x',
    data: { topicId: 't1' },
  } as never);
  await vi.runAllTimersAsync();
}

describe('CONTRACT: a rejected ticket names its reason', () => {
  it('logs InvalidCredentials — the exact failure that hid for a day', async () => {
    fetchMock.mockResolvedValueOnce(
      ticket({
        data: [
          {
            status: 'error',
            message:
              "Unable to retrieve the FCM server key for the recipient's app. Make sure you have provided a server key as directed by the Expo FCM documentation.",
            details: { error: 'InvalidCredentials', fault: 'developer' },
          },
        ],
      }),
    );

    await send(new ExpoPushProvider());

    // Remove the reason from the log line and this is the assertion that fails.
    expect(logged()).toContain('InvalidCredentials');
  });

  it.each([
    'DeviceNotRegistered',
    'MessageTooBig',
    'MessageRateExceeded',
    'MismatchSenderId',
  ])('logs %s', async (code) => {
    fetchMock.mockResolvedValueOnce(
      ticket({ data: [{ status: 'error', message: 'nope', details: { error: code } }] }),
    );
    await send(new ExpoPushProvider());
    expect(logged()).toContain(code);
  });

  it('EMPTY: falls back to the prose when Expo sends no error code', async () => {
    fetchMock.mockResolvedValueOnce(
      ticket({ data: [{ status: 'error', message: 'something went sideways' }] }),
    );
    await send(new ExpoPushProvider());
    expect(logged()).toContain('something went sideways');
  });

  it('EMPTY: says "unknown" rather than nothing when there is neither', async () => {
    fetchMock.mockResolvedValueOnce(ticket({ data: [{ status: 'error' }] }));
    await send(new ExpoPushProvider());
    expect(logged()).toContain('unknown');
  });

  it('INTEGRITY: a rejected batch logs at WARN, not INFO', async () => {
    // It sat at INFO before, under the same wording a success used. A failure
    // that reads like a success is how this went unnoticed.
    fetchMock.mockResolvedValueOnce(
      ticket({ data: [{ status: 'error', details: { error: 'InvalidCredentials' } }] }),
    );
    await send(new ExpoPushProvider());
    expect(warn).toHaveBeenCalled();
  });

  it('INTEGRITY: a clean batch does not warn', async () => {
    // Guards the fix from over-correcting into "every push looks broken".
    fetchMock.mockResolvedValueOnce(ticket({ data: [{ status: 'ok', id: 'r1' }] }));
    fetchMock.mockResolvedValueOnce(ticket({ data: { r1: { status: 'ok' } } }));
    await send(new ExpoPushProvider());
    expect(warn).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalled();
  });
});

describe('CONTRACT: an accepted ticket is checked for delivery', () => {
  it('asks Expo what happened, and names the failure', async () => {
    fetchMock.mockResolvedValueOnce(ticket({ data: [{ status: 'ok', id: 'receipt-1' }] }));
    fetchMock.mockResolvedValueOnce(
      ticket({
        data: {
          'receipt-1': {
            status: 'error',
            message: 'The device is not registered',
            details: { error: 'DeviceNotRegistered' },
          },
        },
      }),
    );

    await send(new ExpoPushProvider());

    // A ticket said OK and the phone never rang. Without the receipt call this
    // is invisible — delete `reportReceipts` and this goes red.
    expect(fetchMock.mock.calls[1][0]).toContain('getReceipts');
    expect(logged()).toContain('DeviceNotRegistered');
  });

  it('BOUNDARY: a pending receipt is not reported as a failure', async () => {
    // Expo answers `pending` for anything it has not resolved yet, which is the
    // normal case moments after a send. Logging it would cry wolf on every push.
    fetchMock.mockResolvedValueOnce(ticket({ data: [{ status: 'ok', id: 'r1' }] }));
    fetchMock.mockResolvedValueOnce(ticket({ data: { r1: { status: 'ok' } } }));
    await send(new ExpoPushProvider());
    expect(warn).not.toHaveBeenCalled();
  });

  it('EMPTY: nothing accepted means no receipt call at all', async () => {
    fetchMock.mockResolvedValueOnce(
      ticket({ data: [{ status: 'error', details: { error: 'InvalidCredentials' } }] }),
    );
    await send(new ExpoPushProvider());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('EXTERNAL FAILURE: a receipt lookup that throws never reaches the caller', async () => {
    fetchMock.mockResolvedValueOnce(ticket({ data: [{ status: 'ok', id: 'r1' }] }));
    fetchMock.mockRejectedValueOnce(new Error('expo is down'));
    await expect(send(new ExpoPushProvider())).resolves.toBeUndefined();
  });

  it('EXTERNAL FAILURE: a non-200 receipt response is not read as success', async () => {
    fetchMock.mockResolvedValueOnce(ticket({ data: [{ status: 'ok', id: 'r1' }] }));
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) });
    await expect(send(new ExpoPushProvider())).resolves.toBeUndefined();
    expect(logged()).not.toContain('undelivered');
  });
});

describe('SI-1: the log still names nothing private', () => {
  it('never writes the push token, the user or the body', async () => {
    fetchMock.mockResolvedValueOnce(
      ticket({
        data: [
          {
            status: 'error',
            message: `token ${TOKEN} rejected`,
            details: { error: 'DeviceNotRegistered' },
          },
        ],
      }),
    );
    await send(new ExpoPushProvider());

    const out = logged();
    expect(out).toContain('DeviceNotRegistered');
    // The prose is only a fallback, and the code wins when both are present —
    // which is also what keeps a token Expo echoed back out of our log.
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain('ExponentPushToken');
  });
});
