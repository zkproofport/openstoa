// Ambient declaration so the mini-app's standalone tsc can resolve
// `expo-image-picker`, which is physically installed in the host app
// and surfaced via Metro at bundle time.
// Only the surface we actually use is typed here.
declare module 'expo-image-picker' {
  export const MediaTypeOptions: {
    Images: 'Images';
    Videos: 'Videos';
    All: 'All';
  };

  export interface PermissionResponse {
    status: 'granted' | 'denied' | 'undetermined';
    granted: boolean;
  }

  export interface ImagePickerAsset {
    uri: string;
    width: number;
    height: number;
    type?: string;
    fileName?: string;
    fileSize?: number;
    /** Present when `base64: true` was requested — the bytes an E2EE attachment encrypts. */
    base64?: string | null;
    /** The picked file's content type, e.g. `image/jpeg`. */
    mimeType?: string;
  }

  /**
   * iOS only. `Compatible` transcodes HEIC to JPEG in the picker.
   *
   * Chat attachments are encrypted on the device, so nothing downstream can
   * transcode them — the picker is the last place that can, and a HEIC that
   * gets past it is an image no browser can display.
   */
  export enum UIImagePickerPreferredAssetRepresentationMode {
    Automatic = 'automatic',
    Compatible = 'compatible',
    Current = 'current',
  }

  export interface ImagePickerResult {
    canceled: boolean;
    assets: ImagePickerAsset[];
  }

  export interface ImagePickerOptions {
    mediaTypes?: string;
    allowsEditing?: boolean;
    /** `[x, y]` crop ratio for the built-in editor. Only honoured alongside `allowsEditing`. */
    aspect?: [number, number];
    quality?: number;
    allowsMultipleSelection?: boolean;
    /**
     * Cap on how many assets one pick may return. Only meaningful alongside
     * `allowsMultipleSelection`, and it matters here because `base64: true`
     * makes the picker materialise every selected asset's bytes at once.
     */
    selectionLimit?: number;
    /** Return the picked bytes as base64 (see `ImagePickerAsset.base64`). */
    base64?: boolean;
    preferredAssetRepresentationMode?: UIImagePickerPreferredAssetRepresentationMode;
  }

  export function requestMediaLibraryPermissionsAsync(): Promise<PermissionResponse>;
  export function launchImageLibraryAsync(options?: ImagePickerOptions): Promise<ImagePickerResult>;
}
