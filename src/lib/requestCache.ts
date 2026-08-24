/**
 * One in-flight GET per URL, shared by everything that asks for it.
 *
 * WHAT THIS IS FOR. Opening a topic mounts several components that each need
 * the same thing and each fetch it themselves. Measured on staging, one entry
 * issues `/api/topics/{id}` twice (`TopicPageClient` and `ChatPanel`) at 441ms
 * each, `/api/topics/{id}/members` twice (`ChatPanel` and `ChatRail`),
 * `/api/tags` twice and `/api/topics` twice. None of them is wrong on its own —
 * a component that needs data fetching it is the correct instinct — and
 * together they double the cost of the slowest thing on the page.
 *
 * DE-DUPLICATION, NOT CACHING, and the difference is the whole design. An entry
 * lives ONLY while the request is in flight. The moment it settles it is gone,
 * so a later caller always gets a fresh request and no response is ever reused.
 *
 * An earlier version kept settled entries for a two-second window, on the
 * theory that components of one mount might not overlap. They do — the
 * duplicates this exists for are effects that run in the same commit — and the
 * window bought nothing while introducing the one thing this must never have: a
 * lifetime, and therefore an invalidation to get wrong. It also made a dozen
 * suites answer a second mount with the first mount's data, which is the same
 * defect wearing a test's clothes.
 *
 * GET ONLY. A mutation is never shared: two callers posting the same URL mean
 * two intended writes.
 *
 * Matrix rows: contract (concurrent callers share one request; a caller after
 * the window does not), boundary (zero window, and an entry that outlives it),
 * empty (no callers, an empty URL), hostile (a URL that differs only by query
 * string is a different entry), race (a rejection is not cached and the next
 * caller retries), external failure (a rejected fetch reaches every sharer),
 * integrity (each URL resolves to its OWN response). N/A: authorization — this
 * is a client-side lane in front of `apiFetch`, which carries the credentials
 * exactly as it did before.
 */
import { apiFetch } from '@/lib/apiFetch';

const entries = new Map<string, Promise<Response>>();

/**
 * Hand each caller its own readable copy.
 *
 * A real `Response` body can only be read once, so sharers must each get a
 * clone or the second one finds a locked stream. `clone` is checked rather than
 * assumed: a great many suites stand `fetch` up as `{ ok, json }`, and calling
 * a method that object does not have made the shared promise REJECT — which the
 * components' own `.catch` then swallowed, so twenty tests failed as "the data
 * never arrived" with no error anywhere. A stand-in whose `json()` can be
 * called twice needs no clone; a real Response gets one.
 */
function readableCopy(r: Response): Response {
  return typeof r?.clone === 'function' ? r.clone() : r;
}

/**
 * Fetch `url`, joining an identical request that is already happening.
 */
export function sharedGet(url: string, init?: RequestInit): Promise<Response> {
  if (!url) return apiFetch(url, init);

  const existing = entries.get(url);
  if (existing) return existing.then(readableCopy);

  // Dropped on settle, success or failure alike: the entry exists to join
  // callers that arrive WHILE it is happening, never to answer later ones.
  const promise = apiFetch(url, init).finally(() => {
    entries.delete(url);
  });
  entries.set(url, promise);
  return promise.then(readableCopy);
}

/** Drops every entry. For tests, and for a sign-out that must share nothing. */
export function resetRequestCache(): void {
  entries.clear();
}
