import type { ModelConfig, ModelKind, ProviderInfo } from '../../shared/types.ts';

export type ChatPart = { type: 'text'; text: string } | { type: 'image'; data: Buffer; mime: string };

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: ChatPart[];
}

export interface TextRequest {
  model: ModelConfig;
  system: string;
  messages: ChatMessage[];
  /** Küçük, hızlı işler için 'low'; sohbet için 'medium'. */
  effort?: 'low' | 'medium' | 'high';
  signal?: AbortSignal;
  onDelta?: (text: string) => void;
}

export interface TextResult {
  text: string;
  usage: { input: number; output: number };
}

export interface RefImage {
  data: Buffer;
  mime: string;
  /** Modele görselin ne olduğunu söyleyen kısa etiket. */
  label: string;
}

export interface Media {
  data: Buffer;
  mime: string;
}

export interface ImageRequest {
  model: ModelConfig;
  prompt: string;
  refs: RefImage[];
  aspect: string;
  count: number;
  quality?: string;
  /** İstenen tam piksel boyutu; sağlayıcı en yakın çözünürlüğü üretir, kesin ölçü sonradan verilir. */
  size?: { width: number; height: number };
  /**
   * Bölge düzenleme maskesi (gri tonlamalı PNG, beyaz = değişecek alan), ilk
   * referansla aynı boyutta. Yalnızca maskeyi doğrudan destekleyen sağlayıcılar kullanır.
   */
  mask?: Buffer;
  signal?: AbortSignal;
  onStage?: (stage: string) => void;
}

export interface SpeechRequest {
  text: string;
  voice?: string;
  signal?: AbortSignal;
}

export interface VideoRequest {
  model: ModelConfig;
  prompt: string;
  /** Videonun ilk karesi. */
  start?: RefImage;
  refs: RefImage[];
  aspect: string;
  duration: number;
  resolution?: string;
  signal?: AbortSignal;
}

/** Uzun süren video işleri: kimlik saklanır, sunucu yeniden başlasa da sorgulanır. */
export type VideoStart = { externalId: string; meta?: Record<string, unknown> } | { media: Media };

export interface VideoPoll {
  status: 'running' | 'succeeded' | 'failed';
  stage?: string;
  progress?: number;
  media?: Media;
  error?: string;
}

export interface FetchedModel {
  id: string;
  label: string;
  kind: ModelKind;
}

export interface Adapter {
  text?(request: TextRequest): Promise<TextResult>;
  image?(request: ImageRequest): Promise<Media[]>;
  videoStart?(request: VideoRequest): Promise<VideoStart>;
  videoPoll?(externalId: string, meta: Record<string, unknown>, model: ModelConfig, signal?: AbortSignal): Promise<VideoPoll>;
  listModels?(): Promise<FetchedModel[]>;
  /** Metni sese çevirir. `mime` ses biçimini söyler (ör. audio/mpeg ya da ham PCM). */
  speech?(request: SpeechRequest): Promise<Media>;
  /** Anahtarı ucuz bir çağrıyla doğrular. */
  test(): Promise<string>;
}

export type AdapterFactory = (provider: ProviderInfo, apiKey: string) => Adapter;

/** Kullanıcıya gösterilebilecek, Türkçe ve eyleme dönük hata. */
export class ProviderError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable = false) {
    super(message);
    this.name = 'ProviderError';
    this.retryable = retryable;
  }
}

export function statusMessage(status: number | undefined, provider: string, detail: string): ProviderError {
  const tail = detail ? ` (${detail.slice(0, 400)})` : '';
  switch (status) {
    case 400:
    case 422:
      return new ProviderError(`${provider} isteği reddetti${tail}`);
    case 401:
      return new ProviderError(`${provider} API anahtarı geçersiz. Ayarlar'dan anahtarı kontrol edin.`);
    case 402:
      return new ProviderError(`${provider} hesabında bakiye ya da ödeme sorunu var.${tail}`);
    case 403:
      return new ProviderError(`${provider} bu işlem için izin vermiyor${tail}`);
    case 404:
      return new ProviderError(`${provider}: model bulunamadı ya da hesabınızda açık değil${tail}`);
    case 413:
      return new ProviderError(`${provider}: istek çok büyük. Daha az ya da daha küçük görsel deneyin.`);
    case 429:
      return new ProviderError(`${provider} hız ya da kota sınırına takıldı. Biraz bekleyip yeniden deneyin.`, true);
    default:
      if (status && status >= 500) {
        return new ProviderError(`${provider} şu anda yanıt veremiyor (${status}). Biraz sonra yeniden deneyin.`, true);
      }
      return new ProviderError(`${provider} hatası${tail || ''}`.trim());
  }
}

export function isAbort(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || error.name === 'APIUserAbortError' || /aborted|abort/i.test(error.message))
  );
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function download(url: string, headers: Record<string, string> = {}, signal?: AbortSignal): Promise<Media> {
  const response = await fetch(url, { headers, signal });
  if (!response.ok) throw new ProviderError(`Üretilen dosya indirilemedi (${response.status}).`, true);
  const data = Buffer.from(await response.arrayBuffer());
  return { data, mime: response.headers.get('content-type')?.split(';')[0] ?? 'application/octet-stream' };
}

/** Referans etiketlerini istemin sonuna ekler: "Görsel 1: Yasin (kişi)". */
export function withRefLegend(prompt: string, refs: RefImage[]): string {
  if (!refs.length) return prompt;
  const lines = refs.map((ref, index) => `Image ${index + 1}: ${ref.label}`);
  return `${prompt}\n\nReference images attached, in order:\n${lines.join('\n')}`;
}
