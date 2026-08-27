/*
 * BOTH human sign-in doors hand the declared device key to the takeover gate.
 *
 * WHY A TEST OF ONE LINE IS WORTH ITS OWN FILE. The key is what makes
 * `deviceTakeoverGate` able to say "these two install ids are one phone". If a
 * route stops passing it, the gate still runs, still returns an answer, and
 * still allows or refuses the sign-in — it just falls back to the id alone,
 * which is the exact behaviour that produced the defect being fixed: an account
 * whose id was lost is told it is about to sign out a phone that does not exist,
 * every single time. Nothing throws, no status changes, and
 * `oneDeviceKeptByKey.test.ts` stays green throughout, because it calls the gate
 * DIRECTLY and so supplies the key itself.
 *
 * So the wiring has to be asserted where the wiring is, and for both doors. The
 * rule was inline in the poll route once and `dev-login` silently had none;
 * `deviceTakeoverGate`'s own header records that. A key passed at one door and
 * not the other is the same shape of gap, one layer down — and dev-login is the
 * door the Android emulator and the E2E suite actually use, so it is the one
 * where a regression would be seen first and understood last.
 *
 * VERIFIED TO FAIL: with `devicePublicKey: device.publicKey` deleted from the
 * route, the CONTRACT cases here go red (see the report accompanying this file).
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage
 *   contract   → each route passes the key, the id and the kind it parsed
 *   integrity  → a MALFORMED key header reaches the gate as `undefined`,
 *                not as the raw text, and the sign-in still succeeds
 *   empty      → no key header at all → `undefined`, sign-in unaffected
 *   authz      → dev-login's `isAI` still overrides the declared kind to
 *                `agent`, so the key rides along without changing that
 *   boundary   → a conflict answer is still turned into 409 with the key wired
 *   race / hostile / UTF-8 / large → N/A here: header parsing owns those and
 *                they are covered by `deviceKeyHeaderIsShapeChecked.test.ts`.
 *                These cases only prove the parsed value is FORWARDED.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

/** A genuine Ed25519 public key, base64 — the shape the header check accepts. */
const KEY = '+sm2ELed3Uuu93ksPH7t6D4EWnCiI9jTTLjE+8Z2N/Y=';
const NULLIFIER = '0xnullifier-from-the-proof';

const mocks = vi.hoisted(() => ({
  checkDeviceTakeover: vi.fn(),
  pollProofResult: vi.fn(),
  createSession: vi.fn(),
  findFirstUser: vi.fn(),
  insertValues: vi.fn(),
}));

vi.mock('@/lib/deviceTakeoverGate', () => ({
  checkDeviceTakeover: mocks.checkDeviceTakeover,
}));

/*
 * Everything below is stubbed only so the two routes can REACH the gate. None
 * of it is what these cases are about — the relay, the on-chain verification and
 * the session mint each have their own suites.
 */
vi.mock('@/lib/relay', async () => {
  const actual = await vi.importActual<typeof import('@/lib/relay')>('@/lib/relay');
  return { ...actual, pollProofResult: mocks.pollProofResult };
});

vi.mock('@/lib/proof', () => ({
  verifyProofFromRelay: async () => ({ valid: true }),
  detectCircuit: () => 'coinbase_attestation',
  extractScope: () => 'the-community-scope',
  computeScopeHash: () => 'the-community-scope',
  extractNullifier: () => NULLIFIER,
  extractDomain: () => null,
  COMMUNITY_SCOPE: 'openstoa',
}));

vi.mock('@/lib/db', () => ({
  db: {
    query: { users: { findFirst: mocks.findFirstUser } },
    insert: () => ({ values: mocks.insertValues }),
  },
}));

vi.mock('@/lib/ensureUser', () => ({
  ensureUser: async () => ({ nickname: 'someone', created: true }),
}));

vi.mock('@/lib/session', () => ({
  createSession: mocks.createSession,
  setSessionCookie: () => {},
}));

vi.mock('@/lib/verification-cache', () => ({
  saveVerificationCache: async () => {},
  circuitToCacheTypeForLogin: () => 'kyc',
}));

vi.mock('@/lib/personalTopic', () => ({ ensurePersonalTopic: async () => {} }));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/** Headers exactly as the mini-app sets them. */
function deviceHeaders(key?: string): Record<string, string> {
  const h: Record<string, string> = {
    'x-openstoa-device-kind': 'mobile',
    'x-openstoa-device-id': 'phone-1',
  };
  if (key !== undefined) h['x-openstoa-device-key'] = key;
  return h;
}

/** One poll-route sign-in. */
async function pollSignIn(key?: string) {
  const { GET } = await import('@/app/api/auth/poll/[requestId]/route');
  const request = new NextRequest('http://localhost:3200/api/auth/poll/req-1', {
    headers: deviceHeaders(key),
  });
  return GET(request, { params: Promise.resolve({ requestId: 'req-1' }) });
}

/** One dev-login sign-in. */
async function devSignIn(key?: string, body: Record<string, unknown> = {}) {
  const { POST } = await import('@/app/api/auth/dev-login/route');
  const request = new NextRequest('http://localhost:3200/api/auth/dev-login', {
    method: 'POST',
    headers: { ...deviceHeaders(key), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return POST(request);
}

/** What the gate was asked, for the single call these cases make. */
function askedWith(): Record<string, unknown> {
  expect(mocks.checkDeviceTakeover).toHaveBeenCalledTimes(1);
  return mocks.checkDeviceTakeover.mock.calls[0][0] as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.checkDeviceTakeover.mockResolvedValue({ kind: 'allow' });
  mocks.pollProofResult.mockResolvedValue({
    status: 'completed',
    proof: '0xproof',
    publicInputs: ['0x1'],
    circuit: 'coinbase_attestation',
  });
  mocks.createSession.mockResolvedValue('a.jwt.token');
  mocks.findFirstUser.mockResolvedValue(undefined);
  mocks.insertValues.mockResolvedValue(undefined);
  delete process.env.APP_ENV;
});

describe('GET /api/auth/poll/[requestId] hands the gate the device key', () => {
  it('CONTRACT: the declared key reaches the gate', async () => {
    const res = await pollSignIn(KEY);

    expect(res.status).toBe(200);
    expect(askedWith()).toMatchObject({
      userId: NULLIFIER,
      deviceKind: 'mobile',
      deviceId: 'phone-1',
      devicePublicKey: KEY,
      takeover: false,
    });
  });

  it('EMPTY: no key header → the gate is told `undefined`, and the sign-in still works', async () => {
    /*
     * The ordinary first sign-in: the mini-app has not run, so there is no key
     * yet. The gate documents this as "fall back to the id alone", which is
     * only true if the field arrives as `undefined` rather than as `''`.
     */
    const res = await pollSignIn();

    expect(res.status).toBe(200);
    expect(askedWith().devicePublicKey).toBeUndefined();
  });

  it('INTEGRITY: a malformed key reaches the gate as undefined, not as raw text', async () => {
    /*
     * The route must read the header THROUGH `deviceFromRequest`. Reading it
     * directly would put `not-a-key` into the gate's `publicKey === ?`
     * comparison, which matches nothing and silently disables the grouping.
     */
    const res = await pollSignIn('not-a-key');

    expect(res.status).toBe(200);
    expect(askedWith().devicePublicKey).toBeUndefined();
  });

  it('BOUNDARY: a conflict is still a 409 with the key wired in', async () => {
    mocks.checkDeviceTakeover.mockResolvedValue({
      kind: 'conflict',
      body: { status: 'device_conflict', existingDevices: [], hasBackup: false, backupUpdatedAt: null },
    });

    const res = await pollSignIn(KEY);

    expect(res.status).toBe(409);
    expect(askedWith().devicePublicKey).toBe(KEY);
    // A refused sign-in mints nothing — otherwise the warning is decorative.
    expect(mocks.createSession).not.toHaveBeenCalled();
  });
});

describe('POST /api/auth/dev-login hands the gate the device key', () => {
  it('CONTRACT: the declared key reaches the gate', async () => {
    /*
     * The door the emulator and the E2E suite use. If only the poll route were
     * wired, every device-continuity behaviour would be untestable by exactly
     * the paths used to test it.
     */
    const res = await devSignIn(KEY);

    expect(res.status).toBe(200);
    expect(askedWith()).toMatchObject({
      deviceKind: 'mobile',
      deviceId: 'phone-1',
      devicePublicKey: KEY,
      takeover: false,
    });
  });

  it('EMPTY: no key header → undefined, sign-in unaffected', async () => {
    const res = await devSignIn();

    expect(res.status).toBe(200);
    expect(askedWith().devicePublicKey).toBeUndefined();
  });

  it('INTEGRITY: a malformed key reaches the gate as undefined', async () => {
    const res = await devSignIn('%%%%');

    expect(res.status).toBe(200);
    expect(askedWith().devicePublicKey).toBeUndefined();
  });

  it('AUTHZ: an isAI login is still an agent, and still carries its key', async () => {
    /*
     * `isAI` overrides the declared kind, and the gate exempts `agent` from the
     * rule entirely. The key must ride along regardless: a future change that
     * made agents subject to the rule would otherwise find the field missing
     * only on this path.
     */
    const res = await devSignIn(KEY, { isAI: true });

    expect(res.status).toBe(200);
    expect(askedWith()).toMatchObject({ deviceKind: 'agent', devicePublicKey: KEY });
  });

  it('CONTRACT: a confirmed takeover is forwarded together with the key', async () => {
    // `takeover` comes from the BODY here and from the query string on the poll
    // route; both must arrive alongside the key rather than instead of it.
    const res = await devSignIn(KEY, { takeover: true });

    expect(res.status).toBe(200);
    expect(askedWith()).toMatchObject({ takeover: true, devicePublicKey: KEY });
  });

  it('BOUNDARY: a conflict is still a 409 with the key wired in', async () => {
    mocks.checkDeviceTakeover.mockResolvedValue({
      kind: 'conflict',
      body: { status: 'device_conflict', existingDevices: [], hasBackup: true, backupUpdatedAt: 1 },
    });

    const res = await devSignIn(KEY);

    expect(res.status).toBe(409);
    expect(askedWith().devicePublicKey).toBe(KEY);
    expect(mocks.createSession).not.toHaveBeenCalled();
  });
});
