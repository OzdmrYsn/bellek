import { getFormat } from '../../shared/platforms.ts';
import type { Asset, BrandColor, Design, DesignDoc, Entity, EntityDetail, Layer, Post } from '../../shared/types.ts';
import { api } from '../lib/api.ts';
import { keys, queryClient } from '../lib/queries.ts';
import { imageLayer } from '../library/actions.ts';
import { ensureFont, exportDesign, type ImageStore } from './render.ts';
import { TEMPLATES, logoLayer, readableOn, shapeLayer, textLayer } from './templates.ts';

// Editörü açmadan tasarım üretir: kampanya gönderilerine düzen uygular ve
// kaydırmalı gönderinin karelerini görsele çevirir. Çizim, editörle aynı
// tuval işlevinden geçtiği için sonuç editörde açıldığında birebir aynıdır.

const store: ImageStore = new Map();

function brandColor(brand: Entity | null, role: BrandColor['role'], fallback: string): string {
  return brand?.data.colors?.find((c) => c.role === role)?.hex ?? fallback;
}

function brandFonts(brand: Entity | null): { heading: string; body: string } {
  return {
    heading: brand?.data.fonts?.heading?.trim() || 'Instrument Sans Variable',
    body: brand?.data.fonts?.body?.trim() || 'Instrument Sans Variable',
  };
}

/** Yazı tipleri ölçümden önce yüklenmeli; yoksa satır kırılımları yanlış hesaplanır. */
async function loadFonts(brand: Entity | null): Promise<void> {
  const fonts = brandFonts(brand);
  await Promise.all([ensureFont(fonts.heading, 800), ensureFont(fonts.heading, 700), ensureFont(fonts.body, 500)]);
}

async function logoOf(brand: Entity | null): Promise<string | null> {
  if (!brand) return null;
  try {
    const detail = await queryClient.fetchQuery({
      queryKey: keys.entity(brand.id),
      queryFn: () => api.get<EntityDetail>(`/api/entities/${brand.id}`),
      staleTime: 30_000,
    });
    return detail.assets.find((asset) => asset.role === 'logo')?.id ?? null;
  } catch {
    return null;
  }
}

async function saveImage(doc: DesignDoc, width: number, height: number, title: string): Promise<Asset> {
  const blob = await exportDesign(doc, width, height, store);
  const name = `${title.replace(/[^\p{L}\p{N}_-]+/gu, '-').slice(0, 60) || 'tasarim'}.png`;
  const result = await api.upload([new File([blob], name, { type: 'image/png' })], { source: 'design', title });
  const asset = result.assets[0];
  if (!asset) throw new Error(result.errors[0]?.error ?? 'Tasarım kaydedilemedi.');
  return asset;
}

/** Düzen uygulanmaya uygun fotoğraf: gönderideki, tasarım çıktısı olmayan ilk görsel. */
export function sourcePhoto(post: Post): Asset | null {
  return post.assets.find((asset) => asset.kind === 'image' && asset.source !== 'design') ?? null;
}

export function needsLayout(post: Post): boolean {
  return !!sourcePhoto(post) && !post.assets.some((asset) => asset.source === 'design') && !!(post.data.headline || post.title);
}

/**
 * Gönderinin görseline hazır düzeni uygular: gerçek logo, tam renk kodları ve
 * hatasız başlık. Sonuç kütüphaneye kaydedilir, gönderinin kapağı olur ve
 * sonradan ince ayar için düzenlenebilir bir tasarım olarak da saklanır.
 */
export async function applyLayout(post: Post, brand: Entity | null, templateId: string): Promise<Post> {
  const template = TEMPLATES.find((item) => item.id === templateId) ?? TEMPLATES[0];
  const format = getFormat(post.platform, post.format);
  const { width, height } = format;
  const photo = sourcePhoto(post);
  await loadFonts(brand);
  const logoAssetId = await logoOf(brand);
  const built = template.build(
    { width, height, brand, logoAssetId, headline: post.data.headline || post.title || '', subline: post.data.subline || '' },
    photo ? imageLayer(photo.id, width, height) : null,
  );
  const doc: DesignDoc = { background: built.background ?? '#111111', layers: built.layers };
  const title = post.title || 'Gönderi tasarımı';
  const asset = await saveImage(doc, width, height, title);
  const design = await api.post<Design>('/api/designs', { name: title, width, height, doc, brandId: brand?.id ?? null, postId: post.id, assetId: asset.id });
  const rest = post.assetIds.filter((id) => id !== photo?.id && post.assets.find((a) => a.id === id)?.source !== 'design');
  const next = await api.patch<Post>(`/api/posts/${post.id}`, { assetIds: [asset.id, ...rest], designId: design.id });
  queryClient.setQueryData(keys.post(post.id), next);
  return next;
}

function slideDoc(options: {
  index: number;
  total: number;
  width: number;
  height: number;
  headline: string;
  body: string;
  brand: Entity | null;
  logoAssetId: string | null;
  photoId: string | null;
}): DesignDoc {
  const { index, total, width, height, brand, logoAssetId } = options;
  const fonts = brandFonts(brand);
  const m = Math.round(width * 0.085);
  const primary = brandColor(brand, 'primary', '#171717');
  const paper = brandColor(brand, 'background', '#F5F3EF');
  const accent = brandColor(brand, 'accent', brandColor(brand, 'secondary', '#E4572E'));
  const first = index === 0;
  const last = index === total - 1 && total > 1;
  const withPhoto = first && !!options.photoId;

  // Kapak marka renginde, iç kareler açık zeminde, kapanış vurgu renginde: kaydırdıkça ritim değişir.
  const background = withPhoto ? '#111111' : first ? primary : last ? accent : paper;
  const ink = withPhoto ? '#FFFFFF' : readableOn(background);
  const soft = `${ink}${ink === '#FFFFFF' ? 'B8' : '99'}`;
  const logoSize = Math.round(width * 0.11);
  const footerY = height - m - logoSize;

  const head = textLayer({
    text: options.headline, x: m, y: 0, w: width - m * 2, font: fonts.heading, color: ink,
    size: Math.round(width * (first ? 0.092 : 0.074)), weight: 800, letterSpacing: -1, lineHeight: 1.08,
  });
  const body = textLayer({
    text: options.body, x: m, y: 0, w: width - m * 2, font: fonts.body, color: withPhoto ? '#FFFFFFE6' : ink,
    size: Math.round(width * 0.04), weight: 500, lineHeight: 1.42,
  });
  const gap = Math.round(m * 0.4);
  const block = head.h + (options.body ? gap + body.h : 0);
  if (withPhoto) {
    // Kapakta metin alta yaslanır; fotoğraf üstte nefes alır.
    head.y = footerY - Math.round(m * 0.6) - block;
  } else {
    const top = m + Math.round(width * 0.06);
    head.y = Math.max(top, Math.round(top + (footerY - top - block) / 2));
  }
  body.y = head.y + head.h + gap;

  const counter = textLayer({
    text: `${index + 1} / ${total}`, x: m, y: m, w: Math.round(width * 0.3), font: 'JetBrains Mono Variable',
    size: Math.round(width * 0.028), weight: 600, color: soft, letterSpacing: 1,
  });
  const next = textLayer({
    text: last ? '' : 'Kaydır →', x: width - m - Math.round(width * 0.36), y: 0, w: Math.round(width * 0.36), font: fonts.body,
    size: Math.round(width * 0.03), weight: 600, color: soft, align: 'right',
  });
  next.y = footerY + Math.round((logoSize - next.h) / 2);
  const name = textLayer({
    text: brand?.name ?? '', x: m, y: 0, w: Math.round(width * 0.5), font: fonts.heading,
    size: Math.round(width * 0.034), weight: 700, color: ink,
  });
  name.y = footerY + Math.round((logoSize - name.h) / 2);

  const layers: Layer[] = [];
  if (withPhoto) {
    layers.push(imageLayer(options.photoId!, width, height));
    layers.push(shapeLayer({ x: 0, y: Math.round(height * 0.3), w: width, h: Math.round(height * 0.7), fill: '#00000000', fill2: '#000000E0', angle: 180 }));
  }
  layers.push(counter, head);
  if (options.body) layers.push(body);
  if (logoAssetId) layers.push(logoLayer(logoAssetId, m, footerY, logoSize));
  else if (brand) layers.push(name);
  if (!last) layers.push(next);
  return { background, layers };
}

/**
 * Kaydırmalı gönderinin karelerini marka renkleri ve yazı tipleriyle görsele
 * çevirir, kütüphaneye kaydeder ve gönderinin medyası yapar.
 */
export async function renderSlides(
  post: Post,
  brand: Entity | null,
  options: { coverPhotoId?: string | null; onProgress?: (done: number, total: number) => void } = {},
): Promise<Post> {
  const { onProgress } = options;
  const slides = (post.data.slides ?? []).filter((slide) => slide.headline.trim() || slide.body.trim());
  if (!slides.length) throw new Error('Önce kareleri yazın.');
  const format = getFormat(post.platform, post.format);
  const { width, height } = format;
  await loadFonts(brand);
  await ensureFont('JetBrains Mono Variable', 600);
  const logoAssetId = await logoOf(brand);
  const photoId = options.coverPhotoId ?? null;
  const ids: string[] = [];
  for (let index = 0; index < slides.length; index += 1) {
    onProgress?.(index, slides.length);
    const doc = slideDoc({
      index, total: slides.length, width, height, brand, logoAssetId, photoId,
      headline: slides[index].headline.trim(), body: slides[index].body.trim(),
    });
    const asset = await saveImage(doc, width, height, `${post.title || 'Kaydırmalı gönderi'} · ${index + 1}`);
    ids.push(asset.id);
  }
  onProgress?.(slides.length, slides.length);
  const next = await api.patch<Post>(`/api/posts/${post.id}`, { assetIds: ids });
  queryClient.setQueryData(keys.post(post.id), next);
  return next;
}
