/**
 * One human, one phone — over real HTTP against a running container.
 *
 * WHY THIS EXISTS AS AN E2E. The rule spans four things that only meet in a
 * deployed server: the header the client declares, the Redis session record,
 * the JWT claim minted from it, and the middleware that reads that claim back.
 * A unit test can prove each piece; only this can prove they are wired to each
 * other. The failure it guards against is the one that unit tests cannot see —
 * a rule enforced in a module nothing calls.
 *
 * WHAT IT ASSERTS
 *   1. A second phone is REFUSED with 409 and told whether a backup exists.
 *   2. The same phone signing in again is not a second phone.
 *   3. A confirmed takeover ends the previous phone's session — that token is
 *      dead afterwards, which is the part that was missing entirely before
 *      sessions were recorded.
 *   4. A browser is not a phone: a web login neither conflicts with a phone nor
 *      displaces it.
 *   5. Chat is refused to a web session, at the server, by the signed claim —
 *      not by the UI having no button.
 *   6. Signing out actually ends a session rather than clearing a cookie.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage
 *   contract    → 409 shape; takeover=true proceeds; logout revokes
 *   authz       → web vs mobile vs agent; chat paths refused to web
 *   boundary    → same device twice; two devices; three
 *   integrity   → the OLD token stops working, the NEW one works
 *   hostile     → a forged `mobile` header from a would-be second device still
 *                 only reaches the conflict, never someone else's messages
 *   race        → two sign-ins with the same device id do not stack sessions
 */
import { describe, it, expect } from 'vitest';
import { getBaseUrl } from './helpers';

const BASE = getBaseUrl();

/** A distinct install id per call, the way two real phones would differ. */
function deviceId(tag: string): string {
  return `e2e-${tag}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

interface LoginResult {
  status: number;
  body: Record<string, unknown>;
}

async function login(opts: {
  nickname: string;
  kind: 'mobile' | 'web' | 'agent';
  device: string;
  takeover?: boolean;
}): Promise<LoginResult> {
  const res = await fetch(`${BASE}/api/auth/dev-login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-openstoa-device-kind': opts.kind,
      'x-openstoa-device-id': opts.device,
    },
    body: JSON.stringify({
      nickname: opts.nickname,
      ...(opts.takeover ? { takeover: true } : {}),
    }),
  });
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    /* a body we cannot read is still a status we can assert */
  }
  return { status: res.status, body };
}

async function sessionStatus(token: string): Promise<number> {
  const res = await fetch(`${BASE}/api/auth/session`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status !== 200) return res.status;
  /*
   * `/api/auth/session` answers 200 with `authenticated:false` for a token it
   * will not honour, rather than 401 — so the status line alone would call a
   * revoked session live. Read the body and normalise.
   */
  const body = (await res.json()) as { authenticated?: boolean; userId?: string };
  return body.authenticated === false && !body.userId ? 401 : 200;
}

function name(tag: string): string {
  return `e2e_dev_${tag}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

describe('one human, one phone', () => {
  it('BOUNDARY: the first phone signs in with nothing in its way', async () => {
    const who = name('first');
    const a = await login({ nickname: who, kind: 'mobile', device: deviceId('a') });
    expect(a.status).toBe(200);
    expect(a.body.token).toBeTruthy();
  });

  it('BOUNDARY: the SAME phone signing in again is not a second phone', async () => {
    // Reinstalls aside, a phone re-authenticating is the commonest case there
    // is. Treating it as a conflict would show the takeover warning to someone
    // who owns exactly one device.
    const who = name('same');
    const dev = deviceId('same');
    expect((await login({ nickname: who, kind: 'mobile', device: dev })).status).toBe(200);
    expect((await login({ nickname: who, kind: 'mobile', device: dev })).status).toBe(200);
  });

  it('CONTRACT: a SECOND phone is refused, and told whether a backup exists', async () => {
    const who = name('second');
    expect((await login({ nickname: who, kind: 'mobile', device: deviceId('p1') })).status).toBe(200);

    const second = await login({ nickname: who, kind: 'mobile', device: deviceId('p2') });
    expect(second.status).toBe(409);
    expect(second.body.status).toBe('device_conflict');
    expect(Array.isArray(second.body.existingDevices)).toBe(true);
    expect((second.body.existingDevices as unknown[]).length).toBeGreaterThan(0);

    // A fresh account has never backed up, and the answer has to be the real
    // one — this is what decides whether the person is told to stop.
    expect(second.body.hasBackup).toBe(false);
    expect(second.body.backupUpdatedAt).toBeNull();

    // INTEGRITY: the other device's id is NOT handed out. It is what that
    // device proves itself with; returning it would turn a warning into a way
    // to impersonate the device being warned about.
    for (const d of second.body.existingDevices as Array<Record<string, unknown>>) {
      expect(Object.keys(d).sort()).toEqual(['issuedAt', 'kind']);
    }
  });

  it('INTEGRITY: a confirmed takeover ends the first phone — its token stops working', async () => {
    /*
     * The half that did not exist before sessions were recorded. The server
     * minted a JWT and forgot it, so "sign out the other device" had nothing
     * to act on: the old token stayed valid for its full life.
     */
    const who = name('takeover');
    const first = await login({ nickname: who, kind: 'mobile', device: deviceId('old') });
    expect(first.status).toBe(200);
    const oldToken = first.body.token as string;
    expect(await sessionStatus(oldToken)).toBe(200);

    const second = await login({
      nickname: who,
      kind: 'mobile',
      device: deviceId('new'),
      takeover: true,
    });
    expect(second.status).toBe(200);
    const newToken = second.body.token as string;

    expect(await sessionStatus(oldToken)).toBe(401);
    expect(await sessionStatus(newToken)).toBe(200);
  });

  it('AUTHZ: a browser is not a phone — it neither conflicts nor displaces', async () => {
    /*
     * The rule fires where its reason reaches, and no further. A web session
     * cannot read a room at all, so counting it would end someone's phone
     * session over a laptop they opened to read posts.
     */
    const who = name('web');
    const phone = await login({ nickname: who, kind: 'mobile', device: deviceId('phone') });
    expect(phone.status).toBe(200);

    const web = await login({ nickname: who, kind: 'web', device: deviceId('laptop') });
    expect(web.status).toBe(200);

    // Both alive at once.
    expect(await sessionStatus(phone.body.token as string)).toBe(200);
    expect(await sessionStatus(web.body.token as string)).toBe(200);
  });

  it('AUTHZ: chat is refused to a web session by the SERVER', async () => {
    /*
     * Removing the buttons is not the protection — this is. A browser that
     * calls the API directly could otherwise join a group, advance an epoch and
     * post ciphertext nobody will ever open: damage rather than nothing.
     *
     * The gate reads the SIGNED claim in the token, not a header on this
     * request, so a client cannot talk its way past it by saying `mobile`.
     */
    const who = name('webchat');
    const web = await login({ nickname: who, kind: 'web', device: deviceId('laptop') });
    const token = web.body.token as string;

    const res = await fetch(`${BASE}/api/topics/00000000-0000-0000-0000-000000000000/chat`, {
      headers: {
        Authorization: `Bearer ${token}`,
        // HOSTILE: the request insists it is a phone. The claim disagrees.
        'x-openstoa-device-kind': 'mobile',
      },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe('CHAT_MOBILE_ONLY');
  });

  it('AUTHZ: the same request from a PHONE session is not refused for being a browser', async () => {
    // The other half of the gate: it must let the real client through, or the
    // test above would pass with chat broken for everyone.
    const who = name('phonechat');
    const phone = await login({ nickname: who, kind: 'mobile', device: deviceId('phone') });
    const res = await fetch(`${BASE}/api/topics/00000000-0000-0000-0000-000000000000/chat`, {
      headers: { Authorization: `Bearer ${phone.body.token as string}` },
    });
    // 403/404 for not being a member of a topic that does not exist is fine;
    // what must NOT appear is the mobile-only refusal.
    const body = (await res.json().catch(() => ({}))) as { code?: string };
    expect(body.code).not.toBe('CHAT_MOBILE_ONLY');
  });

  it('CONTRACT: signing out ends the session, not just the cookie', async () => {
    /*
     * Logout used to clear a cookie and stop, leaving the token
     * cryptographically valid for weeks — so anyone holding a copy kept using
     * it. On a shared machine that is the whole of the protection failing at
     * the moment someone thought they had used it.
     */
    const who = name('logout');
    const s = await login({ nickname: who, kind: 'mobile', device: deviceId('p') });
    const token = s.body.token as string;
    expect(await sessionStatus(token)).toBe(200);

    const out = await fetch(`${BASE}/api/auth/logout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(out.status).toBe(200);

    expect(await sessionStatus(token)).toBe(401);
  });

  it('RACE: repeated sign-ins from one phone do not stack sessions', async () => {
    // If each login left a live record, the account would look like it had
    // several phones and the rule would fire against its own user.
    const who = name('race');
    const dev = deviceId('one');
    for (let i = 0; i < 3; i += 1) {
      expect((await login({ nickname: who, kind: 'mobile', device: dev })).status).toBe(200);
    }
    // A genuinely different phone still sees exactly one other device.
    const other = await login({ nickname: who, kind: 'mobile', device: deviceId('two') });
    expect(other.status).toBe(409);
    expect((other.body.existingDevices as unknown[]).length).toBe(1);
  });
});

describe('re-minting a token does not sign anybody out', () => {
  /*
   * THE REGRESSION THIS EXISTS FOR, and it reached the whole E2E suite before
   * anyone noticed what it was. Renaming yourself re-mints the token — the
   * nickname is a JWT claim — and the first version of that revoked the old
   * session. So the OLD token died, and every other holder of it was signed
   * out without being told: a second tab, a request already in flight, and the
   * shared token this suite passes between fifty files.
   *
   * Thirty-nine files went red at once and every one of them reported a 401 on
   * an unrelated endpoint. Nothing pointed at a rename.
   *
   * A rename and a refresh both produce a new token; neither is a new session.
   */
  it('CONTRACT: after a rename, the OLD token still works', async () => {
    const who = name('rename');
    const s = await login({ nickname: who, kind: 'mobile', device: deviceId('p') });
    const old = s.body.token as string;
    expect(await sessionStatus(old)).toBe(200);

    // PUT is the method this route exposes — guessing POST and falling back was
    // a way of not looking it up, and it hid a 403 behind a branch.
    const renamed = await fetch(`${BASE}/api/profile/nickname`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${old}`, 'Content-Type': 'application/json' },
      // `^[a-zA-Z0-9_]{2,20}$` — the suite's generated names are longer than
      // that, so the new name is built to the rule rather than derived.
      body: JSON.stringify({ nickname: `rn_${Math.random().toString(36).slice(2, 10)}` }),
    });
    expect(renamed.status).toBe(200);

    expect(await sessionStatus(old), 'the rename signed the old token out').toBe(200);
  });

  it('CONTRACT: after a refresh, the OLD token still works', async () => {
    const who = name('refresh');
    const s = await login({ nickname: who, kind: 'mobile', device: deviceId('p') });
    const old = s.body.token as string;

    const r = await fetch(`${BASE}/api/auth/refresh`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${old}`, 'Content-Type': 'application/json' },
    });
    expect(r.status).toBe(200);
    const fresh = ((await r.json()) as { token: string }).token;

    expect(await sessionStatus(old), 'the refresh signed the old token out').toBe(200);
    expect(await sessionStatus(fresh)).toBe(200);
  });

  it('INTEGRITY: neither one makes the account look like a second device', async () => {
    // The accumulation the revoke was meant to prevent. Re-minting under the
    // same session id is what actually prevents it.
    const who = name('nostack');
    const dev = deviceId('one');
    const s = await login({ nickname: who, kind: 'mobile', device: dev });
    const tok = s.body.token as string;

    await fetch(`${BASE}/api/auth/refresh`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    });

    const second = await login({ nickname: who, kind: 'mobile', device: deviceId('two') });
    expect(second.status).toBe(409);
    expect((second.body.existingDevices as unknown[]).length).toBe(1);
  });
});
