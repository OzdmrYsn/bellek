import type { BrandColor, DesignDoc, Entity, ImageLayer, Layer, ShapeLayer, TextLayer } from '../../shared/types.ts';
import { newId, textHeight } from './render.ts';

export interface TemplateContext {
  width: number;
  height: number;
  brand: Entity | null;
  logoAssetId: string | null;
  headline: string;
  subline: string;
}

function color(brand: Entity | null, role: BrandColor['role'], fallback: string): string {
  return brand?.data.colors?.find((c) => c.role === role)?.hex ?? fallback;
}

/** Zemin rengine göre okunaklı metin rengi seçer. */
export function readableOn(hex: string): string {
  const value = hex.replace('#', '');
  if (value.length < 6) return '#FFFFFF';
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(value.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? '#111111' : '#FFFFFF';
}

export function textLayer(partial: Partial<TextLayer> & Pick<TextLayer, 'text' | 'x' | 'y' | 'w' | 'size'>): TextLayer {
  const layer: TextLayer = {
    id: newId(), type: 'text', h: 0, rotation: 0, opacity: 1,
    font: 'Instrument Sans Variable', weight: 700, color: '#FFFFFF', align: 'left', lineHeight: 1.12, letterSpacing: 0,
    uppercase: false, background: '', padding: 0, radius: 0, shadow: false,
    ...partial,
  };
  layer.h = textHeight(layer);
  return layer;
}

export function shapeLayer(partial: Partial<ShapeLayer> & Pick<ShapeLayer, 'x' | 'y' | 'w' | 'h' | 'fill'>): ShapeLayer {
  return { id: newId(), type: 'shape', shape: 'rect', rotation: 0, opacity: 1, fill2: '', angle: 180, radius: 0, ...partial };
}

export function logoLayer(assetId: string, x: number, y: number, size: number): ImageLayer {
  return { id: newId(), type: 'image', assetId, x, y, w: size, h: size, rotation: 0, opacity: 1, fit: 'contain', focusX: 0.5, focusY: 0.5, radius: 0 };
}

function fonts(brand: Entity | null): { heading: string; body: string } {
  return {
    heading: brand?.data.fonts?.heading?.trim() || 'Instrument Sans Variable',
    body: brand?.data.fonts?.body?.trim() || 'Instrument Sans Variable',
  };
}

type Build = (ctx: TemplateContext, photo: ImageLayer | null) => { background?: string; layers: Layer[] };

export interface Template {
  id: string;
  label: string;
  hint: string;
  build: Build;
}

const cover = (photo: ImageLayer | null, ctx: TemplateContext, h = ctx.height): Layer[] =>
  photo ? [{ ...photo, x: 0, y: 0, w: ctx.width, h, rotation: 0, radius: 0, fit: 'cover' as const }] : [];

export const TEMPLATES: Template[] = [
  {
    id: 'bottom',
    label: 'Alt başlık',
    hint: 'Görselin altında koyu geçiş, üstünde başlık',
    build: (ctx, photo) => {
      const m = Math.round(ctx.width * 0.07);
      const f = fonts(ctx.brand);
      const head = textLayer({ text: ctx.headline, x: m, y: 0, w: ctx.width - m * 2, size: Math.round(ctx.width * 0.085), font: f.heading, weight: 800, letterSpacing: -1 });
      const sub = textLayer({ text: ctx.subline, x: m, y: 0, w: ctx.width - m * 2, size: Math.round(ctx.width * 0.034), font: f.body, weight: 500, lineHeight: 1.35, color: '#FFFFFFE0' });
      sub.y = ctx.height - m - sub.h;
      head.y = sub.y - head.h - Math.round(m * 0.35);
      return {
        background: '#111111',
        layers: [
          ...cover(photo, ctx),
          shapeLayer({ x: 0, y: Math.round(ctx.height * 0.42), w: ctx.width, h: Math.round(ctx.height * 0.58), fill: '#00000000', fill2: '#000000D9', angle: 180 }),
          head,
          sub,
          ...(ctx.logoAssetId ? [logoLayer(ctx.logoAssetId, m, m, Math.round(ctx.width * 0.13))] : []),
        ],
      };
    },
  },
  {
    id: 'split',
    label: 'Bölünmüş',
    hint: 'Üstte görsel, altta marka renginde metin alanı',
    build: (ctx, photo) => {
      const m = Math.round(ctx.width * 0.07);
      const f = fonts(ctx.brand);
      const block = color(ctx.brand, 'primary', '#1B1B1B');
      const ink = readableOn(block);
      const photoHeight = Math.round(ctx.height * 0.6);
      const head = textLayer({ text: ctx.headline, x: m, y: 0, w: ctx.width - m * 2, size: Math.round(ctx.width * 0.07), font: f.heading, weight: 800, color: ink, letterSpacing: -1 });
      const sub = textLayer({ text: ctx.subline, x: m, y: 0, w: ctx.width - m * 2, size: Math.round(ctx.width * 0.032), font: f.body, weight: 500, lineHeight: 1.35, color: ink });
      // Metin, alt alanın ortasına oturur; dikey biçimlerde altta boşluk yığılmaz.
      const gap = Math.round(m * 0.3);
      const textHeightTotal = head.h + (ctx.subline ? gap + sub.h : 0);
      head.y = Math.round(photoHeight + Math.max(m * 0.5, (ctx.height - photoHeight - textHeightTotal) / 2));
      sub.y = head.y + head.h + gap;
      return {
        background: block,
        layers: [
          ...cover(photo, ctx, photoHeight),
          head,
          sub,
          ...(ctx.logoAssetId ? [logoLayer(ctx.logoAssetId, ctx.width - m - Math.round(ctx.width * 0.12), m, Math.round(ctx.width * 0.12))] : []),
        ],
      };
    },
  },
  {
    id: 'quote',
    label: 'Ortada alıntı',
    hint: 'Karartılmış görselin ortasında büyük metin',
    build: (ctx, photo) => {
      const m = Math.round(ctx.width * 0.1);
      const f = fonts(ctx.brand);
      const head = textLayer({ text: ctx.headline, x: m, y: 0, w: ctx.width - m * 2, size: Math.round(ctx.width * 0.075), font: f.heading, weight: 700, align: 'center', lineHeight: 1.18 });
      head.y = Math.round((ctx.height - head.h) / 2);
      const sub = textLayer({ text: ctx.subline, x: m, y: head.y + head.h + m * 0.35, w: ctx.width - m * 2, size: Math.round(ctx.width * 0.03), font: f.body, weight: 500, align: 'center', uppercase: true, letterSpacing: 3, color: '#FFFFFFCC' });
      return {
        background: color(ctx.brand, 'primary', '#151515'),
        layers: [
          ...cover(photo, ctx),
          ...(photo ? [shapeLayer({ x: 0, y: 0, w: ctx.width, h: ctx.height, fill: '#0000008C' })] : []),
          head,
          sub,
          ...(ctx.logoAssetId ? [logoLayer(ctx.logoAssetId, Math.round(ctx.width / 2 - ctx.width * 0.06), ctx.height - m - Math.round(ctx.width * 0.12), Math.round(ctx.width * 0.12))] : []),
        ],
      };
    },
  },
  {
    id: 'label',
    label: 'Etiket',
    hint: 'Görsel önde; köşede küçük, dolgulu bir başlık',
    build: (ctx, photo) => {
      const m = Math.round(ctx.width * 0.06);
      const f = fonts(ctx.brand);
      const accent = color(ctx.brand, 'accent', color(ctx.brand, 'primary', '#F77F20'));
      const head = textLayer({
        text: ctx.headline, x: m, y: 0, w: Math.round(ctx.width * 0.72), size: Math.round(ctx.width * 0.052), font: f.heading, weight: 800,
        color: readableOn(accent), background: accent, padding: Math.round(ctx.width * 0.03), radius: Math.round(ctx.width * 0.02), lineHeight: 1.15,
      });
      head.y = ctx.height - m - head.h;
      return {
        background: '#111111',
        layers: [
          ...cover(photo, ctx),
          head,
          ...(ctx.logoAssetId ? [logoLayer(ctx.logoAssetId, m, m, Math.round(ctx.width * 0.13))] : []),
        ],
      };
    },
  },
  {
    id: 'frame',
    label: 'Çerçeve',
    hint: 'Marka zemininde, kenar boşluklu görsel ve alt yazı',
    build: (ctx, photo) => {
      const m = Math.round(ctx.width * 0.06);
      const f = fonts(ctx.brand);
      const paper = color(ctx.brand, 'background', '#F4F4F4');
      const ink = readableOn(paper);
      const sub = textLayer({ text: ctx.subline, x: m, y: 0, w: ctx.width - m * 2, size: Math.round(ctx.width * 0.03), font: f.body, weight: 500, color: ink, lineHeight: 1.35 });
      const head = textLayer({ text: ctx.headline, x: m, y: 0, w: ctx.width - m * 2, size: Math.round(ctx.width * 0.058), font: f.heading, weight: 800, color: ink, letterSpacing: -0.5 });
      sub.y = ctx.height - m - sub.h;
      head.y = sub.y - head.h - m * 0.25;
      const photoHeight = head.y - m * 1.6;
      return {
        background: paper,
        layers: [
          ...(photo ? [{ ...photo, x: m, y: m, w: ctx.width - m * 2, h: Math.max(100, photoHeight), rotation: 0, radius: Math.round(ctx.width * 0.025), fit: 'cover' as const }] : []),
          head,
          sub,
        ],
      };
    },
  },
];

/** Şablonu uygular: var olan ilk fotoğraf korunur, metinler ve süslemeler yeniden kurulur. */
export function applyTemplate(doc: DesignDoc, template: Template, ctx: TemplateContext): DesignDoc {
  const photo = (doc.layers.find((layer) => layer.type === 'image' && layer.assetId !== ctx.logoAssetId) as ImageLayer | undefined) ?? null;
  const texts = doc.layers.filter((layer): layer is TextLayer => layer.type === 'text');
  const built = template.build(
    {
      ...ctx,
      // Kullanıcının yazdığı metinler şablon değişse de korunur.
      headline: texts[0]?.text || ctx.headline,
      subline: texts[1]?.text || ctx.subline,
    },
    photo,
  );
  return { background: built.background ?? doc.background, layers: built.layers };
}
