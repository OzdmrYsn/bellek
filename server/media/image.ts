import sharp from 'sharp';
import type { Media } from '../providers/types.ts';

/** Görseli tam istenen piksel ölçüsüne getirir; fazlalık, ilgi çekici bölge korunarak kırpılır. */
export async function fitImage(media: Media, width: number, height: number): Promise<Media> {
  const source = sharp(media.data, { animated: false }).rotate();
  const meta = await sharp(media.data).metadata();
  if (meta.width === width && meta.height === height) return media;
  const resized = source.resize(width, height, { fit: 'cover', position: sharp.strategy.attention, kernel: 'lanczos3' });
  if (meta.hasAlpha) return { data: await resized.png({ compressionLevel: 8 }).toBuffer(), mime: 'image/png' };
  if (media.mime.includes('png')) return { data: await resized.png({ compressionLevel: 8 }).toBuffer(), mime: 'image/png' };
  return { data: await resized.jpeg({ quality: 93, chromaSubsampling: '4:4:4' }).toBuffer(), mime: 'image/jpeg' };
}

/** Maskeyi gri tonlamalı, verilen ölçüde ham piksele çevirir (beyaz = değişecek alan). */
async function maskPixels(mask: Buffer, width: number, height: number, blur = 0): Promise<Buffer> {
  let pipeline = sharp(mask).flatten({ background: '#000000' }).resize(width, height, { fit: 'fill' }).greyscale();
  if (blur > 0.3) pipeline = pipeline.blur(blur);
  return pipeline.raw().toBuffer();
}

/** Maskeyi, modele gönderilen görselle aynı ölçüde PNG olarak hazırlar. */
export async function maskFor(image: Buffer, mask: Buffer): Promise<Buffer> {
  const meta = await sharp(image).metadata();
  const width = meta.width ?? 1024;
  const height = meta.height ?? 1024;
  return sharp(await maskPixels(mask, width, height), { raw: { width, height, channels: 1 } }).png().toBuffer();
}

/**
 * Maskeyi doğrudan alamayan modeller için: görselin, değişecek alanı macentayla
 * boyanmış bir kopyası. Model iki görseli karşılaştırıp neresinin değişeceğini anlar.
 */
export async function markupImage(image: Buffer, mask: Buffer): Promise<Buffer> {
  const meta = await sharp(image).metadata();
  const width = meta.width ?? 1024;
  const height = meta.height ?? 1024;
  const alpha = await sharp(await maskPixels(mask, width, height), { raw: { width, height, channels: 1 } })
    .linear(0.6, 0)
    .raw()
    .toBuffer();
  const overlay = await sharp({ create: { width, height, channels: 3, background: '#FF00C8' } })
    .joinChannel(alpha, { raw: { width, height, channels: 1 } })
    .png()
    .toBuffer();
  return sharp(image).removeAlpha().composite([{ input: overlay }]).jpeg({ quality: 90 }).toBuffer();
}

/**
 * Düzenlenmiş görseli özgünün üzerine yalnızca maskeli alanda bindirir. Model
 * görselin başka yerlerini de değiştirmiş olsa bile işaretlenmeyen pikseller
 * özgün hâliyle kalır; kenar yumuşatılarak geçiş görünmez yapılır.
 */
export async function blendWithMask(original: Buffer, edited: Buffer, mask: Buffer): Promise<Media> {
  const base = sharp(original, { animated: false }).rotate();
  const meta = await sharp(await base.clone().toBuffer()).metadata();
  const width = meta.width ?? 1024;
  const height = meta.height ?? 1024;
  const feather = Math.max(2, Math.round(Math.min(width, height) / 220));
  const alpha = await maskPixels(mask, width, height, feather);
  const patch = await sharp(edited)
    .rotate()
    .resize(width, height, { fit: 'fill' })
    .removeAlpha()
    .joinChannel(alpha, { raw: { width, height, channels: 1 } })
    .png()
    .toBuffer();
  const composed = base.clone().composite([{ input: patch }]);
  if (meta.hasAlpha) return { data: await composed.png({ compressionLevel: 8 }).toBuffer(), mime: 'image/png' };
  return { data: await composed.jpeg({ quality: 94, chromaSubsampling: '4:4:4' }).toBuffer(), mime: 'image/jpeg' };
}

/** Yapay zekâsız büyütme: fal.ai bağlı değilken son çare. */
export async function localUpscale(image: Buffer, factor = 2): Promise<Media> {
  const meta = await sharp(image).rotate().metadata();
  const width = Math.min(8192, Math.round((meta.width ?? 1024) * factor));
  const resized = sharp(image).rotate().resize({ width, kernel: 'lanczos3' }).sharpen({ sigma: 0.6 });
  if (meta.hasAlpha) return { data: await resized.png({ compressionLevel: 8 }).toBuffer(), mime: 'image/png' };
  return { data: await resized.jpeg({ quality: 94 }).toBuffer(), mime: 'image/jpeg' };
}

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Tam kare, saydam zeminli altyazı görseli; videonun üzerine zamanlı olarak bindirilir. */
export async function subtitleFrame(lines: string[], width: number, height: number): Promise<Buffer> {
  const size = Math.round(Math.min(width, height) * 0.048);
  const lineHeight = Math.round(size * 1.32);
  const padding = Math.round(size * 0.55);
  const longest = Math.max(...lines.map((line) => line.length), 1);
  const boxWidth = Math.min(width * 0.92, longest * size * 0.56 + padding * 2);
  const boxHeight = lines.length * lineHeight + padding * 1.4;
  const top = Math.round(height * 0.86 - boxHeight);
  const left = Math.round((width - boxWidth) / 2);
  const text = lines
    .map(
      (line, index) =>
        `<text x="${width / 2}" y="${top + padding * 0.7 + lineHeight * (index + 0.78)}" text-anchor="middle" font-family="Helvetica Neue, Helvetica, Arial, sans-serif" font-weight="700" font-size="${size}" fill="#FFFFFF">${escapeXml(line)}</text>`,
    )
    .join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect x="${left}" y="${top}" width="${boxWidth}" height="${boxHeight}" rx="${Math.round(size * 0.35)}" fill="#000000" fill-opacity="0.66"/>${text}
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/** Marka zemini üzerinde ortalanmış logo: videonun kapanış karesi. */
export async function outroFrame(logo: Buffer | null, background: string, title: string, width: number, height: number): Promise<Buffer> {
  const canvas = sharp({ create: { width, height, channels: 3, background: /^#[0-9a-f]{6}$/i.test(background) ? background : '#111111' } });
  if (logo) {
    const edge = Math.round(Math.min(width, height) * 0.42);
    const mark = await sharp(logo).rotate().resize(edge, edge, { fit: 'inside' }).png().toBuffer();
    return canvas.composite([{ input: mark, gravity: 'centre' }]).png().toBuffer();
  }
  const size = Math.round(Math.min(width, height) * 0.08);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><text x="50%" y="52%" text-anchor="middle" font-family="Helvetica Neue, Helvetica, Arial, sans-serif" font-weight="700" font-size="${size}" fill="#FFFFFF">${escapeXml(title)}</text></svg>`;
  return canvas.composite([{ input: Buffer.from(svg) }]).png().toBuffer();
}
