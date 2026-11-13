import type { DesignDoc, ImageLayer, Layer, ShapeLayer, TextLayer } from '../../shared/types.ts';

// Tasarım hem düzenlenirken hem dışa aktarılırken aynı işlevle, aynı tuvale
// çizilir. Böylece ekranda görülen ile indirilen dosya piksel piksel aynıdır;
// DOM ile tuval arasındaki satır kırma farkları hiç ortaya çıkmaz.

export type ImageStore = Map<string, HTMLImageElement>;

const SYSTEM_FONTS = new Set(['Instrument Sans Variable', 'JetBrains Mono Variable', 'Georgia', 'Arial', 'Helvetica', 'Times New Roman']);
const requestedFonts = new Set<string>();

export const FONT_CHOICES = [
  'Instrument Sans Variable', 'Inter', 'Poppins', 'Montserrat', 'Manrope', 'Space Grotesk', 'Bebas Neue',
  'Playfair Display', 'DM Serif Display', 'Fraunces', 'Roboto Slab', 'Caveat',
];

export function fontLabel(font: string): string {
  return font.replace(/ Variable$/, '');
}

/** Google Fonts'tan (varsa) yazı tipini yükler; bulunamazsa sistem yazı tipine düşülür. */
export async function ensureFont(font: string, weight = 700): Promise<void> {
  const family = font.trim();
  if (!family) return;
  if (!SYSTEM_FONTS.has(family) && !requestedFonts.has(family)) {
    requestedFonts.add(family);
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, '+')}:wght@400;500;600;700;800;900&display=swap`;
    document.head.appendChild(link);
    await new Promise<void>((resolve) => {
      link.onload = () => resolve();
      link.onerror = () => resolve();
      window.setTimeout(resolve, 4000);
    });
  }
  try {
    await document.fonts.load(`${weight} 48px "${family}"`);
  } catch {
    // Yazı tipi yüklenemezse çizim yedek yazı tipiyle sürer.
  }
}

export function loadImage(assetId: string, store: ImageStore): Promise<HTMLImageElement | null> {
  const cached = store.get(assetId);
  if (cached) return Promise.resolve(cached);
  return new Promise((resolve) => {
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => {
      store.set(assetId, image);
      resolve(image);
    };
    image.onerror = () => resolve(null);
    image.src = `/media/${assetId}`;
  });
}

/** Belgedeki tüm görselleri ve yazı tiplerini çizimden önce hazırlar. */
export async function prepare(doc: DesignDoc, store: ImageStore): Promise<void> {
  await Promise.all(
    doc.layers.map((layer) => {
      if (layer.type === 'image') return loadImage(layer.assetId, store);
      if (layer.type === 'text') return ensureFont(layer.font, layer.weight);
      return null;
    }),
  );
}

function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, radius: number): void {
  const r = Math.max(0, Math.min(radius, w / 2, h / 2));
  ctx.beginPath();
  if (r === 0) ctx.rect(x, y, w, h);
  else ctx.roundRect(x, y, w, h, r);
}

function fontOf(layer: TextLayer): string {
  return `${layer.weight} ${layer.size}px "${layer.font}", "Instrument Sans Variable", system-ui, sans-serif`;
}

function applySpacing(ctx: CanvasRenderingContext2D, layer: TextLayer): void {
  // Harf aralığı tüm güncel tarayıcılarda tuval özelliği olarak desteklenir.
  (ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = `${layer.letterSpacing}px`;
}

export function wrapText(ctx: CanvasRenderingContext2D, layer: TextLayer): string[] {
  ctx.font = fontOf(layer);
  applySpacing(ctx, layer);
  const maxWidth = Math.max(10, layer.w - layer.padding * 2);
  const source = layer.uppercase ? layer.text.toLocaleUpperCase('tr') : layer.text;
  const lines: string[] = [];
  for (const paragraph of source.split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (ctx.measureText(candidate).width <= maxWidth) {
        line = candidate;
        continue;
      }
      if (line) lines.push(line);
      // Tek başına sığmayan sözcük harf harf bölünür.
      let rest = word;
      while (ctx.measureText(rest).width > maxWidth && rest.length > 1) {
        let cut = rest.length - 1;
        while (cut > 1 && ctx.measureText(rest.slice(0, cut)).width > maxWidth) cut--;
        lines.push(rest.slice(0, cut));
        rest = rest.slice(cut);
      }
      line = rest;
    }
    lines.push(line);
  }
  return lines;
}

let measurer: CanvasRenderingContext2D | null = null;

/** Metin katmanının, içeriğine göre olması gereken yüksekliği. */
export function textHeight(layer: TextLayer): number {
  measurer ??= document.createElement('canvas').getContext('2d')!;
  const lines = wrapText(measurer, layer);
  return Math.ceil(lines.length * layer.size * layer.lineHeight + layer.padding * 2);
}

function drawImage(ctx: CanvasRenderingContext2D, layer: ImageLayer, store: ImageStore): void {
  const image = store.get(layer.assetId);
  roundedRect(ctx, -layer.w / 2, -layer.h / 2, layer.w, layer.h, layer.radius);
  if (!image) {
    ctx.fillStyle = '#2a2a2a';
    ctx.fill();
    return;
  }
  ctx.save();
  ctx.clip();
  const iw = image.naturalWidth;
  const ih = image.naturalHeight;
  if (layer.fit === 'contain') {
    const scale = Math.min(layer.w / iw, layer.h / ih);
    ctx.drawImage(image, (-iw * scale) / 2, (-ih * scale) / 2, iw * scale, ih * scale);
  } else {
    const scale = Math.max(layer.w / iw, layer.h / ih);
    const sw = layer.w / scale;
    const sh = layer.h / scale;
    ctx.drawImage(image, (iw - sw) * layer.focusX, (ih - sh) * layer.focusY, sw, sh, -layer.w / 2, -layer.h / 2, layer.w, layer.h);
  }
  ctx.restore();
}

function drawShape(ctx: CanvasRenderingContext2D, layer: ShapeLayer): void {
  if (layer.fill2) {
    const angle = ((layer.angle - 90) * Math.PI) / 180;
    const half = (Math.abs(Math.cos(angle)) * layer.w + Math.abs(Math.sin(angle)) * layer.h) / 2;
    const gradient = ctx.createLinearGradient(-Math.cos(angle) * half, -Math.sin(angle) * half, Math.cos(angle) * half, Math.sin(angle) * half);
    gradient.addColorStop(0, layer.fill);
    gradient.addColorStop(1, layer.fill2);
    ctx.fillStyle = gradient;
  } else {
    ctx.fillStyle = layer.fill;
  }
  if (layer.shape === 'ellipse') {
    ctx.beginPath();
    ctx.ellipse(0, 0, layer.w / 2, layer.h / 2, 0, 0, Math.PI * 2);
  } else {
    roundedRect(ctx, -layer.w / 2, -layer.h / 2, layer.w, layer.h, layer.radius);
  }
  ctx.fill();
}

function drawText(ctx: CanvasRenderingContext2D, layer: TextLayer): void {
  const lines = wrapText(ctx, layer);
  const lineHeight = layer.size * layer.lineHeight;
  const height = lines.length * lineHeight + layer.padding * 2;
  const top = -layer.h / 2;
  if (layer.background) {
    ctx.fillStyle = layer.background;
    roundedRect(ctx, -layer.w / 2, top, layer.w, height, layer.radius);
    ctx.fill();
  }
  ctx.font = fontOf(layer);
  applySpacing(ctx, layer);
  ctx.fillStyle = layer.color;
  ctx.textBaseline = 'middle';
  ctx.textAlign = layer.align;
  if (layer.shadow) {
    ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
    ctx.shadowBlur = layer.size * 0.3;
    ctx.shadowOffsetY = layer.size * 0.05;
  }
  const x = layer.align === 'left' ? -layer.w / 2 + layer.padding : layer.align === 'right' ? layer.w / 2 - layer.padding : 0;
  lines.forEach((line, index) => {
    ctx.fillText(line, x, top + layer.padding + lineHeight * (index + 0.5));
  });
}

export function drawLayer(ctx: CanvasRenderingContext2D, layer: Layer, store: ImageStore): void {
  if (layer.hidden) return;
  ctx.save();
  ctx.translate(layer.x + layer.w / 2, layer.y + layer.h / 2);
  if (layer.rotation) ctx.rotate((layer.rotation * Math.PI) / 180);
  ctx.globalAlpha = layer.opacity;
  if (layer.type === 'image') drawImage(ctx, layer, store);
  else if (layer.type === 'shape') drawShape(ctx, layer);
  else drawText(ctx, layer);
  ctx.restore();
}

/** Belgeyi verilen ölçekle tuvale çizer. Çağırmadan önce `prepare` beklenmelidir. */
export function renderDesign(canvas: HTMLCanvasElement, doc: DesignDoc, width: number, height: number, store: ImageStore, scale = 1): void {
  const w = Math.round(width * scale);
  const h = Math.round(height * scale);
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = doc.background || '#ffffff';
  ctx.fillRect(0, 0, width, height);
  for (const layer of doc.layers) drawLayer(ctx, layer, store);
}

export async function exportDesign(doc: DesignDoc, width: number, height: number, store: ImageStore, type: 'image/png' | 'image/jpeg' = 'image/png'): Promise<Blob> {
  await prepare(doc, store);
  const canvas = document.createElement('canvas');
  renderDesign(canvas, doc, width, height, store, 1);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Görsel oluşturulamadı.'))), type, 0.94);
  });
}

/** Belge koordinatındaki bir nokta katmanın (dönmüş) kutusunun içinde mi. */
export function hitLayer(layer: Layer, px: number, py: number): boolean {
  const cx = layer.x + layer.w / 2;
  const cy = layer.y + layer.h / 2;
  const angle = (-layer.rotation * Math.PI) / 180;
  const dx = px - cx;
  const dy = py - cy;
  const lx = dx * Math.cos(angle) - dy * Math.sin(angle);
  const ly = dx * Math.sin(angle) + dy * Math.cos(angle);
  return Math.abs(lx) <= layer.w / 2 && Math.abs(ly) <= layer.h / 2;
}

export function newId(): string {
  return `l${Date.now().toString(36)}${Math.round(Math.random() * 1e5).toString(36)}`;
}
