import type { Asset } from '../../shared/types.ts';

export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function parse<T>(response: Response): Promise<T> {
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!response.ok) {
    const message =
      (body as { error?: string } | null)?.error ??
      (response.status === 0 || response.status >= 502
        ? 'Sunucuya ulaşılamıyor. Bellek çalışıyor mu?'
        : `İstek başarısız oldu (${response.status}).`);
    if (response.status === 401) window.dispatchEvent(new Event('bellek:oturum'));
    throw new ApiError(message, response.status);
  }
  return body as T;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError('Sunucuya ulaşılamıyor. Bellek çalışıyor mu?', 0);
  }
  return parse<T>(response);
}

export interface UploadResult {
  assets: Asset[];
  errors: { filename: string; error: string }[];
}

/** İlerleme bildirebilmek için XHR kullanır. */
function upload(files: File[] | Blob[], fields: Record<string, string> = {}, onProgress?: (ratio: number) => void): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    for (const file of files) {
      form.append('files', file, file instanceof File ? file.name : 'gorsel.jpg');
    }
    for (const [key, value] of Object.entries(fields)) form.append(key, value);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/assets');
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress?.(event.loaded / event.total);
    };
    xhr.onerror = () => reject(new ApiError('Yükleme sırasında bağlantı koptu.', 0));
    xhr.onload = () => {
      let body: UploadResult | { error?: string } | null = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        body = null;
      }
      const result = body as UploadResult | null;
      if (result?.assets) return resolve(result);
      reject(new ApiError((body as { error?: string } | null)?.error ?? `Yükleme başarısız oldu (${xhr.status}).`, xhr.status));
    };
    xhr.send(form);
  });
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body: unknown = {}) => request<T>('POST', path, body),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
  upload,
};

export function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '' || value === false) continue;
    search.set(key, value === true ? '1' : String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}
