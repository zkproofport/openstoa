/**
 * Client-side chat history synchronisation primitives shared by the web
 * ChatPanel: chronological merging, the `?since=` reconnect catch-up loop, and
 * the one-shot decrypt guard.
 *
 * WHY THIS EXISTS AS A SEPARATE MODULE
 * MLS consumes the per-message key on the FIRST successful decrypt (forward
 * secrecy). A message that gets decrypted twice concurrently therefore yields
 * one plaintext and one permanent `[unable to decrypt]`. Once the web client
 * grew a second and third path that can deliver the same message — the SSE
 * stream, the `?since=` catch-up after a reconnect, and the `?before=` history
 * page — "decrypt exactly once per message id" stopped being an incidental
 * property of the code and became an invariant that needs its own guard
 * (`DecryptOnce`) and its own tests.
 *
 * Everything here is pure / transport-injected so it is unit-testable in node
 * without a DOM, an EventSource, or an MLS group.
 */

/** The minimum shape the sync layer needs. Callers carry the full message. */
export interface SyncedMessage {
  id: string;
  createdAt: string;
}

/** Page size for history reads (initial load and `?before=` pages). */
export const HISTORY_PAGE_LIMIT = 50;

/** Per-request cap for catch-up reads. 500 is the server's hard maximum. */
export const CATCHUP_PAGE_LIMIT = 500;

/**
 * Upper bound on catch-up pages per reconnect (500 * 20 = 10k messages). A
 * client that has been disconnected long enough to miss more than that is
 * better served by a reload than by an unbounded fetch loop, and the cap
 * guarantees the loop terminates even if a server bug keeps returning full
 * pages.
 */
export const CATCHUP_MAX_PAGES = 20;

/**
 * How far back the `?since=` cursor is rewound before asking the server.
 *
 * `since` is EXCLUSIVE (`createdAt > since`) and the wire format truncates the
 * database's microsecond timestamps to milliseconds, so a cursor taken verbatim
 * from the newest message we hold can silently skip a message written in the
 * same millisecond. Rewinding re-delivers a few messages we already have, which
 * is free: the merge dedupes by id and `DecryptOnce` makes the redundant rows
 * cost zero decrypts.
 */
export const SINCE_OVERLAP_MS = 1000;

/** Parse a wire timestamp for ordering. Unparsable values sort as oldest. */
function timeOf(m: SyncedMessage): number {
  const t = new Date(m.createdAt).getTime();
  return Number.isFinite(t) ? t : 0;
}

/**
 * Merge `incoming` into `prev`, deduplicated by id and sorted oldest → newest.
 *
 * EXISTING ROWS WIN. A row already on screen may have been enriched after it
 * was first ingested (the optimistic echo of a message this client sent, which
 * an MLS sender can never decrypt back; or a `[unable to decrypt]` row repaired
 * by the TAK back-fill). Letting a later duplicate overwrite it would undo that
 * repair — a duplicate carries strictly less information, never more.
 *
 * Returns `prev` UNCHANGED (same reference) when nothing new arrived, so React
 * skips the re-render and the auto-scroll effect does not fire.
 */
export function mergeChronological<T extends SyncedMessage>(prev: T[], incoming: T[]): T[] {
  if (incoming.length === 0) return prev;
  const byId = new Set(prev.map((m) => m.id));
  const added: T[] = [];
  for (const m of incoming) {
    if (!m?.id || byId.has(m.id)) continue;
    byId.add(m.id);
    added.push(m);
  }
  if (added.length === 0) return prev;
  const merged = [...prev, ...added];
  // Ties broken by id so the order is deterministic across renders — two
  // messages written in the same millisecond must not swap places on re-sort.
  merged.sort((a, b) => timeOf(a) - timeOf(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return merged;
}

/** The newest valid `createdAt` in the list, or null when there is none. */
export function newestCreatedAt(messages: SyncedMessage[]): string | null {
  let best: string | null = null;
  let bestT = -Infinity;
  for (const m of messages) {
    const t = new Date(m?.createdAt).getTime();
    if (!Number.isFinite(t) || t <= bestT) continue;
    bestT = t;
    best = m.createdAt;
  }
  return best;
}

/**
 * Rewind an ISO timestamp by `overlapMs` for use as a `?since=` cursor.
 * Returns the input unchanged when it is not a parsable timestamp — a bad
 * cursor is better sent verbatim (the server 400s) than silently turned into
 * epoch-zero, which would re-download the entire topic history.
 */
export function sinceCursor(iso: string, overlapMs: number = SINCE_OVERLAP_MS): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return iso;
  return new Date(t - overlapMs).toISOString();
}

/**
 * Fetch everything newer than `sinceIso`, following pages until the server
 * returns a short page.
 *
 * `?since=` returns the OLDEST matching rows first and is capped at `limit`, so
 * a single request cannot express "everything I missed" when a client was away
 * for a long time. Each page advances the cursor to its own newest row.
 *
 * Rejections propagate — the caller decides whether a failed catch-up is fatal
 * (it is not: the next reconnect retries).
 */
export async function fetchCatchup<T extends SyncedMessage>(opts: {
  sinceIso: string;
  /** Issues one request. Must resolve to the page's messages (possibly empty). */
  fetchPage: (sinceIso: string, limit: number) => Promise<T[]>;
  limit?: number;
  maxPages?: number;
}): Promise<T[]> {
  const limit = opts.limit ?? CATCHUP_PAGE_LIMIT;
  const maxPages = opts.maxPages ?? CATCHUP_MAX_PAGES;
  const out: T[] = [];
  const seen = new Set<string>();
  let cursor = opts.sinceIso;

  for (let page = 0; page < maxPages; page++) {
    const rows = await opts.fetchPage(cursor, limit);
    if (!rows || rows.length === 0) break;
    for (const r of rows) {
      // The overlap window (and any server-side tie at the cursor) can repeat
      // rows across pages; keep the first copy only.
      if (!r?.id || seen.has(r.id)) continue;
      seen.add(r.id);
      out.push(r);
    }
    if (rows.length < limit) break;
    const next = newestCreatedAt(rows);
    // No usable cursor advance → stop rather than re-request the same page.
    if (!next || next === cursor) break;
    cursor = next;
  }
  return out;
}

/**
 * Memoises "the display form of message id X" so a message is only ever
 * decrypted once, no matter how many transports deliver it.
 *
 * The map holds the PROMISE, not the result: two callers that race (the SSE
 * event and the catch-up response arriving in the same tick) both await the
 * same in-flight decrypt instead of both calling into MLS — which is precisely
 * the race that produces a permanent `[unable to decrypt]`.
 *
 * Bounded: eviction is safe because a re-request of an evicted id goes through
 * `MlsSessionStore.openCached`, whose plaintext cache was written by the first
 * (now completed) decrypt. Only the CONCURRENT case is unrecoverable, and a
 * concurrent re-request of an evicted id cannot happen — eviction only reaches
 * entries that resolved long ago.
 */
export class DecryptOnce<T> {
  private entries = new Map<string, Promise<T>>();

  constructor(private cap = 2000) {}

  /** Resolve id via `factory`, or return the existing (possibly pending) work. */
  get(id: string, factory: () => Promise<T>): Promise<T> {
    const existing = this.entries.get(id);
    if (existing) return existing;
    const p = factory();
    this.entries.set(id, p);
    this.evict();
    return p;
  }

  /**
   * Pre-seed a known plaintext. Used for messages THIS client sent: an MLS
   * sender cannot decrypt its own message, so the SSE echo must never reach
   * the decrypt path at all.
   */
  set(id: string, value: T): void {
    this.entries.set(id, Promise.resolve(value));
    this.evict();
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  get size(): number {
    return this.entries.size;
  }

  private evict(): void {
    while (this.entries.size > this.cap) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}

/**
 * Is this row the reader's own message?
 *
 * A message the reader is SENDING is theirs by construction, and saying so
 * explicitly is the point: the optimistic row used to carry `myUserId` and be
 * compared back against it, so before `/api/auth/session` resolved it carried
 * `''`, failed the comparison, and rendered on the other side — then jumped
 * across the moment the server echo arrived. Ownership of a message this client
 * just composed must not depend on a network round trip.
 */
export function isOwnMessage(
  message: {userId?: string; pending?: boolean; failed?: boolean},
  myUserId: string | null,
): boolean {
  if (message.pending || message.failed) return true;
  return myUserId != null && message.userId === myUserId;
}
