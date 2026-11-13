import type { Asset } from '../../shared/types.ts';
import { api } from '../lib/api.ts';
import { invalidateAssets, refreshApp } from '../lib/queries.ts';
import { toast } from '../lib/store.ts';

const ACCEPTED = /^(image\/|video\/(mp4|quicktime|webm))/;
const BY_NAME = /\.(jpe?g|png|webp|gif|avif|heic|heif|tiff?|mp4|mov|webm|m4v)$/i;

export const ACCEPT_ATTR = 'image/*,video/mp4,video/quicktime,video/webm,.heic,.heif';

export function mediaFiles(list: FileList | File[] | null | undefined): File[] {
  return Array.from(list ?? []).filter((file) => ACCEPTED.test(file.type) || BY_NAME.test(file.name));
}

/** Dosyaları kütüphaneye yükler; reddedilenleri nedenleriyle birlikte bildirir. */
export async function uploadFiles(
  files: File[] | Blob[],
  fields: Record<string, string> = {},
  onProgress?: (ratio: number) => void,
): Promise<Asset[]> {
  if (!files.length) return [];
  try {
    const result = await api.upload(files, fields, onProgress);
    if (result.errors.length) {
      const first = result.errors[0];
      toast(
        result.errors.length === 1 ? first.error : `${result.errors.length} dosya yüklenemedi. İlki: ${first.error}`,
        'error',
      );
    }
    invalidateAssets();
    void refreshApp();
    return result.assets;
  } catch (error) {
    toast(error instanceof Error ? error.message : 'Yükleme başarısız oldu.', 'error');
    return [];
  }
}

export function filesFromDrop(event: React.DragEvent | DragEvent): File[] {
  return mediaFiles(event.dataTransfer?.files);
}

export function hasFiles(event: React.DragEvent | DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes('Files');
}
