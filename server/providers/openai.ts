import OpenAI, { toFile } from 'openai';
import sharp from 'sharp';
import { aspectToNumber } from '../../shared/platforms.ts';
import type { ModelKind } from '../../shared/types.ts';
import {
  ProviderError, isAbort, statusMessage, withRefLegend,
  type Adapter, type AdapterFactory, type ChatMessage, type FetchedModel, type ImageRequest, type Media,
  type SpeechRequest, type TextRequest, type TextResult,
} from './types.ts';

/** Gri maskeyi (beyaz = değişecek) OpenAI'nin beklediği biçime çevirir: değişecek alan saydam. */
async function transparencyMask(mask: Buffer): Promise<Buffer> {
  const { data, info } = await sharp(mask).greyscale().negate().raw().toBuffer({ resolveWithObject: true });
  return sharp({ create: { width: info.width, height: info.height, channels: 3, background: '#000000' } })
    .joinChannel(data, { raw: { width: info.width, height: info.height, channels: 1 } })
    .png()
    .toBuffer();
}

/** Yalnızca üç sabit boyutu kabul eden eski görsel modelleri. */
const FIXED_SIZES = /^(gpt-image-1|gpt-image-1\.5|gpt-image-1-mini|chatgpt-image-latest|dall-e)/;

function imageSize(model: string, aspect: string, size?: { width: number; height: number }): string {
  const ratio = size ? size.width / size.height : aspectToNumber(aspect);
  if (FIXED_SIZES.test(model)) {
    if (ratio > 1.15) return '1536x1024';
    if (ratio < 0.87) return '1024x1536';
    return '1024x1024';
  }
  // Yeni modeller serbest çözünürlük alır: kenarlar 16'nın katı, oran 1:3–3:1 arası.
  const clamped = Math.min(3, Math.max(1 / 3, ratio));
  const round = (value: number) => Math.max(256, Math.round(value / 16) * 16);
  if (size) {
    // İstenen ölçüye olabildiğince yakın üret; 2560 pikselin üstü deneysel olduğu için orada dur.
    const long = Math.min(2560, Math.max(1024, Math.max(size.width, size.height)));
    return clamped >= 1 ? `${round(long)}x${round(long / clamped)}` : `${round(long * clamped)}x${round(long)}`;
  }
  const height = round(Math.sqrt((1024 * 1280) / clamped));
  return `${round(height * clamped)}x${height}`;
}

function classify(id: string): ModelKind | null {
  if (/embedding|whisper|tts|audio|realtime|transcribe|moderation|search|codex|computer|babbage|davinci|instruct/.test(id)) {
    return null;
  }
  if (/^(gpt-image|chatgpt-image|dall-e)/.test(id)) return 'image';
  if (/^(gpt-|o\d|chatgpt-)/.test(id)) return 'text';
  return null;
}

function dataUrl(part: { data: Buffer; mime: string }): string {
  return `data:${part.mime};base64,${part.data.toString('base64')}`;
}

export const createOpenAI: AdapterFactory = (provider, apiKey) => {
  const name = provider.name;
  const compatible = provider.kind === 'openai-compatible';
  const client = new OpenAI({
    // Yerel sunucular anahtar istemez ama SDK boş anahtarı kabul etmez.
    apiKey: apiKey || 'anahtar-yok',
    ...(provider.baseUrl ? { baseURL: provider.baseUrl } : {}),
  });

  function translate(error: unknown): Error {
    if (isAbort(error)) return error as Error;
    if (error instanceof ProviderError) return error;
    if (error instanceof OpenAI.APIConnectionError) {
      return new ProviderError(`${name} sunucusuna bağlanılamadı. Adresi ve bağlantınızı kontrol edin.`, true);
    }
    if (error instanceof OpenAI.APIError) return statusMessage(error.status, name, error.message);
    return error instanceof Error ? error : new Error(String(error));
  }

  /** OpenAI'nin kendi modelleri: Responses API. */
  async function responsesText(request: TextRequest): Promise<TextResult> {
    const input: OpenAI.Responses.ResponseInput = request.messages.map((message) => {
      if (message.role === 'assistant') {
        const joined = message.content.map((p) => (p.type === 'text' ? p.text : '')).join('');
        return { role: 'assistant' as const, content: joined };
      }
      return {
        role: 'user' as const,
        content: message.content.map((part): OpenAI.Responses.ResponseInputContent =>
          part.type === 'text'
            ? { type: 'input_text', text: part.text }
            : { type: 'input_image', detail: 'auto', image_url: dataUrl(part) },
        ),
      };
    });

    const stream = await client.responses.create(
      { model: request.model.id, instructions: request.system, input, stream: true, store: false },
      { signal: request.signal },
    );
    let output = '';
    let usage = { input: 0, output: 0 };
    for await (const event of stream) {
      if (event.type === 'response.output_text.delta') {
        output += event.delta;
        request.onDelta?.(event.delta);
      } else if (event.type === 'response.completed' || event.type === 'response.incomplete') {
        usage = {
          input: event.response.usage?.input_tokens ?? 0,
          output: event.response.usage?.output_tokens ?? 0,
        };
      } else if (event.type === 'response.failed') {
        throw new ProviderError(`${name}: ${event.response.error?.message ?? 'yanıt üretilemedi'}`);
      } else if (event.type === 'error') {
        throw new ProviderError(`${name}: ${event.message}`);
      }
    }
    return { text: output, usage };
  }

  /** OpenRouter, Ollama, Groq gibi uyumlu uç noktalar: Chat Completions. */
  async function chatText(request: TextRequest): Promise<TextResult> {
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: request.system },
      ...request.messages.map((message: ChatMessage): OpenAI.Chat.ChatCompletionMessageParam => {
        if (message.role === 'assistant') {
          return { role: 'assistant', content: message.content.map((p) => (p.type === 'text' ? p.text : '')).join('') };
        }
        const hasImage = message.content.some((p) => p.type === 'image' && request.model.vision !== false);
        if (!hasImage) {
          return { role: 'user', content: message.content.map((p) => (p.type === 'text' ? p.text : '')).join('\n') };
        }
        return {
          role: 'user',
          content: message.content.map((part): OpenAI.Chat.ChatCompletionContentPart =>
            part.type === 'text'
              ? { type: 'text', text: part.text }
              : { type: 'image_url', image_url: { url: dataUrl(part) } },
          ),
        };
      }),
    ];
    const stream = await client.chat.completions.create(
      {
        model: request.model.id,
        messages,
        stream: true,
        ...(provider.id === 'openrouter' ? { stream_options: { include_usage: true } } : {}),
      },
      { signal: request.signal },
    );
    let output = '';
    let usage = { input: 0, output: 0 };
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) {
        output += delta;
        request.onDelta?.(delta);
      }
      if (chunk.usage) usage = { input: chunk.usage.prompt_tokens ?? 0, output: chunk.usage.completion_tokens ?? 0 };
    }
    return { text: output, usage };
  }

  async function image(request: ImageRequest): Promise<Media[]> {
    const model = request.model.id;
    const size = imageSize(model, request.aspect, request.size);
    const quality: 'high' | 'low' | undefined =
      request.quality === 'high' ? 'high' : request.quality === 'low' ? 'low' : undefined;
    const common = { model, n: request.count, size, ...(quality ? { quality } : {}) };
    try {
      const response = request.refs.length
        ? await client.images.edit(
            {
              ...common,
              prompt: withRefLegend(request.prompt, request.refs),
              image: await Promise.all(
                request.refs.map((ref, index) =>
                  toFile(ref.data, `referans-${index + 1}.${ref.mime === 'image/png' ? 'png' : 'jpg'}`, { type: ref.mime }),
                ),
              ),
              // Yüz ve logo sadakati yalnızca 1.5 ailesinde ayarlanabilir; yenilerinde gönderilmez.
              ...(/^gpt-image-1\.5/.test(model) ? { input_fidelity: 'high' as const } : {}),
              ...(request.mask ? { mask: await toFile(await transparencyMask(request.mask), 'maske.png', { type: 'image/png' }) } : {}),
            },
            { signal: request.signal },
          )
        : await client.images.generate({ ...common, prompt: request.prompt }, { signal: request.signal });

      const images = (response.data ?? [])
        .filter((item) => item.b64_json)
        .map((item) => ({ data: Buffer.from(item.b64_json!, 'base64'), mime: `image/${response.output_format ?? 'png'}` }));
      if (!images.length) throw new ProviderError(`${name} görsel döndürmedi. İstem içerik kurallarına takılmış olabilir.`);
      return images;
    } catch (error) {
      throw translate(error);
    }
  }

  async function listModels(): Promise<FetchedModel[]> {
    try {
      const models: FetchedModel[] = [];
      for await (const model of client.models.list()) {
        const kind = compatible ? 'text' : classify(model.id);
        if (kind) models.push({ id: model.id, label: model.id, kind });
      }
      return models.sort((a, b) => a.id.localeCompare(b.id));
    } catch (error) {
      throw translate(error);
    }
  }

  async function speech(request: SpeechRequest): Promise<Media> {
    try {
      const response = await client.audio.speech.create(
        { model: 'gpt-4o-mini-tts', voice: request.voice || 'marin', input: request.text.slice(0, 4000), response_format: 'mp3' },
        { signal: request.signal },
      );
      return { data: Buffer.from(await response.arrayBuffer()), mime: 'audio/mpeg' };
    } catch (error) {
      throw translate(error);
    }
  }

  const adapter: Adapter = {
    async text(request) {
      try {
        return compatible ? await chatText(request) : await responsesText(request);
      } catch (error) {
        throw translate(error);
      }
    },
    ...(compatible ? {} : { image, speech }),
    listModels,
    async test() {
      // OpenRouter'ın model listesi herkese açıktır; anahtarı ayrıca doğrulamak gerekir.
      if (provider.id === 'openrouter') {
        const response = await fetch(`${provider.baseUrl}/key`, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(15000),
        }).catch(() => null);
        if (!response) throw new ProviderError(`${name} sunucusuna bağlanılamadı. Bağlantınızı kontrol edin.`, true);
        if (!response.ok) throw statusMessage(response.status === 403 ? 401 : response.status, name, '');
      }
      const models = await listModels();
      // Uyumlu sunucularda liste alınabilmesi anahtarın geçerli olduğunu kanıtlamaz; olduğu kadarını söyle.
      return compatible && provider.id !== 'openrouter'
        ? `Sunucuya ulaşıldı. ${models.length} model listelendi.`
        : `Bağlantı tamam. ${models.length} model erişilebilir.`;
    },
  };
  return adapter;
};
