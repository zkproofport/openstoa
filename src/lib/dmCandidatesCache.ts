/**
 * Session-scoped cache for `GET /api/dm/candidates` (P-O chat rail).
 *
 * Two independent surfaces need this list: `UserCard`'s "Message" button (one
 * lookup per opened card — "does the viewer share a topic with this person?")
 * and the rail's new-conversation picker (the whole list, client-searched).
 * Without a shared cache, opening several profile cards on one page (e.g. a
 * member list) would re-issue the same full-candidates query per card. A
 * short TTL keeps it from ever answering with data more than a minute stale
 * (a newly-shared topic should make someone DM-able without a full reload).
 */

export interface DmCandidateBadge {
  type: string;
  label: string;
  domain?: string | null;
}

export interface DmCandidateSharedTopic {
  id: string;
  title: string;
}

export interface DmCandidate {
  userId: string;
  nickname: string;
  profileImage: string | null;
  badges: DmCandidateBadge[];
  sharedTopics: DmCandidateSharedTopic[];
}

const TTL_MS = 60_000;

let cached: { at: number; data: DmCandidate[] } | null = null;
let inflight: Promise<DmCandidatesResult> | null = null;

/** Either a real list, or an explicit failure the caller can render as such. */
export type DmCandidatesResult =
  | { ok: true; data: DmCandidate[] }
  | { ok: false; status: number | null };

/**
 * Fetch (or reuse) the caller's DM candidate list.
 *
 * A failure is returned as `{ ok: false }`, NOT as an empty list, and is NOT
 * cached. Collapsing the two used to make a 401/500/offline look exactly like
 * "you share no topics with anyone" — the picker rendered its explanatory
 * empty state either way, so a broken request was indistinguishable from a
 * genuinely empty one and survived 60s of TTL even after the cause was gone.
 * `isDmCandidate` still fails CLOSED (see below); only the picker needs the
 * distinction, and it needs it badly.
 */
export async function getDmCandidates(force = false): Promise<DmCandidatesResult> {
  if (!force && cached && Date.now() - cached.at < TTL_MS) return { ok: true, data: cached.data };
  if (!force && inflight) return inflight;

  inflight = fetch('/api/dm/candidates', { credentials: 'include' })
    .then(async (r): Promise<DmCandidatesResult> => {
      // `?? null` because a Response-like without a numeric status (a partial
      // mock, a polyfill) must still satisfy `number | null` rather than
      // leaking `undefined` into the result.
      if (!r.ok) return { ok: false, status: r.status ?? null };
      const d = (await r.json()) as { candidates?: DmCandidate[] };
      const data = Array.isArray(d.candidates) ? d.candidates : [];
      cached = { at: Date.now(), data };
      return { ok: true, data };
    })
    .catch((): DmCandidatesResult => ({ ok: false, status: null }))
    .finally(() => {
      inflight = null;
    });

  return inflight;
}

/** Drop the cached list so the next `getDmCandidates()` re-fetches. */
export function invalidateDmCandidates(): void {
  cached = null;
}

/**
 * Convenience check for `UserCard`: is `userId` someone the viewer may DM?
 *
 * Fails CLOSED — a failed lookup answers `false`, so a transient blip hides the
 * DM button rather than offering one that would 403. That collapse is correct
 * HERE (a hidden button is a fine degradation) and wrong in the picker, which
 * must say "couldn't load" instead of "nobody to message".
 */
export async function isDmCandidate(userId: string): Promise<boolean> {
  const res = await getDmCandidates();
  return res.ok && res.data.some((c) => c.userId === userId);
}
