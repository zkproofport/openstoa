/**
 * Sending a whole PICK, not just its first asset.
 *
 * The picker used to be read as `result.assets[0]` and everything after was
 * dropped on the floor — one photo per trip to the library, with no recorded
 * reason for the limit. Widening that is not a loop at the call site: what a
 * person expects from picking three photos is three messages, in the order
 * they picked them, and — the part that is easy to get wrong — three
 * INDEPENDENT outcomes. A middle one failing must not cancel the two either
 * side of it.
 *
 * Lives here rather than in the screen so that guarantee is testable. The
 * picker itself is a native module that is not installed in this package (see
 * `src/types/expo-image-picker.d.ts`), so a test that drove the real flow
 * could not run at all; this takes the assets it would have produced.
 */

/** The slice of the picker's asset this needs. Every field is optional there. */
export interface PickedAsset {
  base64?: string | null;
  mimeType?: string | null;
  fileName?: string | null;
}

/** What the screen does with one asset. Reports its own failures; may throw. */
export type SendOneAttachment = (input: {
  base64: string;
  mime: string;
  filename?: string;
}) => Promise<void>;

export interface SendPickedResult {
  /** How many were handed to `send` and came back without throwing. */
  sent: number;
  /** Assets with no bytes to send — the picker returned no base64 for them. */
  unreadable: number;
  /** Assets whose send threw. They are reported by `send` itself, not here. */
  failed: number;
}

/**
 * Send each asset in the order it was picked, one at a time.
 *
 * SEQUENTIAL on purpose. Each send seals multi-megabyte bytes in JS and then
 * uploads them; running them together would contend for the one thread and
 * hold every buffer at once, and the messages would land in whatever order the
 * uploads happened to finish — not the order somebody chose them in.
 *
 * A throwing send is counted and stepped over. `uploadAndSend` already reports
 * its own failures (an alert before the bytes are stored, a retryable row in
 * the conversation after), so there is nothing to add here except the promise
 * that the rest of the selection still goes.
 */
export async function sendPickedAssets(
  assets: readonly PickedAsset[],
  send: SendOneAttachment,
  onUnreadable?: (asset: PickedAsset, index: number) => void,
): Promise<SendPickedResult> {
  const result: SendPickedResult = { sent: 0, unreadable: 0, failed: 0 };

  for (let i = 0; i < assets.length; i++) {
    const asset = assets[i];
    if (!asset || !asset.base64) {
      // Per asset, not per selection: one unreadable file is not a reason to
      // drop the others.
      result.unreadable += 1;
      onUnreadable?.(asset, i);
      continue;
    }
    try {
      await send({
        base64: asset.base64,
        mime: asset.mimeType ?? '',
        filename: asset.fileName ?? undefined,
      });
      result.sent += 1;
    } catch {
      result.failed += 1;
    }
  }

  return result;
}
