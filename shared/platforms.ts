import type { EntityType, MemoryCategory, PlatformId, PostStatus } from './types.ts';

export interface PlatformFormat {
  id: string;
  label: string;
  aspect: string;
  width: number;
  height: number;
}

export interface Platform {
  id: PlatformId;
  label: string;
  /** Rozetlerde kullanılan kısa ad. */
  short: string;
  captionLimit: number;
  hashtagLimit: number;
  formats: PlatformFormat[];
}

export const PLATFORMS: Platform[] = [
  {
    id: 'instagram', label: 'Instagram', short: 'IG', captionLimit: 2200, hashtagLimit: 30,
    formats: [
      { id: 'portrait', label: 'Gönderi 4:5', aspect: '4:5', width: 1080, height: 1350 },
      { id: 'square', label: 'Kare 1:1', aspect: '1:1', width: 1080, height: 1080 },
      { id: 'story', label: 'Hikâye / Reels 9:16', aspect: '9:16', width: 1080, height: 1920 },
    ],
  },
  {
    id: 'tiktok', label: 'TikTok', short: 'TT', captionLimit: 2200, hashtagLimit: 30,
    formats: [{ id: 'vertical', label: 'Dikey 9:16', aspect: '9:16', width: 1080, height: 1920 }],
  },
  {
    id: 'x', label: 'X', short: 'X', captionLimit: 280, hashtagLimit: 3,
    formats: [
      { id: 'landscape', label: 'Yatay 16:9', aspect: '16:9', width: 1600, height: 900 },
      { id: 'square', label: 'Kare 1:1', aspect: '1:1', width: 1080, height: 1080 },
    ],
  },
  {
    id: 'linkedin', label: 'LinkedIn', short: 'in', captionLimit: 3000, hashtagLimit: 5,
    formats: [
      { id: 'landscape', label: 'Yatay 1.91:1', aspect: '16:9', width: 1200, height: 628 },
      { id: 'square', label: 'Kare 1:1', aspect: '1:1', width: 1080, height: 1080 },
      { id: 'portrait', label: 'Dikey 4:5', aspect: '4:5', width: 1080, height: 1350 },
    ],
  },
  {
    id: 'facebook', label: 'Facebook', short: 'fb', captionLimit: 5000, hashtagLimit: 5,
    formats: [
      { id: 'landscape', label: 'Yatay 1.91:1', aspect: '16:9', width: 1200, height: 630 },
      { id: 'square', label: 'Kare 1:1', aspect: '1:1', width: 1080, height: 1080 },
    ],
  },
  {
    id: 'youtube', label: 'YouTube', short: 'YT', captionLimit: 5000, hashtagLimit: 15,
    formats: [
      { id: 'thumbnail', label: 'Kapak 16:9', aspect: '16:9', width: 1280, height: 720 },
      { id: 'shorts', label: 'Shorts 9:16', aspect: '9:16', width: 1080, height: 1920 },
    ],
  },
];

export function getPlatform(id: string): Platform {
  return PLATFORMS.find((p) => p.id === id) ?? PLATFORMS[0];
}

export function getFormat(platformId: string, formatId: string): PlatformFormat {
  const platform = getPlatform(platformId);
  return platform.formats.find((f) => f.id === formatId) ?? platform.formats[0];
}

export const ASPECTS: { id: string; label: string }[] = [
  { id: '1:1', label: 'Kare' },
  { id: '4:5', label: 'Dikey gönderi' },
  { id: '3:4', label: 'Dikey' },
  { id: '2:3', label: 'Portre' },
  { id: '9:16', label: 'Hikâye' },
  { id: '16:9', label: 'Geniş' },
  { id: '3:2', label: 'Yatay' },
  { id: '4:3', label: 'Klasik' },
  { id: '21:9', label: 'Sinema' },
];

export interface SizePreset {
  id: string;
  label: string;
  group: 'Sosyal medya' | 'Video' | 'Web ve baskı';
  width: number;
  height: number;
}

/** Hazır piksel boyutları. Üretim en yakın oranda yapılır, çıktı tam bu ölçüye getirilir. */
export const SIZE_PRESETS: SizePreset[] = [
  { id: 'ig-post', group: 'Sosyal medya', label: 'Instagram gönderi', width: 1080, height: 1350 },
  { id: 'ig-square', group: 'Sosyal medya', label: 'Instagram kare', width: 1080, height: 1080 },
  { id: 'story', group: 'Sosyal medya', label: 'Hikâye · Reels · TikTok', width: 1080, height: 1920 },
  { id: 'x-post', group: 'Sosyal medya', label: 'X gönderi', width: 1600, height: 900 },
  { id: 'linkedin', group: 'Sosyal medya', label: 'LinkedIn gönderi', width: 1200, height: 628 },
  { id: 'facebook', group: 'Sosyal medya', label: 'Facebook gönderi', width: 1200, height: 630 },
  { id: 'pinterest', group: 'Sosyal medya', label: 'Pinterest pin', width: 1000, height: 1500 },
  { id: 'yt-thumb', group: 'Video', label: 'YouTube kapak', width: 1280, height: 720 },
  { id: 'fhd', group: 'Video', label: 'Full HD yatay', width: 1920, height: 1080 },
  { id: 'fhd-v', group: 'Video', label: 'Full HD dikey', width: 1080, height: 1920 },
  { id: '4k', group: 'Video', label: '4K yatay', width: 3840, height: 2160 },
  { id: 'yt-banner', group: 'Web ve baskı', label: 'YouTube kanal kapağı', width: 2560, height: 1440 },
  { id: 'web-hero', group: 'Web ve baskı', label: 'Web afişi', width: 1920, height: 800 },
  { id: 'og', group: 'Web ve baskı', label: 'Bağlantı önizlemesi', width: 1200, height: 630 },
  { id: 'a4', group: 'Web ve baskı', label: 'A4 dikey (300 dpi)', width: 2480, height: 3508 },
  { id: 'poster', group: 'Web ve baskı', label: 'Afiş 50×70 (150 dpi)', width: 2953, height: 4134 },
];

export const MIN_EDGE = 64;
export const MAX_EDGE = 8192;

export function clampEdge(value: unknown): number {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(MAX_EDGE, Math.max(MIN_EDGE, n)) : 0;
}

/** Piksel boyutuna en yakın, modellerin anladığı oran. */
export function ratioOf(width: number, height: number, options: string[] = ASPECTS.map((a) => a.id)): string {
  return nearestAspect(`${width}:${height}`, options);
}

export function aspectToNumber(aspect: string): number {
  const [w, h] = aspect.split(':').map(Number);
  return w > 0 && h > 0 ? w / h : 1;
}

/** İstenen orana, verilen seçenekler içinden en yakın olanı bulur. */
export function nearestAspect(aspect: string, options: string[]): string {
  if (options.includes(aspect)) return aspect;
  const target = Math.log(aspectToNumber(aspect));
  let best = options[0];
  let bestDistance = Infinity;
  for (const option of options) {
    if (!/^\d+(\.\d+)?:\d+(\.\d+)?$/.test(option)) continue;
    const distance = Math.abs(Math.log(aspectToNumber(option)) - target);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = option;
    }
  }
  return best;
}

export const ENTITY_TYPES: { id: EntityType; label: string; plural: string; hint: string }[] = [
  { id: 'person', label: 'Kişi', plural: 'Kişiler', hint: 'Yüzü ve görünümü tutarlı kalması gereken insanlar' },
  { id: 'brand', label: 'Marka', plural: 'Markalar', hint: 'Logo, renk, yazı tipi ve ses tonuyla kurumsal kimlik' },
  { id: 'product', label: 'Ürün', plural: 'Ürünler', hint: 'Görsellerde aynen görünmesi gereken ürünler' },
  { id: 'style', label: 'Stil', plural: 'Stiller', hint: 'Tekrar kullanmak istediğiniz görsel dil ve atmosfer' },
  { id: 'place', label: 'Mekân', plural: 'Mekânlar', hint: 'Ofis, mağaza, sahne gibi tekrar eden yerler' },
];

export function entityTypeLabel(type: string): string {
  return ENTITY_TYPES.find((t) => t.id === type)?.label ?? 'Varlık';
}

export const MEMORY_CATEGORIES: { id: MemoryCategory; label: string }[] = [
  { id: 'preference', label: 'Tercih' },
  { id: 'rule', label: 'Kural' },
  { id: 'style', label: 'Üslup' },
  { id: 'fact', label: 'Bilgi' },
];

export const POST_STATUSES: { id: PostStatus; label: string }[] = [
  { id: 'idea', label: 'Fikir' },
  { id: 'draft', label: 'Taslak' },
  { id: 'scheduled', label: 'Planlandı' },
  { id: 'published', label: 'Yayınlandı' },
];
