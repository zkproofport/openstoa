/*
 * Just enough of `expo-image-manipulator` to transcode a picked HEIC into a
 * JPEG before upload.
 *
 * Unlike the other expo shims here, this module is NOT installed anywhere —
 * not in this package and not in the host app (see the `TODO(dep)` in
 * `PostCreateScreen.tsx`). The call site is a guarded `require()` that
 * degrades to "upload the raw URI" when the module is absent, which is the
 * state today: the conversion never runs. The declaration exists so that
 * guarded path is TYPE-CHECKED rather than silently `any`, and so the day the
 * dependency lands in the host, the call site is already correct.
 *
 * Deliberately partial — only the legacy `manipulateAsync` surface the upload
 * path uses. A call to anything undeclared fails here instead of passing
 * against a fiction.
 */
declare module 'expo-image-manipulator' {
  export enum SaveFormat {
    JPEG = 'jpeg',
    PNG = 'png',
    WEBP = 'webp',
  }

  /**
   * Actions are applied in order before the save. The upload path passes an
   * empty list: it wants the re-encode, not a transform.
   */
  export type Action =
    | { resize: { width?: number; height?: number } }
    | { rotate: number }
    | { flip: 'vertical' | 'horizontal' }
    | { crop: { originX: number; originY: number; width: number; height: number } };

  export interface SaveOptions {
    /** 0..1. Only meaningful for `SaveFormat.JPEG`. */
    compress?: number;
    format?: SaveFormat;
    base64?: boolean;
  }

  export interface ImageResult {
    uri: string;
    width: number;
    height: number;
    /** Present only when `base64: true` was requested. */
    base64?: string;
  }

  export function manipulateAsync(
    uri: string,
    actions?: Action[],
    saveOptions?: SaveOptions,
  ): Promise<ImageResult>;
}
