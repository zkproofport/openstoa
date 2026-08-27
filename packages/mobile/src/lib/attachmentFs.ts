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

    /**
     * What is in the cache directory right now, by name.
     *
     * `Directory.list()` is SYNCHRONOUS and throws when the directory does not
     * exist. Both are wrapped: the signature is async because the interface it
     * satisfies is borrowed by a mini-app that cannot assume a synchronous
     * filesystem, and a missing cache directory is a legitimate state — a fresh
     * install that has never opened a picture — that must read as "no files",
     * not as a failed erase. Any OTHER throw is left to propagate, because a
     * permissions problem reported as an empty directory would show the person
     * a completed erase that deleted nothing.
     */
    /**
     * Bytes for one cache file, for the storage figure on the device-data screen.
     *
     * `File.size` is a SYNCHRONOUS property in expo-file-system 19 and answers 0
     * for a file that does not exist or cannot be read — so a file deleted
     * between the listing and this call costs nothing and reports nothing, which
     * is the behaviour wanted for a figure shown on a screen.
     *
     * Deliberately NOT `cacheFile(name).size`: that would hand the measurement a
     * handle with `delete()` on it, and this runs when a screen OPENS.
     */
    async cacheFileSize(name: string): Promise<number> {
      const f = new FileSystem.File(FileSystem.Paths.cache, name);
      return typeof f.size === 'number' ? f.size : 0;
    },

    async listCache(): Promise<string[]> {
      const dir = new FileSystem.Directory(FileSystem.Paths.cache);
      if (dir.exists === false) return [];
      // Sub-directories are listed too; their names are harmless here because
      // the caller matches on the mini-app's own file prefix, and it only ever
      // asks for `cacheFile(name).delete()` on a name it recognised.
      return dir.list().map((entry) => entry.name);
    },
  };
}
