import { E2E_DEVICE_HEADERS } from './helpers';
/**
 * A secret topic is invisible to everyone who is not in it — every way of
 * looking.
 *
 * This is the whole meaning of the tier, and it is easy to hole without
 * noticing: the visibility check lives in ONE filter, and every listing path —
 * browse, category filter, search, guest — runs through it. An exemption added
 * to that filter for some unrelated reason punches through the tier for every
 * caller at once.
 *
 * That is not hypothetical. A personal space was briefly exempted from the
 * category filter so it would "always show", and the exemption landed on the
 * browse path: `GET /api/topics?view=all&category=general` then returned a
 * `My space` row with no category at all. It leaked to its own owner rather
 * than to a stranger, so nothing looked wrong — the tier's promise was simply
 * no longer being kept by that path.
 *
 * So this asserts the property from the OUTSIDE, as a second account, and
 * covers the ways a topic can be looked for rather than just the one that
 * broke.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage
 *   authz     → a stranger's browse does not contain it
 *   authz     → a stranger's SEARCH by its exact title finds nothing
 *   authz     → a stranger's category-filtered browse does not contain it
 *   authz     → a GUEST (no token) sees it in none of the above
 *   contract  → the MEMBER does see it, or the test proves nothing
 *   integrity → the same holds for a personal space, which is secret too
 *   integrity → a filtered browse returns only rows in that category
 */
import { describe, it, expect, beforeAll } from 'vitest';

const BASE = process.env.E2E_BASE_URL || 'http://localhost:3200';
const bearer = (t: string) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${t}` });

async function login(prefix: string): Promise<{ token: string; userId: string }> {
  const r = await fetch(`${BASE}/api/auth/dev-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...E2E_DEVICE_HEADERS },
    body: JSON.stringify({ nickname: `e2e_${prefix}_${Date.now().toString(36)}` }),
  });
  return r.json();
}

interface Row { id: string; title: string; categoryId: string | null; personal?: boolean }

async function raw(query: string, token?: string): Promise<{ topics: Row[]; pinned?: Row | null }> {
  const r = await fetch(`${BASE}/api/topics${query}`, {
    headers: token ? bearer(token) : { 'Content-Type': 'application/json' },
  });
  if (!r.ok) throw new Error(`topics${query} -> ${r.status}`);
  const b = await r.json();
  return Array.isArray(b) ? { topics: b as Row[] } : (b as { topics: Row[]; pinned?: Row | null });
}

async function list(query: string, token?: string): Promise<Row[]> {
  return (await raw(query, token)).topics;
}

describe('a secret topic stays hidden (E2E, real container)', () => {
  let owner: { token: string; userId: string };
  let stranger: { token: string; userId: string };
  let secretId: string;
  let secretTitle: string;
  let categoryId: string;
  /** The filter takes the category SLUG, not its id — `?category=<slug>`. */
  let categorySlug: string;
  let personalId: string;

  beforeAll(async () => {
    owner = await login('hide_owner');
    stranger = await login('hide_stranger');
    const cats = await (await fetch(`${BASE}/api/categories`)).json();
    categoryId = cats.categories[0].id;
    categorySlug = cats.categories[0].slug;

    secretTitle = `zz-secret-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const made = await (
      await fetch(`${BASE}/api/topics`, {
        method: 'POST',
        headers: bearer(owner.token),
        body: JSON.stringify({
          title: secretTitle,
          description: 'nobody else should ever see this row',
          visibility: 'secret',
          categoryId,
        }),
      })
    ).json();
    secretId = made.topic?.id ?? made.id;

    personalId = (await list('', owner.token)).find((t) => t.personal)!.id;
  });

  it('CONTRACT: the owner DOES see it — otherwise this file proves nothing', async () => {
    const mine = await list('', owner.token);
    expect(mine.some((t) => t.id === secretId)).toBe(true);
    expect(mine.some((t) => t.id === personalId)).toBe(true);
  });

  it('AUTHZ: a stranger browsing does not see it', async () => {
    const theirs = await list('?view=all&sort=new', stranger.token);
    expect(theirs.some((t) => t.id === secretId)).toBe(false);
    expect(theirs.some((t) => t.id === personalId)).toBe(false);
  });

  it('AUTHZ: a stranger SEARCHING its exact title finds nothing', async () => {
    // Search runs its match in the database and filters visibility afterwards,
    // so a title nobody else could guess is exactly the probe that would catch
    // the filter being skipped on this path.
    const hits = await list(`?view=all&q=${encodeURIComponent(secretTitle)}`, stranger.token);
    expect(hits.some((t) => t.id === secretId)).toBe(false);
  });

  it('AUTHZ: a stranger filtering by its category does not see it', async () => {
    const hits = await list(`?view=all&category=${categorySlug}&sort=new`, stranger.token);
    expect(hits.some((t) => t.id === secretId)).toBe(false);
    expect(hits.some((t) => t.id === personalId)).toBe(false);
  });

  it('AUTHZ: a GUEST sees it in none of those', async () => {
    for (const q of ['?view=all&sort=new', `?view=all&q=${encodeURIComponent(secretTitle)}`, `?view=all&category=${categorySlug}`]) {
      const rows = await list(q);
      expect(rows.some((t) => t.id === secretId), `guest saw it via ${q}`).toBe(false);
      expect(rows.some((t) => t.id === personalId), `guest saw the personal space via ${q}`).toBe(false);
    }
  });

  it('INTEGRITY: a filtered browse returns ONLY rows in that category', async () => {
    /*
     * The invariant the exemption broke. Asserted over the owner's own view,
     * because that is where the leak was visible — the row belonged to them,
     * which is why it went unnoticed.
     */
    const rows = await list(`?view=all&category=${categorySlug}&sort=new`, owner.token);
    const strays = rows.filter((t) => t.categoryId !== categoryId);
    expect({ rowsOutsideTheFilteredCategory: strays.map((t) => t.title) }).toEqual({
      rowsOutsideTheFilteredCategory: [],
    });
  });
});

describe('the space is always reachable, whatever is being looked for', () => {
  /*
   * It rides ALONGSIDE the browse list rather than inside it. Inside, it would
   * break the only promise that array makes — every row matched the query — so
   * a search for something else would return a row that is not a result, and a
   * category filter would return a row with no category. Beside it, the array
   * keeps its meaning and the space keeps its guarantee.
   *
   * EDGE-CASE MATRIX (CLAUDE.md) → coverage
   *   contract  → it comes back under a category filter that excludes it
   *   contract  → it comes back under a search that cannot match it
   *   integrity → it is NOT inside the filtered array either time
   *   authz     → a stranger's `pinned` is their OWN space, never this one
   *   authz     → a guest gets no pinned space at all
   *   integrity → in the joined list it sorts FIRST
   */
  let owner: { token: string; userId: string };
  let stranger: { token: string; userId: string };
  let mine: string;
  let categorySlug: string;

  beforeAll(async () => {
    owner = await login('pin_owner');
    stranger = await login('pin_stranger');
    const cats = await (await fetch(`${BASE}/api/categories`)).json();
    categorySlug = cats.categories[0].slug;
    mine = (await list('', owner.token)).find((t) => t.personal)!.id;
  });

  it('REGRESSION: the PLAIN browse returns it once — beside, not inside', async () => {
    /*
     * The case the first round of these tests missed, and the commonest of the
     * three. Both filtered cases passed for reasons that had nothing to do with
     * the rule: a category filter dropped the space because it has no category,
     * and a search dropped it because the `ilike` runs in the database. With
     * neither applied, nothing was excluding it, so it came back in `topics`
     * AND in `pinned` — and a client drawing the pinned row above the list
     * showed "My space" twice.
     *
     * Asserting "exactly once, and on the pinned side" rather than "present",
     * because present was already true when it was wrong.
     */
    const res = await raw('?view=all&sort=new', owner.token);
    expect(res.pinned?.id).toBe(mine);
    expect(res.topics.filter((t) => t.id === mine)).toHaveLength(0);
  });

  it('CONTRACT: a category filter cannot hide it', async () => {
    const res = await raw(`?view=all&category=${categorySlug}&sort=new`, owner.token);
    expect(res.pinned?.id).toBe(mine);
    // ...and it is not smuggled into the filtered rows.
    expect(res.topics.some((t) => t.id === mine)).toBe(false);
  });

  it('CONTRACT: a search that cannot match it still returns it', async () => {
    const res = await raw(`?view=all&q=${encodeURIComponent('zzz-nothing-matches-this-' + Date.now())}`, owner.token);
    expect(res.pinned?.id).toBe(mine);
    expect(res.topics.some((t) => t.id === mine)).toBe(false);
  });

  it('AUTHZ: a stranger is pinned their OWN space, never this one', async () => {
    const res = await raw('?view=all&sort=new', stranger.token);
    expect(res.pinned?.id).not.toBe(mine);
    expect(res.pinned?.personal).toBe(true);
  });

  it('AUTHZ: a guest gets no pinned space', async () => {
    const res = await raw('?view=all&sort=new');
    expect(res.pinned ?? null).toBeNull();
  });

  it('INTEGRITY: in the joined list it sorts first', async () => {
    // Always present was already true; findable among thirty topics was not.
    const joined = await list('', owner.token);
    expect(joined[0]?.id).toBe(mine);
  });
});

describe('what a private post never reaches', () => {
  /*
   * The list endpoints hide the TOPIC. This is the other half: the posts
   * inside it are ordinary post rows, and every feed, search and tag listing
   * reads those rows rather than the topic list. A topic that is invisible
   * while its contents are not would be worse than no privacy at all, because
   * the person believes the opposite.
   *
   * Probed with a marker string nobody else could produce, so a hit is proof
   * rather than a coincidence, and asserted from a SECOND account and from no
   * account at all — the two readers who must never see it.
   *
   * EDGE-CASE MATRIX (CLAUDE.md) → coverage
   *   authz     → a stranger's feed does not contain it
   *   authz     → a GUEST feed does not contain it
   *   authz     → a stranger searching its exact title finds nothing
   *   contract  → the OWNER does see it, or the test proves nothing
   */
  let owner: { token: string; userId: string };
  let stranger: { token: string; userId: string };
  let marker: string;

  beforeAll(async () => {
    owner = await login('feed_owner');
    stranger = await login('feed_stranger');
    const space = (await list('', owner.token)).find((t) => t.personal)!.id;
    marker = `zz-private-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    await fetch(`${BASE}/api/topics/${space}/posts`, {
      method: 'POST',
      headers: bearer(owner.token),
      body: JSON.stringify({ title: marker, content: 'nobody else should ever read this' }),
    });
  });

  async function feed(query: string, token?: string): Promise<string> {
    const r = await fetch(`${BASE}/api/feed${query}`, {
      headers: token ? bearer(token) : { 'Content-Type': 'application/json' },
    });
    return r.ok ? r.text() : '';
  }

  it('CONTRACT: the owner sees their own note — otherwise nothing below counts', async () => {
    expect(await feed('?sort=new&limit=100', owner.token)).toContain(marker);
  });

  it('AUTHZ: a stranger\'s feed does not carry it', async () => {
    expect(await feed('?sort=new&limit=100', stranger.token)).not.toContain(marker);
  });

  it('AUTHZ: a guest feed does not carry it', async () => {
    expect(await feed('?sort=new&limit=100')).not.toContain(marker);
  });

  it('AUTHZ: a stranger searching the exact title finds nothing', async () => {
    // Search runs its match in the database and filters visibility afterwards,
    // which is the shape that hides a missing filter until someone searches.
    expect(await feed(`?q=${encodeURIComponent(marker)}`, stranger.token)).not.toContain(marker);
  });
});
