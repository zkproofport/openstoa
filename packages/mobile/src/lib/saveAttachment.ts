/**
 * Keeping a chat picture — the mobile half.
 *
 * There was no way to save an attachment at all, on either client. That is a
 * gap in any messenger, but it bites harder here: an attachment is only
 * readable on a device holding the topic's key, so until this existed the
 * picture had nowhere else it could go.
 *
 * The web can hand a blob to `<a download>`. A phone cannot, and it also has
 * no business writing straight into the photo library without being asked —
 * so this goes through the SHARE SHEET, which is where "Save Image", "Save to
 * Files" and "send it to another app" all already live, and which asks the
 * person which of those they meant.
 *
 * Every native piece is INJECTED rather than imported. The mini-app does not
 * install these modules — it borrows the host's, guarded by `require` — so a
 * direct import here would make the module unloadable in a test, and would
 * hide the case that matters most on a real device: a host binary that
 * predates one of them.
 */
import { chatMediaFilename } from './chatMedia';

/**
 * One file, shaped after `expo-file-system`'s `File`.
 *
 * `write` and `delete` are SYNCHRONOUS there — the current API does its work
 * over JSI rather than a promise — so this interface is synchronous too. The
 * alternative was to wrap expo in an async shape borrowed from
 * `react-native-fs`, which is an abandoned module we deliberately did not
 * build on; bending the good API to match the dead one would have been the
 * wrong way round.
 */
export interface AttachmentFile {
  readonly uri: string;
  /**
   * BYTES, not base64.
   *
   * The plaintext used to be handed here as a base64 string, because it was
   * already one — the picture was displayed from a `data:` URI, so the string
   * existed anyway. It no longer does: the decrypted bytes go to a cache file
   * and `<Image>` reads a `file://` URI, which removed a 694ms re-encode from
   * the 6MB read path. Writing bytes is what the underlying API wanted all
   * along; the base64 was ours.
   */
  write(content: Uint8Array, options?: { encoding?: string }): void;
  /** Read the file back. Used to hand a displayed picture to the share sheet. */
  bytes(): Promise<Uint8Array>;
  delete(): void;
  /**
   * Is there already a file here?
   *
   * This is what lets a picture be decrypted ONCE. The display cache is named
   * from the media id, so re-entering a room can find last time's plaintext
   * instead of paying the download and the AES again — 3,086ms of a 6MB
   * attachment, per view, per entry.
   *
   * OPTIONAL, and every caller treats a missing implementation as "not there".
   * The mini-app borrows this filesystem from the host binary, so a phone
   * running an older host has an object without it; a required member would
   * turn that into a crash on the one path the cache exists to make faster.
   */
  exists?: boolean;
}

/** Somewhere temporary to put a copy that exists only to be handed on. */
export interface AttachmentFs {
  cacheFile(name: string): AttachmentFile;
  /**
   * Download `url` to a cache file called `name`, natively.
   *
   * Not `fetch`. React Native cannot dependably receive binary over `fetch` —
   * only strings cross the bridge (facebook/react-native#6743) — so a
   * multi-megabyte ciphertext would have to be built as a base64 string and
   * decoded again on the JS thread. This lets the native layer stream it to
   * disk and hands back a file to read bytes from.
   *
   * Rejects on any non-2xx, so an expired session or a lost membership is a
   * thrown error rather than a file full of an error page.
   */
  download(url: string, name: string, headers: Record<string, string>): Promise<AttachmentFile>;
}

/**
 * The slice of React Native's `Share` this needs.
 *
 * The RESULT is now read, where it used to be discarded. React Native resolves
 * `{ action: 'sharedAction' | 'dismissedAction', activityType?: string | null }`
 * — a dismissed sheet RESOLVES rather than rejecting, and on iOS
 * `RCTActionSheetManager`'s `completionWithItemsHandler` passes the chosen
 * activity's identifier straight through. That is the only way this code can
 * tell "they saved it" from "they closed the sheet", and telling them apart is
 * what the save confirmation is built on.
 */
export interface AttachmentShare {
  share(content: { url: string; title?: string }): Promise<
    { action?: string; activityType?: string | null } | null | undefined
  >;
}

export interface SaveAttachmentDeps {
  /** Null on a host build with no filesystem module — save is simply absent. */
  fs: AttachmentFs | null;
  share: AttachmentShare;
  /** Plaintext bytes — the same ones the picture on screen was written from. */
  bytes: Uint8Array;
  mime: string;
  mediaId: string;
}

/**
 * What the person actually did with the sheet.
 *
 * Carried alongside `status: 'shared'` rather than replacing it, so a caller
 * that only ever asked "did the sheet open" keeps working untouched.
 *
 *  - `saved-to-photos` — they chose the photo-library activity. The ONLY
 *    outcome a "Saved" confirmation may be shown for, because it is the only
 *    one where saving is what happened.
 *  - `handed-off`      — some other activity completed (AirDrop, Mail, Files,
 *    Copy). Those destinations report themselves; claiming a save here would
 *    be a lie. Also the Android result for everything, because React Native
 *    resolves `sharedAction` unconditionally there.
 *  - `dismissed`       — the sheet was closed without choosing. Nothing
 *    happened, and nothing should be announced.
 *  - `unknown`         — a Share implementation that told us nothing. Treated
 *    as "say nothing" rather than assumed successful.
 */
export type SaveAttachmentOutcome =
  | 'saved-to-photos'
  | 'handed-off'
  | 'dismissed'
  | 'unknown';

export type SaveAttachmentResult =
  /** The share sheet was opened. `outcome` says what came of it. */
  | { status: 'shared'; outcome: SaveAttachmentOutcome; activityType?: string | null }
  /** No filesystem module in this host build — nothing to hand the sheet. */
  | { status: 'unavailable' }
  /** Writing the temporary copy failed, so there was nothing to share. */
  | { status: 'write-failed' }
  /** The sheet itself refused. Dismissing it is NOT this. */
  | { status: 'share-failed' };

/**
 * Whether an iOS activity identifier is the photo-library one.
 *
 * Matched as a case-insensitive SUBSTRING rather than against a hardcoded
 * constant. `UIActivity.ActivityType.saveToCameraRoll` is public API and its
 * documented name is what this looks for; its RAW string value is not printed
 * in Apple's documentation, and hardcoding a value nobody verified would fail
 * closed in the one direction that matters (no confirmation for a real save)
 * while looking authoritative. A non-match degrades to `handed-off`, i.e. to
 * silence — this can never announce a save that did not happen.
 */
export function isSaveToPhotosActivity(activityType: unknown): boolean {
  return (
    typeof activityType === 'string' &&
    activityType.toLowerCase().includes('savetocameraroll')
  );
}

/** Classify what React Native handed back from the sheet. */
function outcomeOf(result: {
  action?: string;
  activityType?: string | null;
} | null | undefined): SaveAttachmentOutcome {
  if (!result || typeof result !== 'object') return 'unknown';
  if (result.action === 'dismissedAction') return 'dismissed';
  if (result.action !== 'sharedAction') return 'unknown';
  return isSaveToPhotosActivity(result.activityType) ? 'saved-to-photos' : 'handed-off';
}

/**
 * Write the decrypted bytes to a temporary file and offer them to the share
 * sheet.
 *
 * Its OWN copy, under `chatMediaFilename` — deliberately not the file the
 * picture is being displayed from, which lives under `chatMediaCacheFilename`.
 * Two reasons: the name a person sees in the share sheet should be the tidy
 * one, and this function DELETES what it wrote when the sheet closes. Sharing
 * the display file would mean saving a picture removed the picture on screen.
 *
 * A file, because the sheet needs a URL and a `data:` URI of several megabytes
 * is not one any share extension will reliably accept. In the cache directory,
 * because this copy exists only to be handed over — the OS may reclaim it, and
 * we remove it ourselves once the sheet is done.
 *
 * DELETED AFTER the sheet resolves, never before: iOS reads the file while the
 * sheet is open, so removing it any earlier hands every extension a path to
 * nothing — and that failure reads as "saving is broken on iOS" rather than as
 * the lifecycle mistake it is. A failed delete is ignored; a stale file in a
 * cache directory is the operating system's problem.
 *
 * The RESULT of the sheet is now read and reported, because it used to be
 * thrown away: saving worked and the app said nothing, so the only way to find
 * out whether a picture had been kept was to go and look in Photos. See
 * `SaveAttachmentOutcome`.
 */
export async function saveAttachment(deps: SaveAttachmentDeps): Promise<SaveAttachmentResult> {
  const { fs, share, bytes, mime, mediaId } = deps;
  if (!fs) return { status: 'unavailable' };

  let file: AttachmentFile;
  try {
    file = fs.cacheFile(chatMediaFilename(mime, mediaId));
    file.write(bytes);
  } catch {
    return { status: 'write-failed' };
  }

  try {
    const result = await share.share({ url: file.uri });
    return {
      status: 'shared',
      outcome: outcomeOf(result),
      activityType: result?.activityType ?? null,
    };
  } catch {
    /*
     * A DISMISSED sheet does not land here — React Native resolves that rather
     * than rejecting — so anything caught is the sheet failing to open at all,
     * which is worth reporting.
     */
    return { status: 'share-failed' };
  } finally {
    try {
      file.delete();
    } catch {
      // Cache directory; the OS reclaims it.
    }
  }
}
