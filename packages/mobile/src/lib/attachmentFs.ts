/**
 * The host's filesystem, borrowed — the one place that names a native module.
 *
 * `saveAttachment` and `chatMediaFiles` take their filesystem as a parameter so
 * they can be tested without one. This is the other half: the single spot that
 * decides WHICH module that is, guarded so a host binary without it degrades to
 * "attachments are unavailable" rather than to a crash at import.
 *
 * `expo-file-system`, not `react-native-fs`. The latter is installed here and
 * is the obvious reach, but it has been unmaintained since May 2022; the
 * former is maintained by Expo, is already a dependency of the `expo` package
 * this app depends on, and is already linked into the iOS binary — so choosing
 * it costs no native rebuild and inherits no dead code.
 */
import type { AttachmentFile, AttachmentFs } from './saveAttachment';

type FileSystemModule = typeof import('expo-file-system');

function loadFileSystem(): FileSystemModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('expo-file-system') as FileSystemModule;
  } catch {
    // Older host binary, or a JS-only Metro run. The caller reports this as
    // "saving is unavailable" and everything else keeps working.
    return null;
  }
}

/**
 * A filesystem for `saveAttachment`, or null when this build has none.
 *
 * Resolved on every call rather than once at module load: this file is
 * imported by a screen, and a module that threw during import would take the
 * screen with it — which is exactly the failure the `require` guard exists to
 * prevent, and which caching the result at import time would reintroduce.
 */
export function hostAttachmentFs(): AttachmentFs | null {
  const FileSystem = loadFileSystem();
  if (!FileSystem) return null;

  return {
    cacheFile(name: string): AttachmentFile {
      // The cache directory on purpose: every copy this module makes exists to
      // be handed on or displayed and then dropped, and the OS is welcome to
      // reclaim any of them if we somehow do not.
      return new FileSystem.File(FileSystem.Paths.cache, name);
    },

    async download(url: string, name: string, headers: Record<string, string>): Promise<AttachmentFile> {
      /*
       * The response body goes to disk in the native layer and never enters JS.
       *
       * That is the point. `fetch(...).arrayBuffer()` is not dependable in
       * React Native (facebook/react-native#6743) because only strings cross
       * the bridge, so the shape it forces — build a base64 string of the whole
       * ciphertext, then decode it — cost 179ms of a 6MB read before any
       * decryption started, and held two multi-megabyte buffers while it did.
       *
       * `idempotent` because the destination is derived from the media id: a
       * reload of the same picture, or a retry after a failed decrypt, must
       * overwrite rather than reject with `DestinationAlreadyExists`.
       */
      return FileSystem.File.downloadFileAsync(url, new FileSystem.File(FileSystem.Paths.cache, name), {
        headers,
        idempotent: true,
      });
    },
  };
}
