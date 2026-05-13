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
  }

  export interface ImagePickerResult {
    canceled: boolean;
    assets: ImagePickerAsset[];
  }

  export interface ImagePickerOptions {
    mediaTypes?: string;
    allowsEditing?: boolean;
    quality?: number;
    allowsMultipleSelection?: boolean;
  }

  export function requestMediaLibraryPermissionsAsync(): Promise<PermissionResponse>;
  export function launchImageLibraryAsync(options?: ImagePickerOptions): Promise<ImagePickerResult>;
}
