import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The diagnostics sink exists to make an invisible failure readable. That is
 * only acceptable while it stays metadata-only, so this file guards BOTH ends:
 * the route's envelope (authz, rate limit, caps) and the callers' payloads.
 */
const session = { userId: 'u1', nickname: 'alice', isAI: false };

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  checkRateLimit: vi.fn(),
  info: vi.fn(),
}));

vi.mock('@/lib/session', () => ({ getSession: mocks.getSession }));
vi.mock('@/lib/logger', () => ({
  logger: { info: mocks.info, warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/mls/http', () => ({ checkRateLimit: mocks.checkRateLimit }));

import { POST } from '@/app/api/diag/e2ee/route';

const req = (body?: unknown) => ({ json: async () => body }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSession.mockResolvedValue(session);
  mocks.checkRateLimit.mockResolvedValue(true);
});

describe('POST /api/diag/e2ee — envelope', () => {
  it('a guest cannot write to the log', async () => {
    mocks.getSession.mockResolvedValue(null);
    expect((await POST(req({ step: 's', detail: {} }))).status).toBe(401);
    expect(mocks.info).not.toHaveBeenCalled();
  });

  it('logs under the SESSION user, so a report cannot be attributed to someone else', async () => {
    const res = await POST(req({ step: 'state/blob', detail: { bytes: 599 }, userId: 'someone-else' }));
    expect(res.status).toBe(200);
    expect(mocks.info).toHaveBeenCalledWith(
      '/api/diag/e2ee',
      'E2EE diagnostic',
      expect.objectContaining({ userId: 'u1', step: 'state/blob' }),
    );
  });

  it('rate limited, so a looping client cannot flood the log', async () => {
    mocks.checkRateLimit.mockResolvedValue(false);
    expect((await POST(req({ step: 's', detail: {} }))).status).toBe(429);
    expect(mocks.info).not.toHaveBeenCalled();
  });

  it('HOSTILE: missing, empty, non-string and oversized steps are all rejected', async () => {
    for (const step of [undefined, '', 42, null, {}, 'x'.repeat(65)]) {
      expect((await POST(req({ step, detail: {} }))).status).toBe(400);
    }
    expect(mocks.info).not.toHaveBeenCalled();
  });

  it('BOUNDARY: an oversized detail is TRUNCATED, not dropped — evidence beats tidiness', async () => {
    await POST(req({ step: 's', detail: { pad: 'x'.repeat(5000) } }));
    const logged = mocks.info.mock.calls[0][2].detail as string;
    expect(logged.length).toBeLessThan(2200);
    expect(logged.endsWith('…[truncated]')).toBe(true);
  });

  it('EXTERNAL FAILURE: an unserializable detail still records the step', async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const res = await POST(req({ step: 'state/blob', detail: cyclic }));
    expect(res.status).toBe(200);
    expect(mocks.info.mock.calls[0][2].step).toBe('state/blob');
  });

  it('a malformed body is 400, never a 500', async () => {
    expect((await POST(req(null))).status).toBe(400);
    expect((await POST(req('a string'))).status).toBe(400);
  });
});

describe('callers may only report metadata', () => {
  // Reading the source is the point: the risk is a FUTURE edit sending key
  // material, and no runtime assertion on today's payloads would catch that.
  const source = readFileSync(join(process.cwd(), 'src/lib/mls/webTransport.ts'), 'utf8');
  const reportCalls = [...source.matchAll(/\breport\(\s*'([^']+)'\s*,\s*(\{[^}]*\})/g)];

  it('every report call is present and shaped as {name: expression}', () => {
    expect(reportCalls.length).toBeGreaterThanOrEqual(7);
  });

  it('no report call passes a raw key, keychain value, or ciphertext', () => {
    // Names of things that ARE secret material in this module. `keys:` is
    // allowed — it carries store key NAMES (`tak.root.<topicId>`), not values.
    const forbidden =
      /\b(masterKey|recoveredMasterKey|prfOutput|prfWrapped|wrappedMasterB64|blob|ciphertext|keychain|opened|mk)\s*[,}]/;
    for (const [, step, detail] of reportCalls) {
      expect(`${step}: ${detail}`).not.toMatch(forbidden);
    }
  });

  it('byte counts are reported as LENGTHS, never as the value itself', () => {
    for (const [, , detail] of reportCalls) {
      if (/bytes:/.test(detail)) expect(detail).toMatch(/bytes:\s*[^,}]*(length|\.length|\?\?\s*0)/);
    }
  });
});
