import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { aspectToNumber } from '../../shared/platforms.ts';
import { paths } from '../config.ts';
import { FFMPEG } from '../storage.ts';
import {
  ProviderError, sleep,
  type Adapter, type AdapterFactory, type ImageRequest, type Media, type TextRequest, type TextResult,
  type VideoPoll, type VideoRequest, type VideoStart,
} from './types.ts';

// Anahtarsız uçtan uca deneme sağlayıcısı (BELLEK_MOCK=1). Gerçek modellerin
// yerine geçmez; akışın tamamını — akan metin, eylemler, işler, hatalar —
// internet ve ücret olmadan sınamak içindir.

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if ((line + ' ' + word).trim().length > width) {
      lines.push(line.trim());
      line = word;
    } else line += ` ${word}`;
  }
  if (line.trim()) lines.push(line.trim());
  return lines.slice(0, 9);
}

function hashHue(text: string): number {
  let hash = 0;
  for (const char of text) hash = (hash * 31 + char.charCodeAt(0)) % 360;
  return hash;
}

async function fakeImage(request: ImageRequest, variant: number): Promise<Media> {
  const ratio = aspectToNumber(request.aspect);
  const width = ratio >= 1 ? 1024 : Math.round(1024 * ratio);
  const height = ratio >= 1 ? Math.round(1024 / ratio) : 1024;
  const hue = (hashHue(request.prompt + request.model.id) + variant * 47) % 360;
  const lines = wrap(request.prompt, Math.max(18, Math.round(width / 26)));
  const text = lines
    .map((line, i) => `<text x="56" y="${150 + i * 44}" font-size="30" fill="white" font-family="Helvetica, Arial, sans-serif">${escapeXml(line)}</text>`)
    .join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="hsl(${hue} 62% 46%)"/><stop offset="1" stop-color="hsl(${(hue + 70) % 360} 58% 22%)"/>
    </linearGradient></defs>
    <rect width="100%" height="100%" fill="url(#g)"/>
    <circle cx="${width * 0.78}" cy="${height * 0.3}" r="${Math.min(width, height) * 0.22}" fill="hsl(${(hue + 30) % 360} 80% 70%)" opacity="0.35"/>
    <text x="56" y="84" font-size="22" fill="white" opacity="0.75" font-family="Helvetica, Arial, sans-serif">DENEME · ${escapeXml(request.model.label)} · ${request.aspect} · #${variant + 1}</text>
    ${text}
  </svg>`;
  let image = sharp(Buffer.from(svg));
  if (request.refs.length) {
    const size = Math.round(Math.min(width, height) * 0.17);
    const overlays = await Promise.all(
      request.refs.slice(0, 5).map(async (ref, index) => ({
        input: await sharp(ref.data).resize(size, size, { fit: 'cover' }).png().toBuffer(),
        left: 56 + index * (size + 12),
        top: height - size - 56,
      })),
    );
    image = sharp(await image.png().toBuffer()).composite(overlays);
  }
  return { data: await image.jpeg({ quality: 88 }).toBuffer(), mime: 'image/jpeg' };
}

function runFfmpeg(args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    if (!FFMPEG) return resolve(false);
    const child = spawn(FFMPEG, args, { stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

const videoJobs = new Map<string, { startedAt: number; request: VideoRequest }>();

async function fakeVideo(request: VideoRequest): Promise<Media> {
  const landscape = aspectToNumber(request.aspect) >= 1;
  const [width, height] = landscape ? [640, 360] : [360, 640];
  const out = path.join(paths.tmp, `deneme-${Date.now()}-${Math.round(Math.random() * 1e6)}.mp4`);
  const still = path.join(paths.tmp, `deneme-kare-${Date.now()}.jpg`);
  try {
    let ok = false;
    const source = request.start ?? request.refs[0];
    if (source) {
      await fsp.writeFile(still, source.data);
      ok = await runFfmpeg([
        '-y', '-loop', '1', '-i', still, '-t', '3', '-r', '24',
        '-vf', `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},zoompan=z='min(zoom+0.0015,1.2)':d=72:s=${width}x${height}`,
        '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out,
      ]);
    }
    if (!ok) {
      ok = await runFfmpeg([
        '-y', '-f', 'lavfi', '-i', `testsrc2=size=${width}x${height}:rate=24`, '-t', '3',
        '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out,
      ]);
    }
    if (!ok) throw new ProviderError('Deneme videosu için ffmpeg gerekli.');
    return { data: await fsp.readFile(out), mime: 'video/mp4' };
  } finally {
    await fsp.rm(out, { force: true });
    await fsp.rm(still, { force: true });
  }
}

function lastUserText(request: TextRequest): string {
  const last = [...request.messages].reverse().find((m) => m.role === 'user');
  return last?.content.map((p) => (p.type === 'text' ? p.text : '')).join('\n') ?? '';
}

function chatReply(request: TextRequest): string {
  const text = lastUserText(request);
  const mode = text.match(/mode="(\w+)"/)?.[1] ?? 'auto';
  const aspect = text.match(/aspect="([\d:]+)"/)?.[1] ?? '4:5';
  const body = text.split('</request_context>').pop()?.trim() ?? text;
  const handles = [...new Set([...body.matchAll(/@([a-z0-9_.-]+)/gi)].map((m) => `@${m[1].toLowerCase()}`))];
  const refs = handles.length ? ` refs="${handles.join(', ')}"` : '';
  const subject = handles.length ? handles.join(' ve ') : 'sahne';
  const lower = body.toLocaleLowerCase('tr');

  if (/hata ver/.test(lower)) throw new ProviderError('Deneme hatası: sağlayıcı isteği reddetti.');

  const remember = /hatırla|unutma|bundan sonra/.test(lower)
    ? `\n<remember category="preference"${handles[0] ? ` about="${handles[0]}"` : ''}>${body.replace(/\s+/g, ' ').slice(0, 140)}</remember>\n`
    : '';

  if (mode === 'text' || (mode === 'auto' && /\?$|nedir|nasıl|öner|yaz\b/.test(lower) && !/görsel|video|gönderi|post|plan/.test(lower))) {
    return (
      `İşte **${subject}** için kısa bir taslak:\n\n` +
      `1. Açılış cümlesi dikkat çeksin.\n2. Tek bir fikir anlat.\n3. Net bir çağrıyla bitir.\n\n` +
      `> Bu yanıt deneme sağlayıcısından geliyor; gerçek bir model bağladığınızda içerik hafızanıza göre yazılır.` +
      remember
    );
  }
  if (mode === 'video' || (mode === 'auto' && /video|canlandır|hareket/.test(lower))) {
    return `${subject} için kısa bir video hazırlıyorum.${remember}\n<generate_video aspect="9:16" duration="8"${refs}>Cinematic slow push-in on ${subject}, golden hour light, shallow depth of field. ${body.slice(0, 120)}</generate_video>`;
  }
  if (mode === 'post' || (mode === 'auto' && /gönderi|post|paylaşım/.test(lower) && !/plan/.test(lower))) {
    return (
      `Gönderiyi hazırladım; görseli de üretiyorum.${remember}\n` +
      `<post platform="instagram" format="portrait"${handles[0] ? ` brand="${handles[0]}"` : ''} generate_image="true">\n` +
      `<title>Yeni sezon duyurusu</title>\n<caption>Yeni sezon geldi. ☕\n\nİlk yudumda fark edeceğiniz bir denge: daha yumuşak, daha uzun bir bitiş.\n\nBu hafta tüm şubelerde.</caption>\n` +
      `<hashtags>#yenisezon #kahve #deneme</hashtags>\n<image_prompt aspect="4:5"${refs}>Editorial product photo for ${subject}, soft daylight, brand colours. ${body.slice(0, 100)}</image_prompt>\n</post>`
    );
  }
  if (mode === 'auto' && /plan|takvim|hafta/.test(lower)) {
    const base = new Date();
    const posts = [1, 3, 5].map((offset, index) => {
      const date = new Date(base.getTime() + offset * 86400000).toISOString().slice(0, 10);
      const platform = ['instagram', 'linkedin', 'x'][index];
      return `<post platform="${platform}" format="${platform === 'instagram' ? 'portrait' : 'landscape'}" date="${date}"${handles[0] ? ` brand="${handles[0]}"` : ''} generate_image="false">\n<title>Plan ${index + 1}: ${['Perde arkası', 'Müşteri hikâyesi', 'İpucu'][index]}</title>\n<caption>Deneme planı gönderisi ${index + 1}.</caption>\n<hashtags>#plan #deneme</hashtags>\n<image_prompt aspect="4:5"${refs}>Planned visual ${index + 1} for ${subject}.</image_prompt>\n</post>`;
    });
    return `Haftalık planı çıkardım:${remember}\n${posts.join('\n')}`;
  }
  return `${subject} için görseli hazırlıyorum.${remember}\n<generate_image aspect="${aspect}"${refs}>Photorealistic portrait of ${subject}. ${body.replace(/\s+/g, ' ').slice(0, 160)}</generate_image>`;
}

function taskReply(request: TextRequest): string | null {
  const system = request.system;
  if (system.includes('TASK:title')) return 'Deneme sohbeti';
  if (system.includes('TASK:profile')) {
    return 'Otuzlu yaşlarının başında, oval yüzlü, kısa koyu kahverengi saçlı ve hafif kirli sakallı bir erkek. Kahverengi gözler, belirgin kaşlar. Genellikle sade, koyu tonlu giyiniyor. (Deneme profili)';
  }
  if (system.includes('TASK:detect')) {
    return JSON.stringify([
      { label: 'Soldaki kişi', box: [120, 80, 780, 470] },
      { label: 'Sağdaki kişi', box: [150, 520, 800, 920] },
    ]);
  }
  if (system.includes('TASK:brand')) {
    return JSON.stringify({
      tagline: 'Her yudumda özen', industry: 'Kahve', audience: '25–40 yaş şehirli profesyoneller',
      tone: 'Sıcak, kendinden emin, abartısız', values: 'Zanaat, şeffaflık', dos: 'Kısa cümleler kur.', donts: 'Abartılı sıfatlardan kaçın.',
      hashtags: ['#kahve', '#zanaat'], colors: [{ name: 'Kavrulmuş', hex: '#3B2A20', role: 'primary' }, { name: 'Krema', hex: '#F2E8DC', role: 'background' }],
    });
  }
  if (system.includes('TASK:campaign')) {
    const user = lastUserText(request);
    const platforms = (user.match(/Platforms: ([^.\n]+)/)?.[1] ?? 'instagram').split(',').map((p) => p.trim());
    const format: Record<string, string> = { instagram: 'portrait', tiktok: 'vertical', x: 'landscape', linkedin: 'landscape', facebook: 'landscape', youtube: 'thumbnail' };
    return (
      '<campaign_title>Yeni sezon lansmanı</campaign_title>\n' +
      platforms
        .map(
          (platform) =>
            `<post platform="${platform}" format="${format[platform] ?? 'portrait'}" generate_image="true">\n<title>Yeni sezon · ${platform}</title>\n<headline>Yeni sezon geldi</headline>\n<subline>Bu hafta tüm şubelerde</subline>\n<caption>${platform} için uyarlanmış deneme metni. Yeni sezon çekirdeklerimiz raflarda.</caption>\n<hashtags>#yenisezon #deneme</hashtags>\n<image_prompt>Editorial photo of a coffee cup on marble, calm lower third, no text.</image_prompt>\n</post>`,
        )
        .join('\n')
    );
  }
  if (system.includes('TASK:slides')) {
    const count = Number(lastUserText(request).match(/Slides wanted: (\d+)/)?.[1] ?? 5);
    return JSON.stringify(
      Array.from({ length: count }, (_, i) => ({
        headline: i === 0 ? 'Kahvenizi 3 adımda iyileştirin' : i === count - 1 ? 'Kaydedin, sonra deneyin' : `${i}. adım: deneme başlığı`,
        body: i === 0 ? '' : 'Kısa ve net bir açıklama cümlesi burada durur.',
      })),
    );
  }
  if (system.includes('TASK:insights')) {
    return JSON.stringify([
      { content: 'Perde arkası gönderileri ürün fotoğraflarından belirgin biçimde daha çok kaydediliyor.', category: 'fact' },
      { content: 'İlk cümlesi soru olan metinler daha çok yorum alıyor; açılışı soruyla kur.', category: 'rule' },
      { content: 'Akşam 19:00 sonrası paylaşımlar sabah paylaşımlarından daha geniş erişim alıyor.', category: 'fact' },
    ]);
  }
  if (system.includes('TASK:favorites')) {
    return JSON.stringify([
      { content: 'Sıcak, yandan gelen doğal ışık ve yumuşak gölgeler tercih ediliyor.', category: 'style' },
      { content: 'Kadrajda bolca boş alan bırakılıyor; kalabalık kompozisyonlardan kaçınılıyor.', category: 'preference' },
      { content: 'Doygun renkler yerine toprak tonları ve mat yüzeyler öne çıkıyor.', category: 'style' },
    ]);
  }
  if (system.includes('TASK:caption')) return 'Yeniden yazılmış deneme metni. Kısa, net, markanın sesiyle.';
  if (system.includes('TASK:hashtags')) return '#deneme #icerik #sosyalmedya #marka #yenisezon';
  if (system.includes('TASK:enhance')) return `${lastUserText(request).slice(0, 200)} — cinematic lighting, 85mm lens, shallow depth of field.`;
  return null;
}

export const createMock: AdapterFactory = () => {
  const adapter: Adapter = {
    async text(request: TextRequest): Promise<TextResult> {
      const reply = taskReply(request) ?? chatReply(request);
      if (request.onDelta) {
        for (let i = 0; i < reply.length; i += 14) {
          await sleep(22, request.signal);
          request.onDelta(reply.slice(i, i + 14));
        }
      } else {
        await sleep(150, request.signal);
      }
      return { text: reply, usage: { input: Math.round(request.system.length / 4), output: Math.round(reply.length / 4) } };
    },
    async image(request: ImageRequest): Promise<Media[]> {
      if (/hata ver/i.test(request.prompt)) throw new ProviderError('Deneme hatası: görsel üretilemedi.');
      request.onStage?.('Üretiliyor');
      await sleep(1100, request.signal);
      return Promise.all(Array.from({ length: request.count }, (_, index) => fakeImage(request, index)));
    },
    async videoStart(request: VideoRequest): Promise<VideoStart> {
      const id = `deneme-${Date.now()}`;
      videoJobs.set(id, { startedAt: Date.now(), request });
      return { externalId: id };
    },
    async videoPoll(externalId: string): Promise<VideoPoll> {
      const job = videoJobs.get(externalId);
      if (!job) return { status: 'failed', error: 'Deneme işi bulunamadı (sunucu yeniden başlamış olabilir).' };
      const elapsed = Date.now() - job.startedAt;
      if (elapsed < 3500) return { status: 'running', stage: 'Üretiliyor', progress: Math.min(0.95, elapsed / 3500) };
      videoJobs.delete(externalId);
      return { status: 'succeeded', media: await fakeVideo(job.request) };
    },
    async listModels() {
      return [{ id: 'mock-text-2', label: 'Deneme metin 2', kind: 'text' as const }];
    },
    async test() {
      return 'Deneme sağlayıcısı hazır.';
    },
  };
  return adapter;
};
