import { describe, it, expect, beforeAll } from 'vitest';
import { getBaseUrl, publicGet , E2E_DEVICE_HEADERS } from './helpers';

/**
 * `GET /api/dm/candidates` over real HTTP against a running container.
 *
 * `src/__tests__/dm-candidates.test.ts` asserts the emitted SQL and
 * `dm-candidates-route.test.ts` the handler branches; only a real database can
 * prove the behaviour that matters:
 *
 *   - **HEADLINE**: a peer sharing THREE topics with the caller comes back as
 *     exactly ONE entry, carrying all three topics in `sharedTopics`.
 *   - the caller is never their own candidate
 *   - a real `kind='dm'` room (created through POST /api/dm) does NOT make its
 *     counterpart a "shared-topic peer"
 *   - a topic whose only member is the caller yields nobody
 *   - a caller in zero topics gets `{ candidates: [] }`, not an error
 *   - UTF-8 (Korean, emoji) and very long nicknames / titles round-trip intact
 *   - `q` escaping: a nickname containing `%`, `_` and `\` is found by typing
 *     those characters literally, and does NOT match everything
 *   - the picker → `POST /api/dm` handshake is idempotent when tapped twice
 */

const BASE_URL = getBaseUrl();

interface DevUser {
  userId: string;
  token: string;
  nickname: string;
}

interface Candidate {
  userId: string;
  nickname: string;
  profileImage: string | null;
  badges: Array<{ type: string; label: string; domain?: string }>;
  sharedTopics: Array<{ id: string; title: string }>;
}

/**
 * Nicknames are UNIQUE — keep them collision-free across runs.
 *
 * The timestamp segment is DECIMAL, not base36, on purpose: this file's own
 * hostile-search test probes literal `b_c` (an unescaped `_` would wrongly
 * act as a SQL single-char wildcard). `uniq('e2e_cand_bob')` puts an
 * underscore right before this segment — a base36 timestamp can start with
 * any of [0-9a-z], so it can coincidentally spell "...bob_c..." and make
 * `bob`'s OWN generated nickname contain the literal probe substring,
 * failing "not toContain(bob.userId)" for a reason that has nothing to do
 * with escaping. Decimal digits can never be 'c' (or any letter), which
 * removes that whole coincidence class at both underscore boundaries.
 */
function uniq(prefix: string): string {
  return `${prefix}_${Date.now().toString()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function devLogin(nickname: string): Promise<DevUser> {
  const res = await fetch(`${BASE_URL}/api/auth/dev-login`, {
    method: 'POST',
    // The suite stands in for the mobile app; a login that declares nothing
    // defaults to `web`, and chat / MLS / TAK are refused to a web session.
    headers: { 'Content-Type': 'application/json', ...E2E_DEVICE_HEADERS },
    body: JSON.stringify({ nickname }),
  });
  if (!res.ok) throw new Error(`dev-login failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return { userId: data.userId, token: data.token, nickname: data.nickname };
}

function asUser(user: DevUser) {
  const headers = (json = false) => ({
    Authorization: `Bearer ${user.token}`,
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  });
  return {
    get: (path: string) => fetch(`${BASE_URL}${path}`, { headers: headers() }),
    post: (path: string, body?: unknown) =>
      fetch(`${BASE_URL}${path}`, {
        method: 'POST',
        headers: headers(true),
        body: body ? JSON.stringify(body) : undefined,
      }),
  };
}

async function candidatesFor(user: DevUser, query = ''): Promise<Candidate[]> {
  const res = await asUser(user).get(`/api/dm/candidates${query}`);
  expect(res.status).toBe(200);
  return (await res.json()).candidates;
}

async function createTopic(owner: DevUser, title: string, categoryId: string): Promise<string> {
  const res = await asUser(owner).post('/api/topics', {
    title,
    description: 'dm candidates E2E',
    visibility: 'public',
    categoryId,
  });
  expect(res.status).toBe(201);
  return (await res.json()).topic.id;
}

async function join(user: DevUser, topicId: string): Promise<void> {
  const res = await asUser(user).post(`/api/topics/${topicId}/join`, {});
  expect([200, 201, 409]).toContain(res.status);
}

// ── Fixtures ────────────────────────────────────────────────────────────────
//
// alice owns three topics. bob joins ALL THREE (the de-duplication probe),
// carol joins only the first, dave joins none, and `loner` owns a topic nobody
// else ever joins.

let alice: DevUser;
let bob: DevUser;
let carol: DevUser;
let dave: DevUser;
let loner: DevUser;
let topicA: string;
let topicB: string;
let topicC: string;
let titleA: string;
let titleB: string;
let titleC: string;

beforeAll(async () => {
  const cats = await (await publicGet('/api/categories')).json();
  const categoryId = cats.categories[0].id;

  alice = await devLogin(uniq('e2e_cand_alice'));
  bob = await devLogin(uniq('e2e_cand_bob'));
  carol = await devLogin(uniq('e2e_cand_carol'));
  dave = await devLogin(uniq('e2e_cand_dave'));
  loner = await devLogin(uniq('e2e_cand_loner'));

  titleA = `Cand A ${Date.now()}`;
  titleB = `Cand B ${Date.now()}`;
  titleC = `Cand C ${Date.now()}`;
  topicA = await createTopic(alice, titleA, categoryId);
  topicB = await createTopic(alice, titleB, categoryId);
  topicC = await createTopic(alice, titleC, categoryId);

  await join(bob, topicA);
  await join(bob, topicB);
  await join(bob, topicC);
  await join(carol, topicA);
  await createTopic(loner, `Cand solo ${Date.now()}`, categoryId);
}, 120000);

describe('GET /api/dm/candidates — de-duplication (headline)', () => {
  it('returns a three-topic peer EXACTLY ONCE, with all three topics attached', async () => {
    const candidates = await candidatesFor(alice);

    const bobRows = candidates.filter((c) => c.userId === bob.userId);
    expect(bobRows).toHaveLength(1);

    const sharedIds = bobRows[0].sharedTopics.map((t) => t.id).sort();
    expect(sharedIds).toEqual([topicA, topicB, topicC].sort());
    // And no duplicate topic entries inside the aggregate either.
    expect(new Set(sharedIds).size).toBe(3);
  });

  it('never repeats ANY userId in the response', async () => {
    const candidates = await candidatesFor(alice);
    const ids = candidates.map((c) => c.userId);
    expect(ids.length).toBe(new Set(ids).size);
  });

  it('lists a single-topic peer with just that topic', async () => {
    const [carolRow] = (await candidatesFor(alice)).filter((c) => c.userId === carol.userId);
    expect(carolRow).toBeDefined();
    expect(carolRow.sharedTopics.map((t) => t.id)).toEqual([topicA]);
  });

  it('is symmetric: bob sees alice and carol, since he shares topics with both', async () => {
    const ids = (await candidatesFor(bob)).map((c) => c.userId);
    expect(ids).toContain(alice.userId);
    expect(ids).toContain(carol.userId);
  });
});

describe('GET /api/dm/candidates — exclusions', () => {
  it('never includes the caller themselves', async () => {
    for (const user of [alice, bob, carol]) {
      const ids = (await candidatesFor(user)).map((c) => c.userId);
      expect(ids).not.toContain(user.userId);
    }
  });

  it('excludes someone who shares no topic with the caller', async () => {
    const ids = (await candidatesFor(alice)).map((c) => c.userId);
    expect(ids).not.toContain(dave.userId);
  });

  it('returns an empty list (200) for a caller in zero topics', async () => {
    const candidates = await candidatesFor(dave);
    expect(candidates).toEqual([]);
  });

  it('returns nobody for a topic whose only member is the caller', async () => {
    expect(await candidatesFor(loner)).toEqual([]);
  });

  it("a DM room does NOT make its counterpart a shared-topic peer", async () => {
    // dave and loner share nothing; opening a DM creates a kind='dm' topic that
    // both are members of. If the query counted it, they'd appear to each other.
    const res = await asUser(dave).post('/api/dm', { userId: loner.userId });
    expect([200, 201]).toContain(res.status);
    const dmTopicId = (await res.json()).topicId;

    const daveCands = await candidatesFor(dave);
    const lonerCands = await candidatesFor(loner);
    expect(daveCands.map((c) => c.userId)).not.toContain(loner.userId);
    expect(lonerCands.map((c) => c.userId)).not.toContain(dave.userId);
    // And the DM room must never surface as a "shared topic" for anyone.
    const everySharedTopicId = [...daveCands, ...lonerCands].flatMap((c) =>
      c.sharedTopics.map((t) => t.id),
    );
    expect(everySharedTopicId).not.toContain(dmTopicId);
  });

  it('401 for an unauthenticated caller', async () => {
    const res = await fetch(`${BASE_URL}/api/dm/candidates`);
    expect(res.status).toBe(401);
  });
});

describe('GET /api/dm/candidates — FIX9: existing DM partners are excluded, but still DM-able', () => {
  // Dedicated fixtures (not the shared alice/bob/carol above) — starting a
  // real DM here is a one-way mutation for the rest of this file's run, so it
  // must not corrupt the de-duplication/shared-topic assertions those tests
  // make against the shared fixtures.
  let erin: DevUser;
  let frank: DevUser;
  let sharedTopicId: string;

  beforeAll(async () => {
    const cats = await (await publicGet('/api/categories')).json();
    const categoryId = cats.categories[0].id;

    erin = await devLogin(uniq('e2e_cand_erin'));
    frank = await devLogin(uniq('e2e_cand_frank'));

    sharedTopicId = await createTopic(erin, `Cand FIX9 ${Date.now()}`, categoryId);
    await join(frank, sharedTopicId);
  }, 120000);

  it('a shared-topic peer with NO existing DM is a candidate for both sides', async () => {
    const erinCands = (await candidatesFor(erin)).map((c) => c.userId);
    const frankCands = (await candidatesFor(frank)).map((c) => c.userId);
    expect(erinCands).toContain(frank.userId);
    expect(frankCands).toContain(erin.userId);
  });

  it('starting a DM removes the counterpart from BOTH sides candidates list, even though they still share a real topic', async () => {
    const res = await asUser(erin).post('/api/dm', { userId: frank.userId });
    expect([200, 201]).toContain(res.status);

    const erinCands = (await candidatesFor(erin)).map((c) => c.userId);
    const frankCands = (await candidatesFor(frank)).map((c) => c.userId);
    expect(erinCands).not.toContain(frank.userId);
    expect(frankCands).not.toContain(erin.userId);

    // The shared REAL topic is untouched — they just no longer show up as a
    // "new conversation" candidate for each other.
    const stillJoint = await asUser(erin).get(`/api/topics/${sharedTopicId}/members`);
    const memberIds = (await stillJoint.json()).members.map((m: { userId: string }) => m.userId);
    expect(memberIds).toContain(erin.userId);
    expect(memberIds).toContain(frank.userId);
  });

  it('POST /api/dm still succeeds (idempotent) for an existing partner absent from the candidates list', async () => {
    // Confirms the exclusion is picker-only, not an actual DM-eligibility
    // rule — POST /api/dm never re-derives eligibility from the candidates
    // query.
    const res = await asUser(frank).post('/api/dm', { userId: erin.userId });
    expect(res.status).toBe(200); // idempotent hit, not a fresh 201
  });

  it('GET /api/dm (not /api/dm/candidates) is where an existing partner is discoverable', async () => {
    const dms = await (await asUser(erin).get('/api/dm')).json();
    expect(dms.dms.map((d: { peer: { userId: string } }) => d.peer.userId)).toContain(frank.userId);
  });
});

describe('GET /api/dm/candidates — payload shape', () => {
  it('exposes only picker-relevant fields', async () => {
    const [row] = await candidatesFor(alice);
    expect(Object.keys(row).sort()).toEqual([
      'badges',
      'nickname',
      'profileImage',
      'sharedTopics',
      'userId',
    ]);
    expect(Object.keys(row.sharedTopics[0]).sort()).toEqual(['id', 'title']);
  });

  it('shows no badges for peers reached only through open topics', async () => {
    const [bobRow] = (await candidatesFor(alice)).filter((c) => c.userId === bob.userId);
    expect(bobRow.badges).toEqual([]);
  });

  it('carries the real topic titles so the picker can explain the connection', async () => {
    const [bobRow] = (await candidatesFor(alice)).filter((c) => c.userId === bob.userId);
    expect(bobRow.sharedTopics.map((t) => t.title).sort()).toEqual([titleA, titleB, titleC].sort());
  });
});

describe('GET /api/dm/candidates — UTF-8, length and hostile search', () => {
  let korean: DevUser;
  let wildcard: DevUser;
  let longName: DevUser;
  let utfTopic: string;

  beforeAll(async () => {
    const cats = await (await publicGet('/api/categories')).json();
    const categoryId = cats.categories[0].id;

    korean = await devLogin(uniq('김철수_🦊'));
    // A nickname loaded with ilike metacharacters: % _ and a backslash.
    wildcard = await devLogin(uniq('a%b_c\\d'));
    longName = await devLogin(uniq('L'.repeat(40)));

    utfTopic = await createTopic(alice, `한국어 토픽 🎉 ${Date.now()}`, categoryId);
    await join(korean, utfTopic);
    await join(wildcard, utfTopic);
    await join(longName, utfTopic);
  }, 120000);

  it('round-trips Korean + emoji nicknames and topic titles intact', async () => {
    const [row] = (await candidatesFor(alice)).filter((c) => c.userId === korean.userId);
    expect(row.nickname).toBe(korean.nickname);
    expect(row.nickname).toMatch(/김철수_🦊/);
    const utf = row.sharedTopics.find((t) => t.id === utfTopic)!;
    expect(utf.title).toMatch(/한국어 토픽 🎉/);
  });

  it('finds a Korean nickname by a Korean substring', async () => {
    const ids = (await candidatesFor(alice, '?q=김철수')).map((c) => c.userId);
    expect(ids).toContain(korean.userId);
    expect(ids).not.toContain(bob.userId);
  });

  it('does not truncate a long nickname', async () => {
    const [row] = (await candidatesFor(alice)).filter((c) => c.userId === longName.userId);
    expect(row.nickname).toBe(longName.nickname);
  });

  it('matches % _ and \\ LITERALLY instead of as wildcards', async () => {
    // A bare `%` must NOT behave as match-everything.
    const pct = await candidatesFor(alice, '?q=%25');
    expect(pct.map((c) => c.userId)).toEqual([wildcard.userId]);

    // `_` is the single-char wildcard in SQL; escaped it matches literally.
    const underscore = await candidatesFor(alice, '?q=b_c');
    expect(underscore.map((c) => c.userId)).toContain(wildcard.userId);
    expect(underscore.map((c) => c.userId)).not.toContain(bob.userId);

    // Backslash — the escape character itself.
    const backslash = await candidatesFor(alice, `?q=${encodeURIComponent('c\\d')}`);
    expect(backslash.map((c) => c.userId)).toEqual([wildcard.userId]);
  });

  it('treats blank / whitespace-only q as "no filter", not as match-everything', async () => {
    const all = await candidatesFor(alice);
    expect((await candidatesFor(alice, '?q=')).length).toBe(all.length);
    expect((await candidatesFor(alice, '?q=%20%20%20')).length).toBe(all.length);
  });

  it('returns an empty list for a query nobody matches', async () => {
    expect(await candidatesFor(alice, '?q=zzz_no_such_person_zzz')).toEqual([]);
  });

  it('accepts a very long q without erroring (clipped server-side)', async () => {
    const res = await asUser(alice).get(`/api/dm/candidates?q=${'x'.repeat(5000)}`);
    expect(res.status).toBe(200);
    expect((await res.json()).candidates).toEqual([]);
  });

  it('clamps limit: 0 / negative / huge never error, and limit=1 returns one row', async () => {
    for (const limit of ['0', '-1', '999999', 'abc']) {
      const res = await asUser(alice).get(`/api/dm/candidates?limit=${limit}`);
      expect(res.status).toBe(200);
      expect((await res.json()).candidates.length).toBeGreaterThan(0);
    }
    expect((await candidatesFor(alice, '?limit=1')).length).toBe(1);
  });
});

describe('picker → POST /api/dm handshake', () => {
  it('starting a DM with a candidate twice is idempotent (no second room)', async () => {
    const [target] = (await candidatesFor(alice)).filter((c) => c.userId === carol.userId);
    expect(target).toBeDefined();

    const first = await asUser(alice).post('/api/dm', { userId: target.userId });
    expect([200, 201]).toContain(first.status);
    const topicId = (await first.json()).topicId;

    const second = await asUser(alice).post('/api/dm', { userId: target.userId });
    expect(second.status).toBe(200);
    expect((await second.json()).topicId).toBe(topicId);

    // Exactly one DM row with carol, even after the double tap.
    const dms = (await (await asUser(alice).get('/api/dm')).json()).dms as Array<{
      topicId: string;
      peer: { userId: string };
    }>;
    expect(dms.filter((d) => d.peer.userId === carol.userId)).toHaveLength(1);
  });

  it('a candidate stays DM-able and the room reuses the shared chat stack', async () => {
    const res = await asUser(bob).post('/api/dm', { userId: alice.userId });
    expect([200, 201]).toContain(res.status);
    const { topicId } = await res.json();
    const chat = await asUser(bob).get(`/api/topics/${topicId}/chat?limit=5`);
    expect(chat.status).toBe(200);
  });
});
