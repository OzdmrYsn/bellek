import dns from 'node:dns/promises';
import net from 'node:net';
import sharp from 'sharp';
import type { BrandColor } from '../../shared/types.ts';
import { Invalid } from '../repo/entities.ts';

// Bir web sitesinden marka ipuçlarını toplar: ad, açıklama, renkler, yazı
// tipleri, logo ve sayfa metni. Sayfa yalnızca okunur; hiçbir şey çalıştırılmaz.

const MAX_HTML = 2_000_000;
const MAX_CSS = 500_000;
const MAX_IMAGE = 8_000_000;

function isPrivate(address: string): boolean {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || a >= 224;
  }
  const lower = address.toLowerCase();
  return lower === '::1' || lower === '::' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80') || lower.startsWith('::ffff:');
}

/** Yalnızca genel internetteki http(s) adreslerine izin verir; iç ağ ve yerel adresler reddedilir. */
async function assertPublic(url: URL): Promise<void> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Invalid('Adres http:// ya da https:// ile başlamalı.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) throw new Invalid('Yerel adresler okunamaz.');
  const addresses = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => []);
  if (!addresses.length) throw new Invalid('Bu adres bulunamadı. Yazımı kontrol edin.');
  if (addresses.some((entry) => isPrivate(entry.address))) throw new Invalid('Yerel ağ adresleri okunamaz.');
}

async function safeFetch(input: string, maxBytes: number, accept: string): Promise<{ data: Buffer; type: string; url: URL }> {
  let url = new URL(input);
  for (let hop = 0; hop < 5; hop++) {
    await assertPublic(url);
    const response = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(15000),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; brand-reader)', Accept: accept },
    });
    // Yönlendirmeler tek tek izlenir ki her durak yeniden denetlensin.
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) break;
      url = new URL(location, url);
      continue;
    }
    if (!response.ok) throw new Invalid(`Site yanıt vermedi (${response.status}).`);
    const reader = response.body?.getReader();
    const chunks: Buffer[] = [];
    let size = 0;
    while (reader) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) {
        await reader.cancel();
        break;
      }
      chunks.push(Buffer.from(value));
    }
    return { data: Buffer.concat(chunks), type: response.headers.get('content-type') ?? '', url };
  }
  throw new Invalid('Site çok fazla yönlendirme yapıyor.');
}

function attr(tag: string, name: string): string {
  const match = tag.match(new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return (match?.[1] ?? match?.[2] ?? match?.[3] ?? '').trim();
}

function decode(text: string): string {
  return text
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ').replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
}

function meta(html: string, key: string): string {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    if ([attr(tag, 'name'), attr(tag, 'property')].some((value) => value.toLowerCase() === key)) return decode(attr(tag, 'content'));
  }
  return '';
}

function toHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}

function parseColors(css: string, weights: Map<string, number>): void {
  const add = (hex: string, weight: number) => weights.set(hex, (weights.get(hex) ?? 0) + weight);
  // "--primary", "--brand" gibi adlandırılmış değişkenler markanın kendi seçimidir; ağırlıkları yüksek tutulur.
  for (const match of css.matchAll(/(--[\w-]*(?:primary|brand|accent|main|theme)[\w-]*)\s*:\s*(#[0-9a-f]{3,8})\b/gi)) {
    add(normalizeHex(match[2]), 40);
  }
  for (const match of css.matchAll(/#([0-9a-f]{6}|[0-9a-f]{3})\b/gi)) add(normalizeHex(`#${match[1]}`), 1);
  for (const match of css.matchAll(/rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})/gi)) {
    add(toHex(Number(match[1]), Number(match[2]), Number(match[3])), 1);
  }
}

function normalizeHex(hex: string): string {
  const value = hex.replace('#', '');
  const full = value.length === 3 ? value.split('').map((c) => c + c).join('') : value.slice(0, 6);
  return `#${full}`.toUpperCase();
}

function channels(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}

function pickPalette(weights: Map<string, number>): BrandColor[] {
  const scored = [...weights.entries()]
    .map(([hex, weight]) => {
      const [r, g, b] = channels(hex);
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      return { hex, weight, saturation: max ? (max - min) / max : 0, luma: (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 };
    })
    .sort((a, b) => b.weight - a.weight);
  const far = (hex: string, others: string[]) =>
    others.every((other) => {
      const [a, b] = [channels(hex), channels(other)];
      return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) > 56;
    });
  const chromatic: string[] = [];
  for (const color of scored) {
    if (color.saturation > 0.3 && color.luma > 0.08 && color.luma < 0.95 && far(color.hex, chromatic)) chromatic.push(color.hex);
    if (chromatic.length >= 3) break;
  }
  const dark = scored.find((c) => c.luma < 0.22 && c.saturation < 0.5);
  const light = scored.find((c) => c.luma > 0.9);
  const roles: BrandColor['role'][] = ['primary', 'secondary', 'accent'];
  return [
    ...chromatic.map((hex, index) => ({ name: '', hex, role: roles[index] })),
    ...(light ? [{ name: '', hex: light.hex, role: 'background' as const }] : []),
    ...(dark ? [{ name: '', hex: dark.hex, role: 'text' as const }] : []),
  ];
}

const GENERIC_FONTS = /^(inherit|initial|unset|sans-serif|serif|monospace|system-ui|ui-sans-serif|ui-serif|ui-monospace|-apple-system|blinkmacsystemfont|segoe ui|helvetica neue|helvetica|arial|roboto|times new roman|georgia|courier new|apple color emoji|segoe ui emoji|noto color emoji|var\(.*|emoji|cursive|fantasy)$/i;

function parseFonts(html: string, css: string): string[] {
  const counts = new Map<string, number>();
  const add = (name: string, weight: number) => {
    const clean = name.replace(/["']/g, '').replace(/\+/g, ' ').trim();
    if (!clean || clean.length > 40 || GENERIC_FONTS.test(clean) || /icon|awesome|symbol|glyph/i.test(clean)) return;
    counts.set(clean, (counts.get(clean) ?? 0) + weight);
  };
  for (const match of html.matchAll(/fonts\.googleapis\.com\/css2?\?([^"'\s>]+)/gi)) {
    for (const family of decode(match[1]).matchAll(/family=([^&:;]+)/g)) add(decodeURIComponent(family[1]), 20);
  }
  for (const match of css.matchAll(/font-family\s*:\s*([^;}{]+)/gi)) add(match[1].split(',')[0], 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name).slice(0, 2);
}

function findLogo(html: string, base: URL): string | null {
  const resolve = (value: string) => {
    try {
      return value && !value.startsWith('data:') ? new URL(decode(value), base).toString() : null;
    } catch {
      return null;
    }
  };
  for (const tag of html.match(/<img\b[^>]*>/gi) ?? []) {
    const hints = `${attr(tag, 'class')} ${attr(tag, 'id')} ${attr(tag, 'alt')} ${attr(tag, 'src')}`.toLowerCase();
    if (hints.includes('logo')) {
      const src = resolve(attr(tag, 'src') || attr(tag, 'data-src'));
      if (src) return src;
    }
  }
  const links = html.match(/<link\b[^>]*>/gi) ?? [];
  const byRel = (pattern: RegExp) => links.find((tag) => pattern.test(attr(tag, 'rel')));
  const icon = byRel(/apple-touch-icon/i) ?? byRel(/^icon$|shortcut icon/i);
  return icon ? resolve(attr(icon, 'href')) : null;
}

export interface SiteInfo {
  url: string;
  title: string;
  description: string;
  text: string;
  colors: BrandColor[];
  fonts: string[];
  logo: { data: Buffer; filename: string } | null;
}

export async function readSite(input: string): Promise<SiteInfo> {
  const trimmed = input.trim();
  if (!trimmed) throw new Invalid('Bir web adresi girin.');
  let target: URL;
  try {
    target = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    throw new Invalid('Bu geçerli bir web adresi değil.');
  }
  const page = await safeFetch(target.toString(), MAX_HTML, 'text/html,*/*');
  const html = page.data.toString('utf8');

  // Renkleri ve yazı tiplerini sayfadaki ve bağlı ilk birkaç stil dosyasındaki CSS'ten topla.
  let css = (html.match(/<style\b[^>]*>([\s\S]*?)<\/style>/gi) ?? []).join('\n');
  const sheets = (html.match(/<link\b[^>]*>/gi) ?? [])
    .filter((tag) => /stylesheet/i.test(attr(tag, 'rel')) && attr(tag, 'href') && !/fonts\.googleapis/i.test(attr(tag, 'href')))
    .slice(0, 3);
  for (const tag of sheets) {
    try {
      css += `\n${(await safeFetch(new URL(decode(attr(tag, 'href')), page.url).toString(), MAX_CSS, 'text/css,*/*')).data.toString('utf8')}`;
    } catch {
      // Okunamayan stil dosyası atlanır.
    }
  }
  const weights = new Map<string, number>();
  parseColors(css, weights);
  const theme = meta(html, 'theme-color');
  if (/^#[0-9a-f]{3,6}$/i.test(theme)) weights.set(normalizeHex(theme), (weights.get(normalizeHex(theme)) ?? 0) + 60);

  let logo: SiteInfo['logo'] = null;
  const logoUrl = findLogo(html, page.url);
  if (logoUrl) {
    try {
      const file = await safeFetch(logoUrl, MAX_IMAGE, 'image/*');
      const info = await sharp(file.data, { density: 300 }).metadata();
      // Çok küçük simgeler logo olarak işe yaramaz.
      if ((info.width ?? 0) >= 48 || info.format === 'svg') logo = { data: file.data, filename: `${page.url.hostname.replace(/^www\./, '')}-logo.${info.format === 'jpeg' ? 'jpg' : info.format ?? 'png'}` };
    } catch {
      // Logo okunamazsa geri kalan bilgiler yine de döner.
    }
  }

  const text = decode(
    html
      .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' '),
  ).trim();

  return {
    url: page.url.origin,
    title: decode((meta(html, 'og:site_name') || html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').trim()).slice(0, 160),
    description: (meta(html, 'description') || meta(html, 'og:description')).slice(0, 400),
    text: text.slice(0, 9000),
    colors: pickPalette(weights),
    fonts: parseFonts(html, css),
    logo,
  };
}
