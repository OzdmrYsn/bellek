import { ApiError, createFalClient } from '@fal-ai/client';
import { aspectToNumber, nearestAspect } from '../../shared/platforms.ts';
import type { FalCatalogItem, ModelConfig } from '../../shared/types.ts';
import { getSecret } from '../secrets.ts';
import { readCache, writeCache } from '../settings.ts';
import {
  ProviderError, download, isAbort, sleep, statusMessage, withRefLegend,
  type Adapter, type AdapterFactory, type ImageRequest, type Media, type RefImage, type VideoPoll,
  type VideoRequest, type VideoStart,
} from './types.ts';

const NAME = 'fal.ai';
const OPENAPI_URL = 'https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=';
const CATALOG_URL = 'https://api.fal.ai/v1/models';

// fal'daki her modelin girdi şeması farklıdır (image_urls / image_url /
// start_image_url, aspect_ratio / image_size, "5" / 5 / "8s" …). Elle eşleme
// tutmak yerine modelin yayımladığı OpenAPI şemasını okuyup isteği ona göre
// kuruyoruz; böylece katalogdaki herhangi bir uç nokta eklenince çalışır.

interface FalParam {
  type: string;
  enum: (string | number)[] | null;
  default: unknown;
  required: boolean;
  min: number | null;
  max: number | null;
  maxItems: number | null;
  /** {width, height} gibi bir nesne de kabul ediyor mu. */
  object: boolean;
}

export interface FalSchema {
  endpoint: string;
  category: string;
  params: Record<string, FalParam>;
}

type Json = Record<string, any>;

function resolveParam(spec: Json, schemas: Json, required: boolean): FalParam {
  let type: string | undefined = spec.type;
  let values: (string | number)[] = Array.isArray(spec.enum) ? [...spec.enum] : [];
  let object = false;
  let maxItems: number | null = typeof spec.maxItems === 'number' ? spec.maxItems : null;
  const variants: Json[] = [...(spec.anyOf ?? []), ...(spec.oneOf ?? []), ...(spec.allOf ?? [])];
  if (spec.$ref) variants.push(spec);
  for (const variant of variants) {
    const target: Json | undefined = variant.$ref ? schemas[String(variant.$ref).split('/').pop()!] : variant;
    if (!target) continue;
    if (Array.isArray(target.enum)) values = [...values, ...target.enum];
    if (target.type === 'object' || target.properties) object = true;
    if (typeof target.maxItems === 'number') maxItems = target.maxItems;
    if (!type && target.type && target.type !== 'null') type = target.type;
  }
  return {
    type: type ?? 'union',
    enum: values.length ? values : null,
    default: spec.default,
    required,
    min: typeof spec.minimum === 'number' ? spec.minimum : null,
    max: typeof spec.maximum === 'number' ? spec.maximum : null,
    maxItems,
    object,
  };
}

export async function loadFalSchema(endpoint: string): Promise<FalSchema | null> {
  const cacheKey = `fal.schema:${endpoint}`;
  const cached = readCache<FalSchema>(cacheKey, 7 * 86400000);
  if (cached) return cached;
  try {
    const response = await fetch(OPENAPI_URL + encodeURIComponent(endpoint), { signal: AbortSignal.timeout(20000) });
    if (!response.ok) return null;
    const doc = (await response.json()) as Json;
    const schemas: Json = doc.components?.schemas ?? {};
    let inputName: string | undefined;
    for (const item of Object.values<Json>(doc.paths ?? {})) {
      const ref = item?.post?.requestBody?.content?.['application/json']?.schema?.$ref;
      if (ref) {
        inputName = String(ref).split('/').pop();
        break;
      }
    }
    inputName ??= Object.keys(schemas).find((key) => /input$/i.test(key));
    const input: Json | undefined = inputName ? schemas[inputName] : undefined;
    if (!input?.properties) return null;
    const required = new Set<string>(input.required ?? []);
    const params: Record<string, FalParam> = {};
    for (const [name, spec] of Object.entries<Json>(input.properties)) {
      params[name] = resolveParam(spec, schemas, required.has(name));
    }
    const schema: FalSchema = { endpoint, category: doc.info?.['x-fal-metadata']?.category ?? '', params };
    writeCache(cacheKey, schema);
    return schema;
  } catch {
    return null;
  }
}

const ARRAY_REFS = ['image_urls', 'reference_image_urls', 'input_image_urls', 'ref_image_urls', 'images', 'input_images'];
const SINGLE_REFS = [
  'image_url', 'start_image_url', 'first_frame_url', 'first_frame_image_url', 'input_image_url',
  'reference_image_url', 'subject_image_url',
];
const NAMED_SIZES: [string, number][] = [
  ['square_hd', 1], ['square', 1], ['portrait_4_3', 3 / 4], ['portrait_16_9', 9 / 16],
  ['landscape_4_3', 4 / 3], ['landscape_16_9', 16 / 9],
];

function has(schema: FalSchema | null, names: string[]): string | null {
  if (!schema) return null;
  return names.find((name) => name in schema.params) ?? null;
}

function sizeFor(param: FalParam, aspect: string): unknown {
  const ratio = aspectToNumber(aspect);
  const options = (param.enum ?? []).map(String);
  const distance = (value: number) => Math.abs(Math.log(value) - Math.log(ratio));
  let best: { value: string; distance: number } | null = null;
  for (const option of options) {
    const named = NAMED_SIZES.find(([name]) => name === option);
    const pixels = option.match(/^(\d+)x(\d+)$/);
    const optionRatio = named ? named[1] : pixels ? Number(pixels[1]) / Number(pixels[2]) : null;
    if (optionRatio === null) continue;
    const d = distance(optionRatio);
    if (!best || d < best.distance) best = { value: option, distance: d };
  }
  // Hazır seçenekler orana yeterince yakın değilse ve model özel boyut alıyorsa tam ölçü ver.
  if (param.object && (!best || best.distance > 0.04)) {
    const round = (value: number) => Math.max(512, Math.round(value / 16) * 16);
    const height = round(Math.sqrt((1024 * 1280) / ratio));
    return { width: round(height * ratio), height };
  }
  return best?.value;
}

function durationFor(param: FalParam, seconds: number): unknown {
  if (param.enum?.length) {
    const numeric = param.enum
      .map((value) => ({ value, n: parseFloat(String(value)) }))
      .filter((item) => Number.isFinite(item.n));
    if (!numeric.length) return undefined;
    return numeric.reduce((a, b) => (Math.abs(b.n - seconds) < Math.abs(a.n - seconds) ? b : a)).value;
  }
  const clamped = Math.min(param.max ?? seconds, Math.max(param.min ?? seconds, seconds));
  if (param.type === 'integer' || param.type === 'number') return clamped;
  if (typeof param.default === 'string' && /s$/.test(param.default)) return `${clamped}s`;
  return param.type === 'string' ? String(clamped) : clamped;
}

interface BuildInput {
  prompt: string;
  refUrls: string[];
  startUrl?: string;
  aspect: string;
  count?: number;
  duration?: number;
  resolution?: string;
  /** İstenen tam piksel boyutu. */
  size?: { width: number; height: number };
  extra?: Record<string, unknown>;
}

export function buildFalInput(schema: FalSchema | null, input: BuildInput): Record<string, unknown> {
  const body: Record<string, unknown> = { prompt: input.prompt };
  const params = schema?.params ?? {};

  const arrayKey = has(schema, ARRAY_REFS);
  const singleKey = has(schema, SINGLE_REFS);
  if (input.startUrl) {
    if (singleKey) body[singleKey] = input.startUrl;
    else if (arrayKey) body[arrayKey] = [input.startUrl, ...input.refUrls];
    else body.image_url = input.startUrl;
  }
  if (input.refUrls.length && !(input.startUrl && !singleKey)) {
    if (arrayKey) {
      const max = params[arrayKey]?.maxItems ?? input.refUrls.length;
      body[arrayKey] = input.refUrls.slice(0, max);
    } else if (singleKey && !input.startUrl) {
      body[singleKey] = input.refUrls[0];
    } else if (!schema) {
      body.image_urls = input.refUrls;
    }
  }

  if (params.aspect_ratio) {
    const options = (params.aspect_ratio.enum ?? []).map(String);
    body.aspect_ratio = options.length ? nearestAspect(input.aspect, options) : input.aspect;
  } else if (params.image_size) {
    if (input.size && params.image_size.object) {
      // Özel boyut alan modellerde tam ölçüyü iste (uzun kenar 2048'i aşmayacak biçimde).
      const scale = Math.min(1, 2048 / Math.max(input.size.width, input.size.height));
      const round = (value: number) => Math.max(256, Math.round((value * scale) / 16) * 16);
      body.image_size = { width: round(input.size.width), height: round(input.size.height) };
    } else {
      const size = sizeFor(params.image_size, input.aspect);
      if (size !== undefined) body.image_size = size;
    }
  } else if (!schema) {
    body.aspect_ratio = input.aspect;
  }
  // "1K / 2K / 4K" basamağı olan modellerde hedefi karşılayan en küçük basamağı seç.
  if (input.size && !input.resolution && params.resolution?.enum) {
    const edge = Math.max(input.size.width, input.size.height);
    const tiers = params.resolution.enum
      .map((value) => ({ value, k: parseFloat(String(value)) }))
      .filter((tier) => /k$/i.test(String(tier.value)) && Number.isFinite(tier.k))
      .sort((a, b) => a.k - b.k);
    const tier = tiers.find((t) => t.k * 1024 >= edge) ?? tiers[tiers.length - 1];
    if (tier) body.resolution = tier.value;
  }

  if (input.count && input.count > 1 && params.num_images) {
    body.num_images = Math.min(input.count, params.num_images.max ?? 4);
  }
  if (input.duration && params.duration) {
    const value = durationFor(params.duration, input.duration);
    if (value !== undefined) body.duration = value;
  }
  if (input.resolution && params.resolution?.enum) {
    const match = params.resolution.enum.find((v) => String(v).toLowerCase() === input.resolution!.toLowerCase());
    if (match !== undefined) body.resolution = match;
  }
  // Varsayılanı olup yine de zorunlu işaretlenmiş alanları doldur.
  for (const [name, param] of Object.entries(params)) {
    if (param.required && body[name] === undefined && param.default !== undefined && param.default !== null) {
      body[name] = param.default;
    }
  }
  return { ...body, ...(input.extra ?? {}) };
}

function collectUrls(data: unknown): string[] {
  const urls: string[] = [];
  const visit = (value: unknown) => {
    if (!value) return;
    if (typeof value === 'string') {
      if (/^https?:\/\//.test(value)) urls.push(value);
    } else if (Array.isArray(value)) value.forEach(visit);
    else if (typeof value === 'object' && typeof (value as Json).url === 'string') urls.push((value as Json).url);
  };
  const body = (data ?? {}) as Json;
  for (const key of ['images', 'image', 'video', 'videos', 'output']) visit(body[key]);
  return urls;
}

function translate(error: unknown): Error {
  if (isAbort(error)) return error as Error;
  if (error instanceof ProviderError) return error;
  if (error instanceof ApiError) {
    const body = error.body as Json | undefined;
    const detail = body?.detail;
    let text = '';
    if (typeof detail === 'string') text = detail;
    else if (Array.isArray(detail)) {
      if (detail.some((item) => /content_policy|safety/i.test(String(item?.type ?? '')))) {
        return new ProviderError(`${NAME}: istem ya da referans görsel içerik kurallarına takıldı. İfadeyi değiştirip yeniden deneyin.`);
      }
      text = detail.map((item) => `${(item?.loc ?? []).slice(1).join('.')}: ${item?.msg ?? ''}`.replace(/^: /, '')).join('; ');
    }
    return statusMessage(error.status, NAME, text || error.message);
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/fetch failed|ENOTFOUND|ECONNRESET|network/i.test(message)) {
    return new ProviderError(`${NAME} sunucusuna bağlanılamadı. İnternet bağlantınızı kontrol edin.`, true);
  }
  return error instanceof Error ? error : new Error(message);
}

export const createFal: AdapterFactory = (_provider, apiKey) => {
  const client = createFalClient({ credentials: apiKey, suppressLocalCredentialsWarning: true });

  async function upload(ref: RefImage): Promise<string> {
    const blob = new Blob([new Uint8Array(ref.data)], { type: ref.mime });
    return client.storage.upload(blob);
  }

  async function waitFor(endpoint: string, requestId: string, signal: AbortSignal | undefined, onStage?: (s: string) => void) {
    const started = Date.now();
    for (;;) {
      const status = await client.queue.status(endpoint, { requestId, logs: false, abortSignal: signal });
      if (status.status === 'COMPLETED') break;
      onStage?.(status.status === 'IN_QUEUE' ? 'Sırada' : 'Üretiliyor');
      if (Date.now() - started > 10 * 60000) throw new ProviderError(`${NAME}: üretim zaman aşımına uğradı.`, true);
      await sleep(1500, signal);
    }
    return client.queue.result(endpoint, { requestId, abortSignal: signal });
  }

  async function image(request: ImageRequest): Promise<Media[]> {
    const options = request.model.options ?? {};
    try {
      let endpoint = request.model.id;
      let refs = request.refs;
      if (refs.length && options.editEndpoint) endpoint = options.editEndpoint;
      let schema = await loadFalSchema(endpoint);
      const acceptsRefs = !!(has(schema, ARRAY_REFS) ?? has(schema, SINGLE_REFS));
      if (refs.length && schema && !acceptsRefs) refs = [];
      if (!refs.length && schema && acceptsRefs) {
        const key = has(schema, ARRAY_REFS) ?? has(schema, SINGLE_REFS);
        if (key && schema.params[key].required) {
          throw new ProviderError(`${request.model.label} bir referans görsel gerektiriyor. Bir kişi, marka ya da görsel ekleyin.`);
        }
      }
      if (!has(schema, ARRAY_REFS) && has(schema, SINGLE_REFS)) refs = refs.slice(0, 1);

      request.onStage?.(refs.length ? 'Referanslar yükleniyor' : 'Sırada');
      const refUrls = await Promise.all(refs.map(upload));
      const body = buildFalInput(schema, {
        prompt: withRefLegend(request.prompt, refs),
        refUrls,
        aspect: request.aspect,
        count: request.count,
        size: request.size,
        extra: options.extra,
      });
      // Tek istekte birden fazla görsel üretemeyen uç noktalarda adet kadar paralel istek atılır.
      const batches = request.count > 1 && !schema?.params.num_images ? request.count : 1;
      const runs = await Promise.allSettled(
        Array.from({ length: batches }, async () => {
          const submitted = await client.queue.submit(endpoint, { input: body, abortSignal: request.signal });
          const result = await waitFor(endpoint, submitted.request_id, request.signal, request.onStage);
          return collectUrls(result.data);
        }),
      );
      const urls = runs.flatMap((run) => (run.status === 'fulfilled' ? run.value : []));
      if (!urls.length) {
        const failed = runs.find((run): run is PromiseRejectedResult => run.status === 'rejected');
        if (failed) throw failed.reason;
        throw new ProviderError(`${NAME} görsel döndürmedi.`);
      }
      const media = await Promise.all(urls.map((url) => download(url, {}, request.signal)));
      return media.map((item) => ({ data: item.data, mime: item.mime.startsWith('image/') ? item.mime : 'image/png' }));
    } catch (error) {
      throw translate(error);
    }
  }

  async function videoStart(request: VideoRequest): Promise<VideoStart> {
    const options = request.model.options ?? {};
    try {
      let endpoint = request.model.id;
      if (request.start && options.imageEndpoint) endpoint = options.imageEndpoint;
      else if (!request.start && request.refs.length && options.refEndpoint) endpoint = options.refEndpoint;
      const schema = await loadFalSchema(endpoint);
      const needsImage = [...SINGLE_REFS, ...ARRAY_REFS].some((name) => schema?.params[name]?.required);
      if (needsImage && !request.start && !request.refs.length) {
        throw new ProviderError(
          `${request.model.label} bir başlangıç görseli gerektiriyor. Bir görsel ekleyin ya da bir kişi anıp "Önce anahtar kare" seçeneğini açın.`,
        );
      }
      const startUrl = request.start ? await upload(request.start) : undefined;
      const refUrls = endpoint === options.refEndpoint || !options.refEndpoint
        ? await Promise.all(request.refs.map(upload))
        : [];
      const body = buildFalInput(schema, {
        prompt: withRefLegend(request.prompt, refUrls.length ? request.refs : []),
        refUrls,
        startUrl,
        aspect: request.aspect,
        duration: request.duration,
        resolution: request.resolution,
        extra: options.extra,
      });
      const submitted = await client.queue.submit(endpoint, { input: body, abortSignal: request.signal });
      return { externalId: submitted.request_id, meta: { endpoint } };
    } catch (error) {
      throw translate(error);
    }
  }

  async function videoPoll(externalId: string, meta: Record<string, unknown>, model: ModelConfig, signal?: AbortSignal): Promise<VideoPoll> {
    const endpoint = String(meta.endpoint ?? model.id);
    try {
      const status = await client.queue.status(endpoint, { requestId: externalId, logs: false, abortSignal: signal });
      if (status.status === 'IN_QUEUE') {
        return { status: 'running', stage: status.queue_position ? `Sırada (${status.queue_position})` : 'Sırada' };
      }
      if (status.status === 'IN_PROGRESS') return { status: 'running', stage: 'Üretiliyor' };
      const result = await client.queue.result(endpoint, { requestId: externalId, abortSignal: signal });
      const url = collectUrls(result.data)[0];
      if (!url) return { status: 'failed', error: `${NAME} video döndürmedi.` };
      const media = await download(url, {}, signal);
      return { status: 'succeeded', media: { data: media.data, mime: media.mime.startsWith('video/') ? media.mime : 'video/mp4' } };
    } catch (error) {
      const translated = translate(error);
      if (isAbort(translated)) throw translated;
      if (translated instanceof ProviderError && translated.retryable) return { status: 'running', stage: 'Bağlantı bekleniyor' };
      return { status: 'failed', error: translated.message };
    }
  }

  const adapter: Adapter = {
    image,
    videoStart,
    videoPoll,
    async test() {
      try {
        // Depoya küçük bir dosya yüklemek, anahtarı doğrulayan en ucuz yetkili çağrıdır.
        await client.storage.upload(new Blob([new Uint8Array([66, 101, 108, 108, 101, 107])], { type: 'text/plain' }));
        return 'Bağlantı tamam. Anahtar kabul edildi.';
      } catch (error) {
        throw translate(error);
      }
    },
  };
  return adapter;
};

// ───────────────────────── Araçlar ─────────────────────────

export const FAL_TOOLS = {
  removeBackground: { endpoint: 'fal-ai/birefnet/v2', label: 'Arka plan silme' },
  upscale: { endpoint: 'fal-ai/seedvr/upscale/image', label: 'Çözünürlük yükseltme' },
};

/** Tek görsel alıp tek görsel döndüren fal araçlarını (arka plan silme, yükseltme) çalıştırır. */
export async function runFalTool(
  apiKey: string, endpoint: string, image: { data: Buffer; mime: string }, input: Record<string, unknown>,
  signal?: AbortSignal, onStage?: (stage: string) => void,
): Promise<Media> {
  const client = createFalClient({ credentials: apiKey, suppressLocalCredentialsWarning: true });
  try {
    onStage?.('Görsel yükleniyor');
    const imageUrl = await client.storage.upload(new Blob([new Uint8Array(image.data)], { type: image.mime }));
    const submitted = await client.queue.submit(endpoint, { input: { image_url: imageUrl, ...input }, abortSignal: signal });
    const started = Date.now();
    for (;;) {
      const status = await client.queue.status(endpoint, { requestId: submitted.request_id, logs: false, abortSignal: signal });
      if (status.status === 'COMPLETED') break;
      onStage?.(status.status === 'IN_QUEUE' ? 'Sırada' : 'İşleniyor');
      if (Date.now() - started > 8 * 60000) throw new ProviderError(`${NAME}: işlem zaman aşımına uğradı.`, true);
      await sleep(1500, signal);
    }
    const result = await client.queue.result(endpoint, { requestId: submitted.request_id, abortSignal: signal });
    const url = collectUrls(result.data)[0];
    if (!url) throw new ProviderError(`${NAME} sonuç döndürmedi.`);
    const media = await download(url, {}, signal);
    return { data: media.data, mime: media.mime.startsWith('image/') ? media.mime : 'image/png' };
  } catch (error) {
    throw translate(error);
  }
}

// ───────────────────────── Katalog ─────────────────────────

function toCatalogItem(entry: Json): FalCatalogItem {
  const meta: Json = entry.metadata ?? {};
  return {
    endpointId: String(entry.endpoint_id),
    name: String(meta.display_name ?? entry.endpoint_id),
    category: String(meta.category ?? ''),
    description: String(meta.description ?? ''),
    group: String(meta.group?.key ?? ''),
    groupLabel: String(meta.group?.label ?? ''),
    thumbnailUrl: String(meta.thumbnail_url ?? ''),
    date: String(meta.date ?? ''),
  };
}

/**
 * fal'ın model kataloğunu sorgular. Katalog anahtarsız da okunur ama sıkı bir
 * hız sınırı vardır; bu yüzden yanıtlar bir saat önbellekte tutulur ve
 * kullanıcının fal anahtarı varsa onunla sorgulanır.
 */
async function catalogFetch(params: Record<string, string>): Promise<FalCatalogItem[]> {
  const url = new URL(CATALOG_URL);
  for (const [key, value] of Object.entries(params)) if (value) url.searchParams.set(key, value);
  const cacheKey = `fal.catalog:${url.search}`;
  const cached = readCache<FalCatalogItem[]>(cacheKey, 3600000);
  if (cached) return cached;
  const key = getSecret('fal');
  let response = await fetch(url, {
    headers: key ? { Authorization: `Key ${key}` } : {},
    signal: AbortSignal.timeout(20000),
  });
  // Katalog herkese açıktır: kayıtlı anahtar geçersizse anahtarsız yeniden dene.
  if (key && (response.status === 401 || response.status === 403)) {
    response = await fetch(url, { signal: AbortSignal.timeout(20000) });
  }
  if (response.status === 429) {
    throw new ProviderError('fal.ai kataloğu şu anda çok sık sorgulandı. Birkaç saniye bekleyip yeniden deneyin.', true);
  }
  if (!response.ok) throw new ProviderError(`fal.ai kataloğu okunamadı (${response.status}).`, true);
  const body = (await response.json()) as Json;
  const items = ((body.models ?? []) as Json[]).filter((entry) => entry.metadata?.status !== 'deprecated').map(toCatalogItem);
  writeCache(cacheKey, items);
  return items;
}

export async function searchFalCatalog(query: string, category: string): Promise<FalCatalogItem[]> {
  const items = await catalogFetch({ limit: '40', q: query.trim(), category });
  return items.filter((item) => /text-to-image|image-to-image|text-to-video|image-to-video/.test(item.category));
}

const IMAGE_SUFFIXES = ['text-to-image', 'edit', 'edit-image', 'image-to-image'];
const VIDEO_SUFFIXES = ['text-to-video', 'image-to-video', 'reference-to-video'];
const SUFFIXES = [...IMAGE_SUFFIXES, ...VIDEO_SUFFIXES];

/**
 * Yapıştırılan tek bir uç noktadan tam bir model kaydı çıkarır: kardeş uç
 * noktaları (düzenleme, ilk kareden video, referanstan video) bulur, şemadan
 * oranları, süreleri ve referans sınırını okur.
 */
export async function describeFalModel(endpointId: string): Promise<ModelConfig> {
  const id = endpointId
    .trim()
    .replace(/^https?:\/\/fal\.ai\/models\//, '')
    .replace(/\/(api|playground)\/?$/, '')
    .replace(/^\/+|\/+$/g, '');
  if (!id) throw new ProviderError('Bir fal.ai uç nokta kimliği girin (ör. kling/v4/text-to-video).');

  const segments = id.split('/');
  const last = segments[segments.length - 1];
  const base = SUFFIXES.includes(last) ? segments.slice(0, -1).join('/') : id;

  // Tek bir katalog araması hem modelin adını hem kardeşlerini getirir.
  let entries: FalCatalogItem[] = [];
  try {
    entries = await catalogFetch({ limit: '40', q: base });
  } catch {
    // Katalog yanıt vermezse kardeşler şemaların varlığından anlaşılır.
  }
  const self = entries.find((entry) => entry.endpointId === id) ?? null;
  const selfSchema = await loadFalSchema(id);
  if (!self && !selfSchema) throw new ProviderError(`"${id}" fal.ai kataloğunda bulunamadı.`);

  const category = self?.category ?? selfSchema?.category ?? '';
  const isVideo = /video/.test(category) && !/video-to-video/.test(category) ? true : VIDEO_SUFFIXES.includes(last);
  const exists = async (candidate: string): Promise<boolean> => {
    if (candidate === id) return true;
    if (self) return entries.some((entry) => entry.endpointId === candidate);
    return !!(await loadFalSchema(candidate));
  };
  const sibling = async (suffixes: string[]): Promise<string | undefined> => {
    for (const suffix of suffixes) {
      const candidate = suffix ? `${base}/${suffix}` : base;
      if (await exists(candidate)) return candidate;
    }
    return undefined;
  };
  const label = (self?.name ?? base.split('/').slice(1).join(' '))
    .replace(/\s+(Text to (Image|Video)|Image to Video|Reference to Video|Edit|Image Editing|API)\s*$/i, '')
    .trim();

  if (isVideo) {
    const t2v = await sibling(['text-to-video']);
    const i2v = await sibling(['image-to-video']);
    const r2v = await sibling(['reference-to-video']);
    const main = t2v ?? i2v ?? r2v ?? id;
    const schema = (await loadFalSchema(main)) ?? selfSchema;
    const refSchema = r2v ? await loadFalSchema(r2v) : null;
    const durationParam = schema?.params.duration;
    const common = [4, 5, 6, 8, 10, 12, 15];
    let durations = [5, 10];
    if (durationParam?.enum) {
      const numeric = [...new Set(durationParam.enum.map((v) => parseFloat(String(v))).filter(Number.isFinite))];
      if (numeric.length) durations = numeric.length > 6 ? numeric.filter((n) => common.includes(n)) : numeric;
    } else if (durationParam && durationParam.min !== null && durationParam.max !== null) {
      durations = common.filter((n) => n >= durationParam.min! && n <= durationParam.max!);
    }
    const aspects = (schema?.params.aspect_ratio?.enum ?? ['16:9', '9:16']).map(String).filter((a) => /^\d+:\d+$/.test(a));
    const refKey = has(refSchema, ARRAY_REFS);
    return {
      id: main,
      label,
      kind: 'video',
      maxRefs: r2v ? Math.min(12, refSchema?.params[refKey ?? '']?.maxItems ?? 4) : i2v ? 1 : 0,
      durations: durations.length ? durations : [5],
      aspects: aspects.length ? aspects : ['16:9', '9:16'],
      enabled: true,
      custom: true,
      options: {
        ...(i2v && i2v !== main ? { imageEndpoint: i2v } : {}),
        ...(r2v && r2v !== main ? { refEndpoint: r2v } : {}),
      },
    };
  }

  // Görsel: metinden üretim uç noktası ana kimliktir; referans alan kardeşi düzenleme için saklanır.
  const takesImages = /image-to-image/.test(category);
  const t2i = takesImages ? await sibling(['text-to-image', '']) : id;
  const edit = takesImages ? id : await sibling(['edit', 'edit-image', 'image-to-image']);
  const main = t2i ?? id;
  const editEndpoint = edit && edit !== main ? edit : undefined;
  const refSchema = editEndpoint ? await loadFalSchema(editEndpoint) : takesImages ? selfSchema : null;
  const arrayKey = has(refSchema, ARRAY_REFS);
  const maxRefs = refSchema
    ? arrayKey ? Math.min(16, refSchema.params[arrayKey].maxItems ?? 8) : has(refSchema, SINGLE_REFS) ? 1 : 0
    : 0;
  return {
    id: main,
    label,
    kind: 'image',
    maxRefs,
    enabled: true,
    custom: true,
    options: editEndpoint ? { editEndpoint } : {},
  };
}
