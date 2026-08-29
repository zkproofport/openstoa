/**
 * Filing a note in the person's own room, at most once.
 *
 * TWO CALLERS, ONE MECHANISM. The recovery key gets filed here
 * (`sendRecoveryNote.ts`) and so does the warning that there is no backup at all
 * (`sendBackupNotice.ts`). They differ only in what the body says and in how
 * "is one already there?" is answered; everything else — finding the personal
 * room, sealing, posting, and the order those happen in — is the same, and a
 * second copy of it would be a second place for the SI-1 mistake below to come
 * back.
 *
 * WHAT SI-1 IS. `systemText` is a plaintext column the server reads
 * (`src/lib/chat.ts`). Anything filed through it is filed in the clear in the
 * database, in a room whose entire premise is that the server cannot read it.
 * Both notes go through the ordinary sealed path instead, which is also why
 * neither can be sent from the backend.
 *
 * WHY DUPLICATE DETECTION IS THE CALLER'S PREDICATE. The only thing that can
 * tell whether a note is already in the room is THIS DEVICE, reading text it
 * has already decrypted. There is no server-side equivalent — the server cannot
 * see message bodies — and there must not be one, because a marker the server
 * could match on is a marker it could index. So the check is injected, and a
 * caller that cannot perform it says so by throwing, which is treated as "do not
 * write": a room whose history this device cannot open is exactly the room where
 * a second unreadable copy helps nobody.
 */

/** The slice of the chat client this needs. */
export interface PersonalRoomClient {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
}

/** The slice of the MLS session store this needs. */
export interface PersonalRoomSealer {
  seal(topicId: string, plaintext: string): Promise<{ ciphertext: string; epoch: number }>;
  /**
   * Keep the plaintext of a message this device just SENT.
   *
   * NOT OPTIONAL IN PRACTICE, and the reason is the whole point of these notes.
   * An MLS sender cannot decrypt its own application message — that is what
   * `cachePlaintext` exists for in `mlsSession` — so a note filed without it is
   * unreadable to the one device that wrote it. Measured on a phone on
   * 2026-08-27: the recovery-code note came back as "Waiting for the key…" with
   * the room explaining that only the recovery code could open it. The recovery
   * code was IN that message.
   *
   * Declared optional only so an older caller compiles; `fileNoteOnce` reports a
   * send it could not cache rather than pretending it worked.
   *
   * A CACHE IS NOT A BACKUP, and mistaking one for the other is how the same
   * symptom came back a second time. This keeps the note readable ON THIS
   * DEVICE. Erasing the device takes it, and the recovery code cannot bring it
   * back — see `archive` below, which is the half that survives.
   */
  cachePlaintext?(topicId: string, msgId: string, plaintext: string): Promise<void>;
}

/**
 * Re-seal the note under the room's ARCHIVE key and upload it.
 *
 * WHY THIS EXISTS, measured on a phone against production on 2026-08-29:
 * the recovery-code note had a live ciphertext and NO archive row. Erasing the
 * device destroyed the room's group state, the new leaf could not open the old
 * ciphertext, and the recovery code had nothing to restore — so the one message
 * a person needs after wiping a phone was the one message a wipe destroyed. The
 * room even said "Only your recovery code can bring this back" while the code
 * was already entered and working.
 *
 * Every ordinary send does this (`ChatRoomScreen` calls `archiveOnSend` on both
 * the text and the attachment path). This path simply never did.
 */
export type ArchiveNote = (
  topicId: string,
  messageId: string,
  plaintext: string,
) => Promise<void>;

interface TopicRow {
  id: string;
  personal?: boolean;
}

export type FileNoteResult =
  | { kind: 'sent'; topicId: string }
  /**
   * On the server, but this device could not keep the plaintext — so IT cannot
   * read the note it just wrote, even though everyone else can.
   *
   * Distinct from `sent` because the note's whole job is to be readable later by
   * the person who filed it.
   */
  | { kind: 'sent-uncached'; topicId: string }
  /** Already filed — a second copy would just be noise in the room. */
  | { kind: 'already' }
  /** No personal room on this account yet. */
  | { kind: 'no-room' }
  | { kind: 'failed'; reason: string };

/**
 * Post `body` to the personal room, unless `alreadyFiled` says one is there.
 *
 * The lookup comes first so an account with no personal room costs one GET and
 * no decryption, and so `no-room` stays distinguishable from `failed` — the two
 * mean completely different things to a caller deciding whether to retry.
 */
export async function fileNoteOnce(
  client: PersonalRoomClient,
  sealer: PersonalRoomSealer,
  body: string,
  opts: {
    alreadyFiled?: (topicId: string) => Promise<boolean>;
    /** See `ArchiveNote`. Without it the note cannot survive an erase. */
    archive?: ArchiveNote;
  } = {},
): Promise<FileNoteResult> {
  let topicId: string;
  try {
    const res = await client.get<{ topics: TopicRow[] } | TopicRow[]>('/api/topics');
    const topics = Array.isArray(res) ? res : res.topics;
    const personal = topics.find((t) => t.personal);
    if (!personal) return { kind: 'no-room' };
    topicId = personal.id;
  } catch (e) {
    return { kind: 'failed', reason: e instanceof Error ? e.message : String(e) };
  }

  if (opts.alreadyFiled) {
    try {
      if (await opts.alreadyFiled(topicId)) return { kind: 'already' };
    } catch (e) {
      /*
       * Cannot tell. Not writing is the safer direction: a room whose history
       * this device cannot open is one where a second copy is unreadable too.
       */
      return { kind: 'failed', reason: e instanceof Error ? e.message : String(e) };
    }
  }

  try {
    const sealed = await sealer.seal(topicId, body);
    const posted = await client.post<{ message?: { id?: string } }>(
      `/api/topics/${topicId}/chat`,
      {
        ciphertext: sealed.ciphertext,
        epoch: sealed.epoch,
        /*
         * From the SYSTEM, not from the person whose token carries it.
         *
         * Without this the row is an ordinary message and the client draws it on
         * the right — the recovery-code note read as something the person had
         * written to themselves, which they had not. The server accepts `notice`
         * only in the caller's own space, so it cannot be used to fake a system
         * message at anyone.
         */
        type: 'notice',
      },
    );

    /*
     * KEEP THE PLAINTEXT, or this device can never read what it just wrote.
     *
     * MLS gives a sender no way to open its own application message, so the
     * server-assigned id is the only handle that ties the ciphertext to the text
     * — and this is the one moment the text is still in hand. `ChatRoomScreen`
     * does exactly this on every ordinary send (`mls.cachePlaintext(topicId,
     * res.message.id, text)`); the note path simply never did, and the recovery
     * note came back on a real phone as "Waiting for the key…".
     *
     * A send whose cache failed is reported as `sent-uncached`, not as `sent`:
     * the message really is on the server for other devices, and pretending the
     * local copy exists is how this went unnoticed the first time.
     */
    const msgId = posted?.message?.id;
    if (!msgId || !sealer.cachePlaintext) {
      return { kind: 'sent-uncached', topicId };
    }
    /*
     * ARCHIVE BEFORE CACHING, because the archive is the copy that outlives this
     * phone and the cache is not. Both are best-effort against a message that is
     * already on the server, so neither may turn a successful send into a
     * failure — but the order says which one matters when only one gets to run.
     */
    if (opts.archive) {
      try {
        await opts.archive(topicId, msgId, body);
      } catch {
        /*
         * Not fatal and not silent: the room's own key-state tick reports an
         * unarchived note as a locked row, which is how this was found. Failing
         * the send here would leave a note on the server that the caller thinks
         * was never written, and it would write a second one next launch.
         */
      }
    }
    try {
      await sealer.cachePlaintext(topicId, msgId, body);
    } catch {
      return { kind: 'sent-uncached', topicId };
    }
    return { kind: 'sent', topicId };
  } catch (e) {
    return { kind: 'failed', reason: e instanceof Error ? e.message : String(e) };
  }
}

/** A chat row as the history endpoint returns it, reduced to what a scan needs. */
export interface ScannableRow {
  id?: string;
  type?: string;
  sealed?: { ciphertext: string; epoch: number } | null;
}

/** Decrypt one row into its body. Supplied by the caller — see below. */
export type OpenRow = (topicId: string, row: ScannableRow) => Promise<string>;

/**
 * How much history one scan reads.
 *
 * 500 is the server's own ceiling (`/api/topics/[topicId]/chat`, `limit` is
 * clamped there), so this is one request and the largest window a single
 * request can have.
 */
export const SCAN_LIMIT = 500;

export type RoomScan =
  /** Every message in the room was read. An absent marker really is absent. */
  | { kind: 'complete'; bodies: string[] }
  /**
   * The room holds more than one page. The newest 500 did not contain the
   * marker, but an older message might, so absence is NOT established.
   */
  | { kind: 'partial' };

/**
 * Read the room's history and decrypt it, reporting whether the read was
 * exhaustive.
 *
 * WHY EXHAUSTIVENESS IS TRACKED AND NOT ASSUMED. These notes are filed early in
 * an account's life, so they are among the OLDEST messages in the room — the
 * far end from where a page of "latest" starts. A scan that silently read only
 * the newest 500 would report "no note here" to a person who has one, and file
 * another. The server returns `total` alongside the page, so the difference
 * between "read everything" and "read the top of a taller stack" is free.
 *
 * DECRYPTION IS INJECTED because the real one consumes MLS message keys on
 * first use, and the caller (which owns the session store, and its plaintext
 * cache) is the only thing that can do it without burning them.
 */
export async function scanPersonalRoom(
  client: PersonalRoomClient,
  topicId: string,
  open: OpenRow,
): Promise<RoomScan> {
  const res = await client.get<{ messages: ScannableRow[]; total?: number }>(
    `/api/topics/${topicId}/chat?limit=${SCAN_LIMIT}`,
  );
  const messages = res.messages ?? [];
  const bodies = await Promise.all(messages.map((m) => open(topicId, m)));

  /*
   * `total` is what makes the answer honest, so a response without one is taken
   * at face value (the page is all there is) rather than treated as a failure —
   * the endpoint always sends it, and a caller left unable to decide would
   * simply never file the note.
   */
  const total = typeof res.total === 'number' ? res.total : messages.length;
  if (total > messages.length) return { kind: 'partial' };

  return { kind: 'complete', bodies };
}

/**
 * Turn "this row would not decrypt" into a refusal to write.
 *
 * WHY IT IS NEEDED AT ALL. The real decrypt path never throws — by design, since
 * one bad row must not blank a whole page of chat — so an entire room this
 * device can no longer read comes back as a full page of the UNREADABLE
 * placeholder, which contains no marker, which reads as "no note has ever been
 * filed here". The next launch reads the same thing and files another, and so
 * does the one after that: the exact pile-up the marker exists to prevent,
 * arriving through the one path where nobody would ever see it happening.
 *
 * A room whose own author cannot read it is also the room where filing anything
 * is pointless — the new note is sealed under the same keys and lands just as
 * unreadable.
 *
 * WHAT THIS COSTS, stated because it is a real cost and not a rounding error: a
 * personal room holding even ONE permanently unreadable row can never be written
 * to by this mechanism again. In a personal room that should not happen — its
 * owner is its only member and joined at creation, so there is no pre-join epoch
 * to be locked out of — but a row whose live copy the server reclaimed while
 * this device did not hold the plaintext would do it. Silence there is the side
 * chosen deliberately: the alternative is an unbounded pile of warnings nobody
 * can read.
 */
export function refuseUnreadable(open: OpenRow, unreadable: string): OpenRow {
  return async (topicId, row) => {
    const body = await open(topicId, row);
    if (body === unreadable) {
      throw new Error('personal room holds a message this device cannot read');
    }
    return body;
  };
}
