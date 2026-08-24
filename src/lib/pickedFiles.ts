/**
 * Sending a whole SELECTION from the web composer, not just its first file.
 *
 * The mini-app already sends a multi-photo pick as several independent messages
 * (`packages/mobile/src/lib/pickedAttachments.ts`, which this deliberately
 * mirrors). The web could not select more than one at all: its file input had
 * no `multiple`, and the change handler read `files[0]`. Adding the attribute
 * alone would have been worse than the bug — the picker would offer three
 * photos, accept three, and silently send one.
 *
 * The guarantee, same as the mini-app's: three files picked means three
 * messages, in the order they were picked, with three INDEPENDENT outcomes. A
 * middle one failing must not cancel the two either side of it.
 *
 * Separate from the mini-app copy rather than shared, because the two take
 * different things — a browser `File` here, a picker asset with base64 there —
 * and neither package can import the other. What has to agree is the RULE, and
 * both files state it.
 */

/** What the composer does with one file. Reports its own failures; may throw. */
export type SendOneFile = (file: File) => Promise<void>;

export interface SendPickedFilesResult {
  /** How many were handed to `send` and came back without throwing. */
  sent: number;
  /** Entries the browser gave us that were not files (a cleared input, a null). */
  unreadable: number;
  /** Files whose send threw. They are reported by `send` itself, not here. */
  failed: number;
}

/**
 * Send each file in the order it was picked, one at a time.
 *
 * SEQUENTIAL on purpose, for the same reasons as the mini-app: each send reads
 * multi-megabyte bytes into the tab, converts HEIC where needed, seals and
 * uploads them, and running them together would hold every buffer at once and
 * land the messages in whatever order the uploads happened to finish. It also
 * matters here specifically because `sendImage` drives a single `uploading`
 * flag — overlapping calls would race each other's spinner.
 *
 * A throwing send is counted and stepped over. `sendImage` already reports its
 * own failures (an inline error, or a retryable row in the conversation), so
 * there is nothing to add here except the promise that the rest still goes.
 */
export async function sendPickedFiles(
  files: readonly (File | null | undefined)[],
  send: SendOneFile,
): Promise<SendPickedFilesResult> {
  const result: SendPickedFilesResult = { sent: 0, unreadable: 0, failed: 0 };

  for (const file of files) {
    if (!file) {
      // Per file, not per selection: one bad entry is not a reason to drop the
      // others.
      result.unreadable += 1;
      continue;
    }
    try {
      await send(file);
      result.sent += 1;
    } catch {
      result.failed += 1;
    }
  }

  return result;
}
