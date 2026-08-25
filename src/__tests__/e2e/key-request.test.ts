/**
 * Asking a member to unlock the stretch of history a recovered phone cannot read.
 *
 * THE SITUATION. A recovery on a new phone brings back `public` rooms in full —
 * the server holds the archive root. `private`, `secret` and `dm` come back only
 * as far as the OLD phone's last backup: epochs that advanced while it was off
 * never reached that device's keychain, so they were never in the blob. Backing
 * up more often cannot help, because you cannot upload a key you never received.
 *
 * The keys still exist, on the devices of members who were online. So the
 * missing step is not cryptography — it is ASKING, and the ask has to outlive
 * the moment, because the member who can grant is rarely looking at their phone
 * right then.
 *
 * WHY OVER HTTP. The parts that can be wrong here are all at the seams: who is
 * allowed to ask, whether a second ask stacks, whether two members answering at
 * once double-send, and whether the asker can tell the difference between
 * "waiting" and "answered". None of those are visible in a unit test of the
 * store, because every one of them is a route, a session and an index acting
 * together.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage
 *   contract   → ask → it appears for other members → grant → asker sees granted
 *   race       → asking twice does not stack; the list still holds one row
 *   race       → two members granting at once = one grant, one `alreadyGranted`
 *   authz      → a non-member cannot ask, cannot list, cannot grant
 *   authz      → a guest gets 401 everywhere
 *   empty      → a room with no requests answers with an empty list, not an error
 *   empty      → asking with no `deviceId` is refused
 *   boundary   → `haveFromEpoch` 0 is kept (it means "I have epoch 0"), and a
 *                negative / fractional / absurd value degrades to null rather
 *                than failing the ask
 *   hostile    → a device id of 256 chars is accepted, 257 refused; a bogus
 *                requestId is refused rather than silently matching nothing
 *   integrity  → granting does not require ownership — every member holds these
 *                keys, so an owner-only rule would only mean the one person who
 *                can help is the least likely to be online
 */
import { describe, it, expect } from 'vitest';
import { getBaseUrl } from './helpers';

const BASE = getBaseUrl();

async function signIn(tag: string): Promise<{ token: string; userId: string }> {
  const res = await fetch(`${BASE}/api/auth/dev-login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-openstoa-device-kind': 'mobile',
      'x-openstoa-device-id': `e2e-kr-${tag}-${Math.random().toString(36).slice(2, 10)}`,
    },
    body: JSON.stringify({
      nickname: `e2e_kr_${tag}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
    }),
  });
  return (await res.json()) as { token: string; userId: string };
}

function auth(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

/** The first category the server offers — topics require one. */
let _categoryId: string | null = null;
async function categoryId(): Promise<string> {
  if (_categoryId) return _categoryId;
  const res = await fetch(`${BASE}/api/categories`);
  const body = (await res.json()) as { categories: Array<{ id: string }> };
  const first = body.categories?.[0]?.id;
  if (!first) throw new Error('no categories on this server');
  _categoryId = first;
  return first;
}

/** A room with `owner` in it. */
async function makeTopic(token: string): Promise<string> {
  const cat = await categoryId();
  const res = await fetch(`${BASE}/api/topics`, {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({
      title: `e2e-keyreq-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      description: 'key request e2e',
      visibility: 'public',
      categoryId: cat,
    }),
  });
  const body = (await res.json()) as { topic?: { id: string }; id?: string };
  const id = body.topic?.id ?? body.id;
  if (!id) throw new Error(`topic create failed: ${JSON.stringify(body)}`);
  return id;
}

async function join(token: string, topicId: string): Promise<void> {
  await fetch(`${BASE}/api/topics/${topicId}/join`, { method: 'POST', headers: auth(token) });
}

function reqUrl(topicId: string, deviceId?: string): string {
  const q = deviceId ? `?deviceId=${encodeURIComponent(deviceId)}` : '';
  return `${BASE}/api/topics/${topicId}/keys/request${q}`;
}

describe('asking for the missing keys', () => {
  it('CONTRACT: ask → a member sees it → grants → the asker sees it answered', async () => {
    const owner = await signIn('owner');
    const asker = await signIn('asker');
    const topicId = await makeTopic(owner.token);
    await join(asker.token, topicId);

    const device = 'asker-device-1';

    // Nobody is waiting yet.
    const before = await (await fetch(reqUrl(topicId), { headers: auth(owner.token) })).json();
    expect((before as { requests: unknown[] }).requests).toHaveLength(0);

    // The ask.
    const ask = await fetch(reqUrl(topicId), {
      method: 'POST',
      headers: auth(asker.token),
      body: JSON.stringify({ deviceId: device, haveFromEpoch: 4 }),
    });
    expect(ask.status).toBe(201);

    // A member sees who is waiting, and from which epoch they can already read.
    const list = (await (
      await fetch(reqUrl(topicId), { headers: auth(owner.token) })
    ).json()) as { requests: Array<{ id: string; haveFromEpoch: number | null }> };
    expect(list.requests).toHaveLength(1);
    expect(list.requests[0].haveFromEpoch).toBe(4);

    // The asker can see their own request is still open.
    const mineBefore = (await (
      await fetch(reqUrl(topicId, device), { headers: auth(asker.token) })
    ).json()) as { mine: { granted: boolean } | null };
    expect(mineBefore.mine?.granted).toBe(false);

    // The member answers. (The sealed bundle goes over `tak_bundles` first —
    // this route only marks the ask answered, which is why order matters.)
    const grant = await fetch(`${BASE}/api/topics/${topicId}/keys/grant`, {
      method: 'POST',
      headers: auth(owner.token),
      body: JSON.stringify({ requestId: list.requests[0].id }),
    });
    expect(grant.status).toBe(200);
    expect(((await grant.json()) as { alreadyGranted: boolean }).alreadyGranted).toBe(false);

    // The asker stops waiting, and the row leaves the member's list.
    const mineAfter = (await (
      await fetch(reqUrl(topicId, device), { headers: auth(asker.token) })
    ).json()) as { mine: { granted: boolean } | null; requests: unknown[] };
    expect(mineAfter.mine?.granted).toBe(true);
    expect(mineAfter.requests).toHaveLength(0);
  });

  it('RACE: asking twice does not stack — one device, one row', async () => {
    /*
     * A screen that retries on every mount would otherwise turn one person's
     * tap into a queue nobody reads to the end, and the second row would tell a
     * granting member nothing the first did not.
     */
    const owner = await signIn('owner2');
    const asker = await signIn('asker2');
    const topicId = await makeTopic(owner.token);
    await join(asker.token, topicId);

    for (const epoch of [1, 2, 3]) {
      const res = await fetch(reqUrl(topicId), {
        method: 'POST',
        headers: auth(asker.token),
        body: JSON.stringify({ deviceId: 'one-device', haveFromEpoch: epoch }),
      });
      expect(res.status).toBe(201);
    }

    const list = (await (
      await fetch(reqUrl(topicId), { headers: auth(owner.token) })
    ).json()) as { requests: Array<{ haveFromEpoch: number }> };
    expect(list.requests).toHaveLength(1);
    // And it carries the LATEST answer, not the first.
    expect(list.requests[0].haveFromEpoch).toBe(3);
  });

  it('RACE: two members granting at once produce one grant and one no-op', async () => {
    const owner = await signIn('owner3');
    const other = await signIn('other3');
    const asker = await signIn('asker3');
    const topicId = await makeTopic(owner.token);
    await join(other.token, topicId);
    await join(asker.token, topicId);

    await fetch(reqUrl(topicId), {
      method: 'POST',
      headers: auth(asker.token),
      body: JSON.stringify({ deviceId: 'race-device' }),
    });
    const list = (await (
      await fetch(reqUrl(topicId), { headers: auth(owner.token) })
    ).json()) as { requests: Array<{ id: string }> };
    const id = list.requests[0].id;

    const [a, b] = await Promise.all([
      fetch(`${BASE}/api/topics/${topicId}/keys/grant`, {
        method: 'POST',
        headers: auth(owner.token),
        body: JSON.stringify({ requestId: id }),
      }).then((r) => r.json() as Promise<{ alreadyGranted: boolean }>),
      fetch(`${BASE}/api/topics/${topicId}/keys/grant`, {
        method: 'POST',
        headers: auth(other.token),
        body: JSON.stringify({ requestId: id }),
      }).then((r) => r.json() as Promise<{ alreadyGranted: boolean }>),
    ]);

    // Exactly one of them did the granting; neither got an error for trying.
    expect([a.alreadyGranted, b.alreadyGranted].filter((x) => x === false)).toHaveLength(1);
  });

  it('INTEGRITY: granting does not require ownership', async () => {
    /*
     * These are keys every member of the room already holds. An owner-only rule
     * would protect nothing and would mean the one person able to help is the
     * least likely to be online.
     */
    const owner = await signIn('owner4');
    const helper = await signIn('helper4');
    const asker = await signIn('asker4');
    const topicId = await makeTopic(owner.token);
    await join(helper.token, topicId);
    await join(asker.token, topicId);

    await fetch(reqUrl(topicId), {
      method: 'POST',
      headers: auth(asker.token),
      body: JSON.stringify({ deviceId: 'd' }),
    });
    const list = (await (
      await fetch(reqUrl(topicId), { headers: auth(helper.token) })
    ).json()) as { requests: Array<{ id: string }> };

    const grant = await fetch(`${BASE}/api/topics/${topicId}/keys/grant`, {
      method: 'POST',
      headers: auth(helper.token),
      body: JSON.stringify({ requestId: list.requests[0].id }),
    });
    expect(grant.status).toBe(200);
  });
});

describe('who may ask and answer', () => {
  it('AUTHZ: a non-member cannot ask, list, or grant', async () => {
    const owner = await signIn('owner5');
    const stranger = await signIn('stranger5');
    const topicId = await makeTopic(owner.token);

    const ask = await fetch(reqUrl(topicId), {
      method: 'POST',
      headers: auth(stranger.token),
      body: JSON.stringify({ deviceId: 'd' }),
    });
    expect(ask.status).toBe(403);

    const list = await fetch(reqUrl(topicId), { headers: auth(stranger.token) });
    expect(list.status).toBe(403);

    const grant = await fetch(`${BASE}/api/topics/${topicId}/keys/grant`, {
      method: 'POST',
      headers: auth(stranger.token),
      body: JSON.stringify({ requestId: '00000000-0000-0000-0000-000000000000' }),
    });
    expect(grant.status).toBe(403);
  });

  it('AUTHZ: a guest gets 401 everywhere', async () => {
    const owner = await signIn('owner6');
    const topicId = await makeTopic(owner.token);

    expect((await fetch(reqUrl(topicId))).status).toBe(401);
    expect(
      (
        await fetch(reqUrl(topicId), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ deviceId: 'd' }),
        })
      ).status,
    ).toBe(401);
  });
});

describe('the shape of an ask', () => {
  it('EMPTY: no deviceId is refused — there is nothing to address a grant to', async () => {
    const owner = await signIn('owner7');
    const topicId = await makeTopic(owner.token);
    for (const body of [{}, { deviceId: '' }, { deviceId: '   ' }]) {
      const res = await fetch(reqUrl(topicId), {
        method: 'POST',
        headers: auth(owner.token),
        body: JSON.stringify(body),
      });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('BOUNDARY: epoch 0 is kept; nonsense degrades to null rather than failing', async () => {
    /*
     * Zero is a real answer — "I can read from the very first epoch" — and the
     * classic falsy-check bug turns it into "I can read nothing", which asks a
     * member to re-send the entire history.
     *
     * A negative or fractional value only makes the grant SMALLER, so refusing
     * would fail the whole ask over a field that cannot cause harm. Null means
     * "send everything", which is the safe reading.
     */
    const owner = await signIn('owner8');
    const topicId = await makeTopic(owner.token);

    await fetch(reqUrl(topicId), {
      method: 'POST',
      headers: auth(owner.token),
      body: JSON.stringify({ deviceId: 'zero', haveFromEpoch: 0 }),
    });
    const zero = (await (
      await fetch(reqUrl(topicId, 'zero'), { headers: auth(owner.token) })
    ).json()) as { requests: Array<{ requesterDeviceId: string; haveFromEpoch: number | null }> };
    expect(zero.requests.find((r) => r.requesterDeviceId === 'zero')?.haveFromEpoch).toBe(0);

    for (const bad of [-1, 1.5, Number.MAX_SAFE_INTEGER + 10, 'x', null]) {
      const res = await fetch(reqUrl(topicId), {
        method: 'POST',
        headers: auth(owner.token),
        body: JSON.stringify({ deviceId: `bad-${String(bad)}`, haveFromEpoch: bad }),
      });
      expect(res.status, `haveFromEpoch=${String(bad)}`).toBe(201);
    }
    const after = (await (
      await fetch(reqUrl(topicId), { headers: auth(owner.token) })
    ).json()) as { requests: Array<{ requesterDeviceId: string; haveFromEpoch: number | null }> };
    for (const r of after.requests.filter((x) => x.requesterDeviceId.startsWith('bad-'))) {
      expect(r.haveFromEpoch, r.requesterDeviceId).toBeNull();
    }
  });

  it('BOUNDARY: a 256-char device id is accepted, 257 refused', async () => {
    const owner = await signIn('owner9');
    const topicId = await makeTopic(owner.token);
    expect(
      (
        await fetch(reqUrl(topicId), {
          method: 'POST',
          headers: auth(owner.token),
          body: JSON.stringify({ deviceId: 'a'.repeat(256) }),
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await fetch(reqUrl(topicId), {
          method: 'POST',
          headers: auth(owner.token),
          body: JSON.stringify({ deviceId: 'b'.repeat(257) }),
        })
      ).status,
    ).toBe(400);
  });

  it('HOSTILE: a bogus requestId is refused rather than matching nothing quietly', async () => {
    const owner = await signIn('owner10');
    const topicId = await makeTopic(owner.token);
    for (const bad of ['', 'not-a-uuid', '../../etc/passwd']) {
      const res = await fetch(`${BASE}/api/topics/${topicId}/keys/grant`, {
        method: 'POST',
        headers: auth(owner.token),
        body: JSON.stringify({ requestId: bad }),
      });
      expect(res.status, bad).toBe(400);
    }
  });

  it('EMPTY: a room nobody has asked in answers with a list, not an error', async () => {
    const owner = await signIn('owner11');
    const topicId = await makeTopic(owner.token);
    const res = await fetch(reqUrl(topicId, 'never-asked'), { headers: auth(owner.token) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { requests: unknown[]; mine: unknown };
    expect(body.requests).toEqual([]);
    expect(body.mine).toBeNull();
  });
});
