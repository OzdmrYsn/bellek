import type { BrandColor } from '../../shared/types.ts';

interface Bucket {
  r: number;
  g: number;
  b: number;
  count: number;
}

function distance(a: Bucket, b: Bucket): number {
  return Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);
}

const hex = (bucket: Bucket) =>
  `#${[bucket.r, bucket.g, bucket.b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`.toUpperCase();

/**
 * Logodan baskın renkleri çıkarır. Tarayıcıda çalışır, hiçbir yere veri
 * göndermez: görsel küçültülür, pikseller kaba kovalara toplanır ve birbirine
 * yeterince uzak, en kalabalık kovalar seçilir.
 */
export async function extractPalette(url: string, limit = 5): Promise<BrandColor[]> {
  const image = new Image();
  image.src = url;
  await image.decode();
  const size = 96;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d', { willReadFrequently: true })!;
  context.drawImage(image, 0, 0, size, size);
  const { data } = context.getImageData(0, 0, size, size);

  const buckets = new Map<number, Bucket>();
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 140) continue;
    const key = ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4);
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.r += data[i];
      bucket.g += data[i + 1];
      bucket.b += data[i + 2];
      bucket.count++;
    } else {
      buckets.set(key, { r: data[i], g: data[i + 1], b: data[i + 2], count: 1 });
    }
  }
  const ranked = [...buckets.values()]
    .map((b) => ({ r: b.r / b.count, g: b.g / b.count, b: b.b / b.count, count: b.count }))
    .sort((a, b) => b.count - a.count);
  const total = ranked.reduce((sum, b) => sum + b.count, 0) || 1;

  const picked: Bucket[] = [];
  for (const bucket of ranked) {
    if (bucket.count / total < 0.012) break;
    if (picked.every((other) => distance(other, bucket) > 48)) picked.push(bucket);
    if (picked.length >= limit) break;
  }

  const saturation = (b: Bucket) => {
    const max = Math.max(b.r, b.g, b.b);
    const min = Math.min(b.r, b.g, b.b);
    return max === 0 ? 0 : (max - min) / max;
  };
  const luma = (b: Bucket) => (0.2126 * b.r + 0.7152 * b.g + 0.0722 * b.b) / 255;

  // En doygun renk ana renktir; çok açık ve çok koyu tonlar zemin ve metin rolünü alır.
  const chromatic = picked.filter((b) => saturation(b) > 0.25).sort((a, b) => saturation(b) * b.count - saturation(a) * a.count);
  return picked.map((bucket) => {
    const index = chromatic.indexOf(bucket);
    const role: BrandColor['role'] =
      index === 0 ? 'primary'
      : index === 1 ? 'secondary'
      : index > 1 ? 'accent'
      : luma(bucket) > 0.85 ? 'background'
      : luma(bucket) < 0.2 ? 'text'
      : 'neutral';
    return { name: '', hex: hex(bucket), role };
  });
}
