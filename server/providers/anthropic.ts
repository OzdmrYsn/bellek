import Anthropic from '@anthropic-ai/sdk';
import {
  ProviderError, isAbort, statusMessage,
  type Adapter, type AdapterFactory, type ChatMessage, type FetchedModel, type TextRequest, type TextResult,
} from './types.ts';

const NAME = 'Claude';

/**
 * Güvenlik sınıflandırıcısı bir isteği geri çevirdiğinde sunucu tarafında başka
 * bir modele devreden aileler. Haiku 5.5'te sunucu tarafı yedek yoktur.
 */
const SERVER_FALLBACK = /^claude-(fable-5|mythos-5|opus-5|sonnet-5-5)/;

/** `effort` parametresini kabul etmeyen eski modeller. */
const NO_EFFORT = /^claude-(sonnet-4-5|haiku-4-5|opus-4-1|opus-4-0|sonnet-4-0|3-|.*-3-)/;

type ImageMedia = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
const IMAGE_MEDIA: ImageMedia[] = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

function toMessages(messages: ChatMessage[]): Anthropic.Beta.BetaMessageParam[] {
  return messages.map((message) => ({
    role: message.role,
    content: message.content.map((part): Anthropic.Beta.BetaContentBlockParam => {
      if (part.type === 'text') return { type: 'text', text: part.text };
      const media = IMAGE_MEDIA.includes(part.mime as ImageMedia) ? (part.mime as ImageMedia) : 'image/jpeg';
      return { type: 'image', source: { type: 'base64', media_type: media, data: part.data.toString('base64') } };
    }),
  }));
}

function translate(error: unknown): Error {
  if (isAbort(error)) return error as Error;
  if (error instanceof ProviderError) return error;
  if (error instanceof Anthropic.AuthenticationError) return statusMessage(401, NAME, '');
  if (error instanceof Anthropic.PermissionDeniedError) return statusMessage(403, NAME, error.message);
  if (error instanceof Anthropic.NotFoundError) return statusMessage(404, NAME, error.message);
  if (error instanceof Anthropic.RateLimitError) return statusMessage(429, NAME, '');
  if (error instanceof Anthropic.BadRequestError) return statusMessage(400, NAME, error.message);
  if (error instanceof Anthropic.APIConnectionError) {
    return new ProviderError(`${NAME} sunucusuna bağlanılamadı. İnternet bağlantınızı kontrol edin.`, true);
  }
  if (error instanceof Anthropic.APIError) return statusMessage(error.status, NAME, error.message);
  return error instanceof Error ? error : new Error(String(error));
}

export const createAnthropic: AdapterFactory = (provider, apiKey) => {
  const client = new Anthropic({ apiKey, ...(provider.baseUrl ? { baseURL: provider.baseUrl } : {}) });

  async function text(request: TextRequest): Promise<TextResult> {
    const model = request.model.id;
    const fallbacks = SERVER_FALLBACK.test(model);
    try {
      // Düşünme parametresi bilerek gönderilmez: güncel modellerde uyarlanabilir
      // düşünme varsayılandır ve derinliği `effort` belirler. Örnekleme
      // parametreleri (temperature vb.) güncel modellerde reddedilir.
      const stream = client.beta.messages.stream(
        {
          model,
          max_tokens: 64000,
          system: request.system,
          messages: toMessages(request.messages),
          cache_control: { type: 'ephemeral' },
          ...(NO_EFFORT.test(model) ? {} : { output_config: { effort: request.effort ?? 'medium' } }),
          ...(fallbacks ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
        },
        { signal: request.signal },
      );
      if (request.onDelta) stream.on('text', (delta) => request.onDelta!(delta));
      const final = await stream.finalMessage();

      const output = final.content
        .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('');

      if (final.stop_reason === 'refusal') {
        const category = final.stop_details?.category;
        throw new ProviderError(
          `${NAME} bu isteği güvenlik gerekçesiyle yanıtlamadı${category ? ` (${category})` : ''}. ` +
            'İsteği farklı ifade etmeyi ya da başka bir model seçmeyi deneyin.',
        );
      }

      const usage = final.usage;
      return {
        text: output,
        usage: {
          input:
            (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
          output: usage.output_tokens ?? 0,
        },
      };
    } catch (error) {
      throw translate(error);
    }
  }

  async function listModels(): Promise<FetchedModel[]> {
    try {
      const models: FetchedModel[] = [];
      for await (const model of client.models.list({ limit: 100 })) {
        if (model.lifecycle === 'retired') continue;
        models.push({ id: model.id, label: model.display_name || model.id, kind: 'text' });
      }
      return models;
    } catch (error) {
      throw translate(error);
    }
  }

  const adapter: Adapter = {
    text,
    listModels,
    async test() {
      const models = await listModels();
      return `Bağlantı tamam. ${models.length} model erişilebilir.`;
    },
  };
  return adapter;
};
