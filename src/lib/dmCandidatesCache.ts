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
let inflight: Promise<DmCandidate[]> | null = null;

/**
 * Fetch (or reuse) the caller's DM candidate list. A rejected/non-OK response
 * degrades to an empty list rather than throwing — every caller of this
 * treats "no one to message" and "the lookup failed" the same way (nothing
 * renders / no DM button), so there is no correctness reason to distinguish
 * them here, and throwing would crash a profile-card popover over a
 * transient network blip.
 */
export async function getDmCandidates(force = false): Promise<DmCandidate[]> {
  if (!force && cached && Date.now() - cached.at < TTL_MS) return cached.data;
  if (!force && inflight) return inflight;

  inflight = fetch('/api/dm/candidates', { credentials: 'include' })
    .then((r) => (r.ok ? r.json() : { candidates: [] }))
    .then((d: { candidates?: DmCandidate[] }) => {
      const data = Array.isArray(d.candidates) ? d.candidates : [];
      cached = { at: Date.now(), data };
      return data;
    })
    .catch(() => {
      cached = { at: Date.now(), data: [] };
      return [] as DmCandidate[];
    })
    .finally(() => {
      inflight = null;
    });

  return inflight;
}

/** Drop the cached list so the next `getDmCandidates()` re-fetches. */
export function invalidateDmCandidates(): void {
  cached = null;
}

/** Convenience check for `UserCard`: is `userId` someone the viewer may DM? */
export async function isDmCandidate(userId: string): Promise<boolean> {
  const list = await getDmCandidates();
  return list.some((c) => c.userId === userId);
}
