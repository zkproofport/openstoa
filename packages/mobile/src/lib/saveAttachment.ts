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

/** The slice of React Native's `Share` this needs. */
export interface AttachmentShare {
  share(content: { url: string; title?: string }): Promise<unknown>;
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

export type SaveAttachmentResult =
  /** The share sheet was opened. Whether they saved is theirs to decide. */
  | { status: 'shared' }
  /** No filesystem module in this host build — nothing to hand the sheet. */
  | { status: 'unavailable' }
  /** Writing the temporary copy failed, so there was nothing to share. */
  | { status: 'write-failed' }
  /** The sheet itself refused. Dismissing it is NOT this. */
  | { status: 'share-failed' };

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
    await share.share({ url: file.uri });
    return { status: 'shared' };
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
