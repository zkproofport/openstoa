/*
 * Just enough of `expo-file-system` for moving an attachment's bytes around.
 *
 * Declared here rather than installed, for the same reason as
 * `expo-image-picker`: the module is physically installed in the HOST app —
 * `expo` depends on it, and it is already linked into the iOS binary — while
 * the mini-app only borrows it at runtime through a guarded `require`. So this
 * package has the types without the dependency, and a host build that predates
 * the module degrades to "attachments are unavailable" rather than to a crash.
 *
 * Deliberately partial. Everything the attachment path touches is here and
 * nothing else, so a future call to something undeclared fails at the import
 * instead of passing against a fiction.
 */
declare module 'expo-file-system' {
  /** Well-known locations. `cache` is where a hand-it-on copy belongs. */
  export class Paths {
    static readonly cache: Directory;
    static readonly document: Directory;
  }

  export class Directory {
    /**
     * A directory instance may be created for a path that does not exist, so
     * the constructor takes the same URI parts `File` does.
     */
    constructor(...uris: (string | File | Directory)[]);
    readonly uri: string;
    /** False for a path that is not there — a cache directory nothing has written to yet. */
    readonly exists: boolean;
    /** File name, extension included. */
    readonly name: string;
    /**
     * The directory's contents, SYNCHRONOUSLY, throwing when it does not exist.
     *
     * Sub-directories come back too, hence the union. The only caller
     * (`deviceDataErase`, through `hostAttachmentFs.listCache`) reads `.name`
     * and matches it against the mini-app's own filename prefix, which is what
     * lets it work over a cache directory shared with the host app.
     */
    list(): (Directory | File)[];
  }

  /**
   * `write` and `delete` are SYNCHRONOUS in this API — it works over JSI
   * rather than returning promises. `bytes()` and `downloadFileAsync` are the
   * two that are not, and both are async for a reason: one reads a file that
   * may be megabytes, the other is a network request.
   */
  export class File {
    constructor(...uris: (string | File | Directory)[]);
    readonly uri: string;
    readonly exists: boolean;
    /** File name, extension included. Read by `Directory.list()` callers. */
    readonly name: string;
    /**
     * Bytes. `0` when the file does not exist or cannot be read — expo's own
     * wording, and the reason a missing file needs no separate branch.
     */
    readonly size: number;
    /**
     * Bytes, WITHOUT base64.
     *
     * This is the whole reason the download goes through a file. React Native's
     * `Response.arrayBuffer()` is not dependable (facebook/react-native#6743)
     * because only strings cross the bridge, so a `fetch` of a multi-megabyte
     * ciphertext means building and then decoding a multi-megabyte string on
     * the JS thread. Reading it here is a JSI call over bytes that are already
     * on disk.
     */
    bytes(): Promise<Uint8Array>;
    write(content: string | Uint8Array, options?: { encoding?: 'utf8' | 'base64' }): void;
    delete(): void;
    /**
     * Download straight to `destination`, natively — the response body never
     * enters JS. Rejects with `UnableToDownload` on a non-2xx status, and on
     * iOS leaves no file behind when it does.
     *
     * `idempotent: true` overwrites an existing file instead of rejecting,
     * which is what a retry of the same attachment needs.
     */
    static downloadFileAsync(
      url: string,
      destination: Directory | File,
      options?: { headers?: Record<string, string>; idempotent?: boolean },
    ): Promise<File>;
  }
}
