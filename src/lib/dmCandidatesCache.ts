import { apiFetch } from '@/lib/apiFetch';
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

// A SEPARATE small cache of existing-DM peer ids — see `isDmCandidate`'s doc
// below for why this must not be folded into `cached` above.
let cachedDmPeerIds: { at: number; ids: Set<string> } | null = null;
let dmPeerIdsInflight: Promise<Set<string>> | null = null;

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

  inflight = apiFetch('/api/dm/candidates', { credentials: 'include' })
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

/**
 * Existing DM peer ids — a SEPARATE small cache from `cached` above, fetched
 * from `GET /api/dm`. Backs `isDmCandidate`'s "already messaging them" branch
 * (see its doc). This list is inherently small (bounded by how many DM
 * channels the viewer has, not by topic-membership fan-out), so a plain
 * client-side `Set` lookup here is not the "pull the cross-product into JS"
 * pattern `buildDmCandidatesQuery`'s doc warns against — that pattern is
 * about NOT cross-referencing two large, unbounded lists; this is a small,
 * already-indexed (`topics.dm_pair` is unique) lookup on its own.
 */
async function getExistingDmPeerIds(force = false): Promise<Set<string>> {
  if (!force && cachedDmPeerIds && Date.now() - cachedDmPeerIds.at < TTL_MS) return cachedDmPeerIds.ids;
  if (!force && dmPeerIdsInflight) return dmPeerIdsInflight;

  dmPeerIdsInflight = apiFetch('/api/dm', { credentials: 'include' })
    .then(async (r): Promise<Set<string>> => {
      if (!r.ok) return new Set();
      const d = (await r.json()) as { dms?: Array<{ peer?: { userId?: string } }> };
      const ids = new Set(
        Array.isArray(d.dms)
          ? d.dms.map((c) => c.peer?.userId).filter((id): id is string => typeof id === 'string')
          : [],
      );
      cachedDmPeerIds = { at: Date.now(), ids };
      return ids;
    })
    .catch(() => new Set<string>())
    .finally(() => {
      dmPeerIdsInflight = null;
    });

  return dmPeerIdsInflight;
}

/** Drop both caches so the next `getDmCandidates()` / `isDmCandidate()` call
 *  re-fetches. Callers MUST invoke this right after a successful
 *  `POST /api/dm` — otherwise the person just messaged keeps appearing in the
 *  new-conversation picker (stale `cached`) for up to a minute, since the
 *  server-side exclusion only takes effect on the NEXT fetch. */
export function invalidateDmCandidates(): void {
  cached = null;
  cachedDmPeerIds = null;
}

/**
 * Convenience check for `UserCard` / member-row DM buttons: is `userId`
 * someone the viewer may open a conversation with RIGHT NOW?
 *
 * Two independent, OR'd conditions — NOT just "is in the candidate list":
 *   1. They are an existing DM partner (`GET /api/dm`). `POST /api/dm` never
 *      re-checks shared-topic membership once a channel exists (it is
 *      idempotent purely on the canonical `dm_pair`), so someone you already
 *      message must stay DM-able even if you no longer share a topic with
 *      them (e.g. you both left it). This is also why this can't be answered
 *      from `getDmCandidates()` alone: that list now EXCLUDES existing DM
 *      partners (see `buildDmCandidatesQuery`'s doc) — it answers "who is a
 *      NEW-conversation candidate", not "who may I message at all".
 *   2. They are a genuine new-conversation candidate (shares a topic, no
 *      existing DM) — the pre-existing check.
 *
 * Fails CLOSED on both branches — a failed lookup contributes `false`/empty,
 * so a transient blip can only ever HIDE the DM button, never offer one that
 * would 403. That collapse is correct HERE (a hidden button is a fine
 * degradation) and wrong in the picker, which must say "couldn't load"
 * instead of "nobody to message".
 */
export async function isDmCandidate(userId: string): Promise<boolean> {
  const [candidatesRes, existingDmPeerIds] = await Promise.all([getDmCandidates(), getExistingDmPeerIds()]);
  if (existingDmPeerIds.has(userId)) return true;
  return candidatesRes.ok && candidatesRes.data.some((c) => c.userId === userId);
}
