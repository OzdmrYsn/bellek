import type { ModelConfig, ModelPrice, ProviderKind } from '../../shared/types.ts';
import { MOCK } from '../config.ts';

export interface CatalogProvider {
  id: string;
  kind: ProviderKind;
  name: string;
  description: string;
  baseUrl: string;
  keyUrl: string;
  needsKey: boolean;
  models: ModelConfig[];
}

interface Extra {
  note?: string;
  /** Varsayılan olarak kapalı gelen (eski ya da niş) modeller; Ayarlar'dan açılır. */
  off?: boolean;
  price?: ModelPrice;
  options?: ModelConfig['options'];
}

const text = (id: string, label: string, extra: Extra = {}): ModelConfig => ({
  id, label, kind: 'text', vision: true, note: extra.note ?? '', enabled: !extra.off, price: extra.price,
});

const image = (id: string, label: string, maxRefs: number, extra: Extra = {}): ModelConfig => ({
  id, label, kind: 'image', maxRefs, note: extra.note ?? '', enabled: !extra.off, options: extra.options, price: extra.price,
});

const video = (id: string, label: string, maxRefs: number, durations: number[], aspects: string[], extra: Extra = {}): ModelConfig => ({
  id, label, kind: 'video', maxRefs, durations, aspects, note: extra.note ?? '', enabled: !extra.off, options: extra.options, price: extra.price,
});

/** fal'da metinden üretim ve referanslı düzenleme ayrı uç noktalardır. */
const falImage = (label: string, id: string, editEndpoint: string | null, maxRefs: number, extra: Extra = {}): ModelConfig =>
  image(id, label, editEndpoint ? maxRefs : 0, { ...extra, options: editEndpoint ? { editEndpoint } : undefined });

const falVideo = (
  label: string, id: string, imageEndpoint: string | null, refEndpoint: string | null, maxRefs: number,
  durations: number[], aspects: string[], extra: Extra = {},
): ModelConfig =>
  video(id, label, refEndpoint ? maxRefs : imageEndpoint ? 1 : 0, durations, aspects, {
    ...extra,
    options: { ...(imageEndpoint ? { imageEndpoint } : {}), ...(refEndpoint ? { refEndpoint } : {}) },
  });

const WIDE = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'];

const compatible = (id: string, name: string, baseUrl: string, keyUrl: string, description: string, needsKey = true): CatalogProvider => ({
  id, kind: 'openai-compatible', name, description, baseUrl, keyUrl, needsKey, models: [],
});

/**
 * Hazır gelen sağlayıcılar ve Kasım 2026 itibarıyla doğrulanmış model kimlikleri.
 * Liste bir başlangıç noktasıdır: Ayarlar'dan "Modelleri getir" ile sağlayıcının
 * kendi kataloğu çekilir, istenen model elle de eklenebilir. Fiyatlar yalnızca
 * yayımlanmış liste fiyatı bilinen modellerde doludur; diğerlerini kullanıcı girer.
 */
export const CATALOG: CatalogProvider[] = [
  {
    id: 'anthropic',
    kind: 'anthropic',
    name: 'Anthropic · Claude',
    description: 'Metin yazarlığı, strateji, istem geliştirme ve görsel anlama.',
    baseUrl: '',
    keyUrl: 'https://platform.claude.com/settings/keys',
    needsKey: true,
    models: [
      text('claude-opus-5-5', 'Claude Opus 5.5', { note: 'Önerilen', price: { input: 4, output: 20 } }),
      text('claude-fable-5-2', 'Claude Fable 5.2', { note: 'En yetenekli', price: { input: 8, output: 40 } }),
      text('claude-sonnet-5-5', 'Claude Sonnet 5.5', { note: 'Hız ve kalite dengesi', price: { input: 2, output: 10 } }),
      text('claude-haiku-5-5', 'Claude Haiku 5.5', { note: 'En hızlı, en ekonomik', price: { input: 0.1, output: 0.5 } }),
      text('claude-opus-5', 'Claude Opus 5', { off: true, price: { input: 5, output: 25 } }),
      text('claude-sonnet-5', 'Claude Sonnet 5', { off: true, price: { input: 2, output: 10 } }),
      text('claude-opus-4-8', 'Claude Opus 4.8', { off: true, price: { input: 5, output: 25 } }),
      text('claude-haiku-4-5', 'Claude Haiku 4.5', { off: true, price: { input: 1, output: 5 } }),
    ],
  },
  {
    id: 'openai',
    kind: 'openai',
    name: 'OpenAI',
    description: 'GPT metin modelleri, GPT Image görsel üretimi ve seslendirme.',
    baseUrl: '',
    keyUrl: 'https://platform.openai.com/api-keys',
    needsKey: true,
    models: [
      text('gpt-6.1-sol', 'GPT-6.1 Sol', { note: 'Dengeli', price: { input: 2, output: 10 } }),
      text('gpt-6-astra', 'GPT-6 Astra', { note: 'En yetenekli', price: { input: 10, output: 50 } }),
      text('gpt-6.1-terra', 'GPT-6.1 Terra', { note: 'Hızlı', price: { input: 1, output: 5 } }),
      text('gpt-6-luna', 'GPT-6 Luna', { note: 'Ekonomik', price: { input: 0.1, output: 0.5 } }),
      text('gpt-5.5', 'GPT-5.5', { off: true }),
      image('gpt-image-2.6-sunburst', 'GPT Image 2.6 Sunburst', 16, { note: 'Ayrıntılı işler' }),
      image('gpt-image-2.6-flare', 'GPT Image 2.6 Flare', 16, { note: 'Hızlı deneme' }),
      image('gpt-image-2.5-sunburst', 'GPT Image 2.5 Sunburst', 16, { off: true }),
      image('gpt-image-2.5-flare', 'GPT Image 2.5 Flare', 16, { off: true }),
      image('gpt-image-2', 'GPT Image 2', 16, { off: true }),
    ],
  },
  {
    id: 'google',
    kind: 'google',
    name: 'Google · Gemini',
    description: 'Gemini metin, Nano Banana görsel, Omni video ve seslendirme.',
    baseUrl: '',
    keyUrl: 'https://aistudio.google.com/apikey',
    needsKey: true,
    models: [
      text('gemini-4-hydrogen', 'Gemini 4 Hydrogen', { note: 'Önerilen' }),
      text('gemini-4-carbon', 'Gemini 4 Carbon', { note: 'En yetenekli' }),
      text('gemini-4-argon', 'Gemini 4 Argon', { note: 'Carbon’a yakın, daha hızlı' }),
      text('gemini-3.8-flash', 'Gemini 3.8 Flash', { note: 'Hızlı' }),
      text('gemini-3.5-flash-lite', 'Gemini 3.5 Flash-Lite', { note: 'Ekonomik' }),
      text('gemini-3.6-flash', 'Gemini 3.6 Flash', { off: true }),
      image('gemini-nano-banana-2.1', 'Nano Banana 2.1', 14, { note: 'Kişi tutarlılığında güçlü' }),
      image('gemini-3-pro-image', 'Nano Banana Pro', 14, { note: '4K stüdyo kalitesi' }),
      image('gemini-3.1-flash-image', 'Nano Banana 2', 14, { note: 'Önceki kuşak' }),
      image('gemini-3.1-flash-lite-image', 'Nano Banana 2 Lite', 2, { note: 'En hızlı, en ucuz' }),
      video('gemini-omni-1.2-flash', 'Gemini Omni Flash 1.2', 6, [4, 6, 8, 10, 12, 15], ['16:9', '9:16'], { note: 'Sesli video, 6 referansa kadar' }),
    ],
  },
  {
    id: 'fal',
    kind: 'fal',
    name: 'fal.ai',
    description: 'Yüzlerce görsel ve video modeli tek anahtarla; arka plan silme ve çözünürlük yükseltme de buradan çalışır.',
    baseUrl: '',
    keyUrl: 'https://fal.ai/dashboard/keys',
    needsKey: true,
    models: [
      // ── Görsel ──
      falImage('Nano Banana 2.1', 'google/nano-banana-2.1', 'google/nano-banana-2.1/edit', 14),
      falImage('Nano Banana Pro', 'fal-ai/nano-banana-pro', 'fal-ai/nano-banana-pro/edit', 14),
      falImage('GPT Image 2.6 Sunburst', 'openai/gpt-image-2.6/sunburst/text-to-image', 'openai/gpt-image-2.6/sunburst/edit', 16),
      falImage('GPT Image 2.6 Flare', 'openai/gpt-image-2.6/flare/text-to-image', 'openai/gpt-image-2.6/flare/edit', 16, { note: 'Hızlı' }),
      falImage('Seedream 5.5', 'bytedance/seedream/v5.5/text-to-image', 'bytedance/seedream/v5.5/edit', 10),
      falImage('Seedream 5 Pro', 'bytedance/seedream/v5/pro/text-to-image', 'bytedance/seedream/v5/pro/edit', 10),
      falImage('FLUX 3', 'blackforestlabs/flux-3/text-to-image', 'blackforestlabs/flux-3/edit-image', 8),
      falImage('FLUX 3 Klein', 'blackforestlabs/flux-3/klein/text-to-image', 'blackforestlabs/flux-3/klein/edit-image', 10, { note: 'Hızlı' }),
      falImage('Grok Imagine Image 2', 'xai/grok-imagine-image/v2.0/text-to-image', 'xai/grok-imagine-image/v2.0/edit', 4),
      falImage('Meta Muse Image', 'meta/muse-image/text-to-image', 'meta/muse-image/edit', 10),
      falImage('MiniMax H3 Image', 'minimax/h3-image/text-to-image', 'minimax/h3-image/edit', 16),
      falImage('Krea 3', 'krea/v3/text-to-image', 'krea/v3/edit', 8),
      falImage('Ideogram 4.5', 'ideogram/v4.5', null, 0, { note: 'Görsel içi yazıda güçlü; referans almaz' }),
      falImage('Recraft V3', 'fal-ai/recraft/v3/text-to-image', null, 0, { note: 'İllüstrasyon ve vektör havası; referans almaz' }),
      falImage('Z Image Turbo', 'fal-ai/z-image/turbo', null, 0, { note: 'Çok hızlı taslak; referans almaz' }),
      falImage('Nano Banana 2', 'fal-ai/nano-banana-2', 'fal-ai/nano-banana-2/edit', 14, { off: true }),
      falImage('GPT Image 2', 'openai/gpt-image-2', 'openai/gpt-image-2/edit', 16, { off: true }),
      falImage('FLUX 2 Pro', 'fal-ai/flux-2-pro', 'fal-ai/flux-2-pro/edit', 8, { off: true }),
      // ── Video ──
      falVideo('Kling 4.0', 'kling/v4/text-to-video', 'kling/v4/image-to-video', 'kling/v4/reference-to-video', 4, [5, 8, 10, 15], ['16:9', '9:16', '1:1', '21:9'], { note: 'Sinematik hareket' }),
      falVideo('Kling 4.0 Flash', 'kling/v4/flash/text-to-video', 'kling/v4/flash/image-to-video', 'kling/v4/flash/reference-to-video', 4, [5, 8, 10, 15], ['16:9', '9:16', '1:1', '21:9'], { note: 'Hızlı' }),
      falVideo('Kling O3 Pro', 'fal-ai/kling-video/o3/pro/text-to-video', 'fal-ai/kling-video/o3/pro/image-to-video', 'fal-ai/kling-video/o3/pro/reference-to-video', 4, [5, 8, 10, 15], ['16:9', '9:16', '1:1']),
      falVideo('Seedance 2.5', 'bytedance/seedance-2.5/us/text-to-video', 'bytedance/seedance-2.5/us/image-to-video', 'bytedance/seedance-2.5/us/reference-to-video', 9, [5, 8, 10, 15], WIDE, { note: 'Referanslı video' }),
      falVideo('Seedance 2.0 Fast', 'bytedance/seedance-2.0/fast/text-to-video', 'bytedance/seedance-2.0/fast/image-to-video', 'bytedance/seedance-2.0/fast/reference-to-video', 9, [5, 8, 10, 15], WIDE, { note: 'Hızlı' }),
      falVideo('Gemini Omni Flash 1.2', 'google/gemini-omni-flash/v1.2/text-to-video', 'google/gemini-omni-flash/v1.2/image-to-video', 'google/gemini-omni-flash/v1.2/reference-to-video', 6, [4, 6, 8, 10, 12, 15], ['16:9', '9:16']),
      falVideo('MiniMax H3 Max', 'minimax/h3-max/text-to-video', 'minimax/h3-max/image-to-video', 'minimax/h3-max/reference-to-video', 4, [5, 10], ['16:9', '9:16', '1:1']),
      falVideo('MiniMax H3', 'minimax/h3/text-to-video', 'minimax/h3/image-to-video', 'minimax/h3/reference-to-video', 9, [5, 8, 10, 15], WIDE),
      falVideo('Wan 3.0', 'alibaba/wan-3.0/text-to-video', 'alibaba/wan-3.0/image-to-video', 'alibaba/wan-3.0/reference-to-video', 10, [5, 10], ['16:9', '9:16', '1:1', '4:3', '3:4']),
      falVideo('Grok Imagine Video 1.5', 'xai/grok-imagine-video/v1.5/text-to-video', 'xai/grok-imagine-video/v1.5/image-to-video', 'xai/grok-imagine-video/v1.5/reference-to-video', 7, [5, 6, 8, 10, 15], ['16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3']),
      falVideo('FLUX 3 Max Video', 'blackforestlabs/flux-3-max/text-to-video', 'blackforestlabs/flux-3-max/image-to-video', null, 1, [5, 8, 10, 15], WIDE, { note: 'İlk kareden video' }),
      falVideo('Kling 3 Pro', 'fal-ai/kling-video/v3/pro/text-to-video', 'fal-ai/kling-video/v3/pro/image-to-video', null, 1, [5, 8, 10, 15], ['16:9', '9:16', '1:1'], { off: true }),
      falVideo('LTX 2.5 Pro', 'lightricks/ltx-2.5/text-to-video/pro', 'lightricks/ltx-2.5/image-to-video/pro', null, 1, [6, 8, 10], ['16:9', '9:16'], { off: true }),
      falVideo('PixVerse 6', 'fal-ai/pixverse/v6/text-to-video', 'fal-ai/pixverse/v6/image-to-video', null, 1, [5, 8, 10], WIDE, { off: true }),
    ],
  },
  compatible('openrouter', 'OpenRouter', 'https://openrouter.ai/api/v1', 'https://openrouter.ai/keys', 'Tek anahtarla farklı şirketlerin yüzlerce metin modeli.'),
  compatible('xai', 'xAI · Grok', 'https://api.x.ai/v1', 'https://console.x.ai', 'Grok metin modelleri.'),
  compatible('deepseek', 'DeepSeek', 'https://api.deepseek.com/v1', 'https://platform.deepseek.com/api_keys', 'Ekonomik metin ve akıl yürütme modelleri.'),
  compatible('mistral', 'Mistral', 'https://api.mistral.ai/v1', 'https://console.mistral.ai/api-keys', 'Avrupa merkezli metin modelleri.'),
  compatible('groq', 'Groq', 'https://api.groq.com/openai/v1', 'https://console.groq.com/keys', 'Açık modelleri çok hızlı çalıştırır.'),
  compatible('ollama', 'Ollama (yerel)', 'http://localhost:11434/v1', '', 'Bilgisayarınızda çalışan modeller; anahtar ve internet gerektirmez.', false),
  ...(MOCK
    ? [
        {
          id: 'mock',
          kind: 'mock' as const,
          name: 'Deneme sağlayıcısı',
          description: 'Anahtarsız sahte çıktılar üretir; yalnızca geliştirme ve deneme içindir.',
          baseUrl: '',
          keyUrl: '',
          needsKey: false,
          models: [
            text('mock-text', 'Deneme metin', { price: { input: 1, output: 5 } }),
            image('mock-image', 'Deneme görsel', 8, { price: { unit: 0.04 } }),
            image('mock-image-b', 'Deneme görsel B', 8),
            video('mock-video', 'Deneme video', 4, [4, 8], ['16:9', '9:16'], { price: { unit: 0.1 } }),
          ],
        },
      ]
    : []),
];
