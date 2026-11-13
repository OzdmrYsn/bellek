import { GoogleGenAI, type Content, type Interactions, type Part } from '@google/genai';
import { nearestAspect } from '../../shared/platforms.ts';
import type { ModelKind } from '../../shared/types.ts';
import {
  ProviderError, download, isAbort, statusMessage,
  type Adapter, type AdapterFactory, type FetchedModel, type ImageRequest, type Media, type RefImage,
  type SpeechRequest, type TextRequest, type TextResult, type VideoPoll, type VideoRequest, type VideoStart,
} from './types.ts';

const NAME = 'Gemini';

const IMAGE_ASPECTS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];

type InputPart = Interactions.Content;

function classify(id: string): ModelKind | null {
  if (/embedding|tts|live|transcribe|aqa|robotics|agent|learnlm|gemma|computer/.test(id)) return null;
  if (/omni|^veo/.test(id)) return 'video';
  if (/image|banana|^imagen/.test(id)) return 'image';
  if (/^gemini/.test(id)) return 'text';
  return null;
}

/** Google hataları iç içe JSON olarak gelir; en içteki okunur iletiyi çıkarır. */
function deepMessage(text: string, depth = 0): string {
  if (depth > 4) return text;
  const start = text.search(/[[{]/);
  if (start >= 0) {
    try {
      const parsed = JSON.parse(text.slice(start)) as unknown;
      const node = (Array.isArray(parsed) ? parsed[0] : parsed) as { error?: { message?: unknown }; message?: unknown } | undefined;
      const inner = node?.error?.message ?? node?.message;
      if (typeof inner === 'string' && inner) return deepMessage(inner, depth + 1);
    } catch {
      // JSON değilse metnin kendisi iletidir.
    }
  }
  return text;
}

function translate(error: unknown): Error {
  if (isAbort(error)) return error as Error;
  if (error instanceof ProviderError) return error;
  const anyError = error as { status?: number; statusCode?: number; message?: string; body?: unknown };
  const status = anyError?.status ?? anyError?.statusCode;
  const raw = typeof anyError?.body === 'string' && anyError.body ? anyError.body : anyError?.message ?? String(error);
  const detail = deepMessage(raw).replace(/\s+/g, ' ').trim();
  if (/API key not valid|API_KEY_INVALID|API key expired/i.test(`${detail} ${raw}`)) return statusMessage(401, NAME, '');
  if (typeof status === 'number') return statusMessage(status, NAME, detail);
  if (/fetch failed|ENOTFOUND|ECONNRESET|network/i.test(detail)) {
    return new ProviderError(`${NAME} sunucusuna bağlanılamadı. İnternet bağlantınızı kontrol edin.`, true);
  }
  return new ProviderError(`${NAME}: ${detail.slice(0, 400)}`);
}

/** Referansları etiketleriyle sıralar: önce ne olduğu, sonra görselin kendisi. */
function referenceParts(refs: RefImage[]): InputPart[] {
  const parts: InputPart[] = [];
  let lastLabel = '';
  for (const ref of refs) {
    if (ref.label !== lastLabel) {
      parts.push({ type: 'text', text: `Reference — ${ref.label}:` });
      lastLabel = ref.label;
    }
    parts.push({ type: 'image', mime_type: ref.mime, data: ref.data.toString('base64') });
  }
  return parts;
}

function imagesOf(interaction: Interactions.Interaction): Media[] {
  const found: Media[] = [];
  for (const step of interaction.steps ?? []) {
    if (step.type !== 'model_output') continue;
    for (const item of step.content ?? []) {
      if (item.type === 'image' && item.data) {
        found.push({ data: Buffer.from(item.data, 'base64'), mime: item.mime_type ?? 'image/png' });
      }
    }
  }
  if (!found.length && interaction.output_image?.data) {
    found.push({
      data: Buffer.from(interaction.output_image.data, 'base64'),
      mime: interaction.output_image.mime_type ?? 'image/png',
    });
  }
  return found;
}

export const createGoogle: AdapterFactory = (_provider, apiKey) => {
  const ai = new GoogleGenAI({ apiKey });

  async function text(request: TextRequest): Promise<TextResult> {
    const contents: Content[] = request.messages.map((message) => ({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: message.content.map((part): Part =>
        part.type === 'text'
          ? { text: part.text }
          : { inlineData: { mimeType: part.mime, data: part.data.toString('base64') } },
      ),
    }));
    try {
      const stream = await ai.models.generateContentStream({
        model: request.model.id,
        contents,
        config: { systemInstruction: request.system, abortSignal: request.signal },
      });
      let output = '';
      let usage = { input: 0, output: 0 };
      let blocked = '';
      for await (const chunk of stream) {
        // `chunk.text` düşünce parçalarını da uyarıyla karıştırır; parçaları elle süzüyoruz.
        for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
          if (part.text && !part.thought) {
            output += part.text;
            request.onDelta?.(part.text);
          }
        }
        const reason = chunk.candidates?.[0]?.finishReason;
        if (reason && !['STOP', 'MAX_TOKENS', 'FINISH_REASON_UNSPECIFIED'].includes(reason)) blocked = reason;
        if (chunk.promptFeedback?.blockReason) blocked = String(chunk.promptFeedback.blockReason);
        if (chunk.usageMetadata) {
          usage = {
            input: chunk.usageMetadata.promptTokenCount ?? 0,
            output: (chunk.usageMetadata.candidatesTokenCount ?? 0) + (chunk.usageMetadata.thoughtsTokenCount ?? 0),
          };
        }
      }
      if (!output && blocked) {
        throw new ProviderError(`${NAME} bu isteği yanıtlamadı (${blocked}). İsteği farklı ifade etmeyi deneyin.`);
      }
      return { text: output, usage };
    } catch (error) {
      throw translate(error);
    }
  }

  async function oneImage(request: ImageRequest): Promise<Media[]> {
    const edge = request.size ? Math.max(request.size.width, request.size.height) : 0;
    const size = edge > 2048 || request.quality === 'max' ? '4K' : edge > 1024 || request.quality === 'high' ? '2K' : undefined;
    const interaction = await ai.interactions.create(
      {
        model: request.model.id,
        input: [...referenceParts(request.refs), { type: 'text', text: request.prompt }],
        response_format: {
          type: 'image',
          aspect_ratio: nearestAspect(request.aspect, IMAGE_ASPECTS),
          ...(size ? { image_size: size } : {}),
        },
        store: false,
        ...(request.model.options?.extra ?? {}),
      },
      { fetch_options: { signal: request.signal }, timeout_ms: 5 * 60000 },
    );
    const images = imagesOf(interaction as Interactions.Interaction);
    if (!images.length) {
      const said = (interaction as Interactions.Interaction).output_text?.trim();
      throw new ProviderError(
        said
          ? `${NAME} görsel yerine şunu yanıtladı: ${said.slice(0, 300)}`
          : `${NAME} görsel döndürmedi. İstem ya da referanslar içerik kurallarına takılmış olabilir.`,
      );
    }
    return images;
  }

  /** Bu uç nokta istek başına bir görsel üretir; adet kadar paralel çağrı yapılır. */
  async function image(request: ImageRequest): Promise<Media[]> {
    const runs = await Promise.allSettled(Array.from({ length: request.count }, () => oneImage(request)));
    const images = runs.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
    if (!images.length) throw translate((runs[0] as PromiseRejectedResult).reason);
    return images;
  }

  function videoParams(request: VideoRequest) {
    const input: InputPart[] = [];
    if (request.start) {
      input.push({ type: 'text', text: 'Use this image as the first frame of the video:' });
      input.push({ type: 'image', mime_type: request.start.mime, data: request.start.data.toString('base64') });
    }
    input.push(...referenceParts(request.refs));
    input.push({ type: 'text', text: request.prompt });
    const duration = Math.min(15, Math.max(3, Math.round(request.duration)));
    return {
      model: request.model.id,
      input,
      response_format: {
        type: 'video' as const,
        aspect_ratio: nearestAspect(request.aspect, ['16:9', '9:16']),
        duration: `${duration}s`,
        ...(request.resolution ? { resolution: request.resolution } : {}),
      },
      ...(request.model.options?.extra ?? {}),
    };
  }

  async function videoOf(interaction: Interactions.Interaction, signal?: AbortSignal): Promise<Media | null> {
    const video =
      interaction.output_video ??
      (interaction.steps ?? [])
        .flatMap((step) => (step.type === 'model_output' ? step.content ?? [] : []))
        .find((item): item is Interactions.VideoContent => item.type === 'video');
    if (!video) return null;
    if (video.data) return { data: Buffer.from(video.data, 'base64'), mime: video.mime_type ?? 'video/mp4' };
    if (video.uri) {
      const media = await download(video.uri, { 'x-goog-api-key': apiKey }, signal);
      return { data: media.data, mime: video.mime_type ?? 'video/mp4' };
    }
    return null;
  }

  async function videoStart(request: VideoRequest): Promise<VideoStart> {
    const params = videoParams(request);
    try {
      // Arka planda başlat: kimlik saklanır, sunucu yeniden başlasa bile iş sorgulanabilir.
      const started = (await ai.interactions.create(
        { ...params, background: true, store: true },
        { fetch_options: { signal: request.signal }, timeout_ms: 2 * 60000 },
      )) as Interactions.Interaction;
      if (started.status === 'completed') {
        const media = await videoOf(started, request.signal);
        if (media) return { media };
      }
      return { externalId: started.id };
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (isAbort(error) || !/background/i.test(message)) throw translate(error);
    }
    // Model arka plan kipini desteklemiyorsa tek seferde, bekleyerek üret.
    try {
      const done = (await ai.interactions.create(
        { ...params, store: false },
        { fetch_options: { signal: request.signal }, timeout_ms: 20 * 60000 },
      )) as Interactions.Interaction;
      const media = await videoOf(done, request.signal);
      if (!media) throw new ProviderError(`${NAME} video döndürmedi. İstem içerik kurallarına takılmış olabilir.`);
      return { media };
    } catch (error) {
      throw translate(error);
    }
  }

  async function videoPoll(externalId: string, _meta: Record<string, unknown>, _model: unknown, signal?: AbortSignal): Promise<VideoPoll> {
    try {
      const interaction = (await ai.interactions.get(externalId, undefined, {
        fetch_options: { signal },
        timeout_ms: 2 * 60000,
      })) as Interactions.Interaction;
      switch (interaction.status) {
        case 'completed': {
          const media = await videoOf(interaction, signal);
          if (!media) return { status: 'failed', error: `${NAME} video döndürmedi. İstem içerik kurallarına takılmış olabilir.` };
          return { status: 'succeeded', media };
        }
        case 'failed':
        case 'cancelled':
        case 'incomplete':
        case 'budget_exceeded': {
          const reason = interaction.errors?.map((e) => (e as { message?: string }).message).filter(Boolean).join(' ');
          return { status: 'failed', error: `${NAME} videoyu üretemedi${reason ? `: ${reason}` : ` (${interaction.status})`}.` };
        }
        case 'queued':
          return { status: 'running', stage: 'Sırada' };
        default:
          return { status: 'running', stage: 'Üretiliyor' };
      }
    } catch (error) {
      const translated = translate(error);
      if (translated instanceof ProviderError && translated.retryable) return { status: 'running', stage: 'Bağlantı bekleniyor' };
      throw translated;
    }
  }

  async function listModels(): Promise<FetchedModel[]> {
    try {
      const models: FetchedModel[] = [];
      const pager = await ai.models.list({ config: { pageSize: 200 } });
      for await (const model of pager) {
        const id = (model.name ?? '').replace(/^models\//, '');
        const kind = id ? classify(id) : null;
        if (kind) models.push({ id, label: model.displayName || id, kind });
      }
      return models;
    } catch (error) {
      throw translate(error);
    }
  }

  async function speech(request: SpeechRequest): Promise<Media> {
    try {
      const response = await ai.models.generateContent({
        model: 'gemini-3.8-flash-tts',
        contents: request.text.slice(0, 4000),
        config: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: request.voice || 'Kore' } } },
          abortSignal: request.signal,
        },
      });
      const part = response.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
      if (!part?.inlineData?.data) throw new ProviderError(`${NAME} ses döndürmedi.`);
      // Ham 16 bit PCM gelir; örnekleme hızı MIME türünde yazar.
      return { data: Buffer.from(part.inlineData.data, 'base64'), mime: part.inlineData.mimeType ?? 'audio/L16;rate=24000' };
    } catch (error) {
      throw translate(error);
    }
  }

  const adapter: Adapter = {
    text,
    image,
    speech,
    videoStart,
    videoPoll,
    listModels,
    async test() {
      const models = await listModels();
      return `Bağlantı tamam. ${models.length} model erişilebilir.`;
    },
  };
  return adapter;
};
