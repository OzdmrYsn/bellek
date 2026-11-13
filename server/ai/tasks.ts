import { getFormat, getPlatform } from '../../shared/platforms.ts';
import type {
  BrandColor, Campaign, DetectedPerson, Entity, EntityData, MemoryCategory, MemorySuggestion, PlatformId, Post, Slide,
} from '../../shared/types.ts';
import { all, type Row } from '../db.ts';
import { createGenerationJob } from '../jobs.ts';
import { generateText } from '../providers/index.ts';
import { ProviderError, type ChatPart } from '../providers/types.ts';
import { cleanHashtags, createCampaign, createPost, getPost, listPosts, updatePost } from '../repo/content.ts';
import {
  Invalid, NotFound, entityAssets, getEntity, getEntityByHandle, linkAssets, updateEntity,
} from '../repo/entities.ts';
import { pickModel, pickUtilityModel, type Resolved } from '../settings.ts';
import { assetPayload, hydrateAssets, ingest } from '../storage.ts';
import { readSite } from '../web/site.ts';
import { extractActions, innerTag, looseJson, parseRefs } from './actions.ts';
import { entityBrief, splitStoredPrompt, storedPrompt } from './context.ts';
import {
  BRAND_PROMPT, DETECT_PROMPT, ENHANCE_PROMPT, FAVORITES_PROMPT, HASHTAG_PROMPT, INSIGHTS_PROMPT, SLIDES_PROMPT,
  campaignSystemPrompt, captionPrompt, planSystemPrompt, profilePrompt,
} from './prompts.ts';

function requireText(vision = false): Resolved {
  const model = pickModel('text');
  if (!model) {
    throw new ProviderError('Bu işlem için bağlı bir metin modeli gerekiyor. Ayarlar → Yapay zekâlar bölümünden bir anahtar ekleyin.');
  }
  if (vision && model.model.vision === false) {
    throw new ProviderError(`${model.model.label} görsel okuyamıyor. Ayarlar'dan görsel anlayabilen bir metin modeli seçin.`);
  }
  return model;
}

async function imageParts(assetIds: string[], maxEdge = 1280): Promise<ChatPart[]> {
  const parts: ChatPart[] = [];
  for (const id of assetIds) {
    try {
      parts.push({ type: 'image', ...(await assetPayload(id, maxEdge)) });
    } catch {
      // Okunamayan görsel atlanır.
    }
  }
  return parts;
}

/** Referans görsellerden görünüm / kimlik profili çıkarır ve varlığa kaydeder. */
export async function generateProfile(entityId: string): Promise<Entity> {
  const entity = getEntity(entityId);
  if (!entity) throw new NotFound('Varlık bulunamadı.');
  const images = entityAssets(entityId).filter((a) => a.kind === 'image').slice(0, 5);
  if (!images.length) throw new Invalid('Profil çıkarmak için önce en az bir görsel ekleyin.');
  const model = requireText(true);
  const result = await generateText(model, {
    system: profilePrompt(entity.type, entity.name),
    messages: [{
      role: 'user',
      content: [...(await imageParts(images.map((a) => a.id))), { type: 'text', text: `Reference images for ${entity.name}.` }],
    }],
    effort: 'low',
  });
  const profile = result.text.trim();
  if (!profile) throw new ProviderError('Model bir profil döndürmedi. Yeniden deneyin.');
  return updateEntity(entityId, { profile });
}

/** Bir fotoğraftaki kişileri bulur; kutular görsele göre 0–1 aralığındadır. */
export async function detectPeople(assetId: string): Promise<DetectedPerson[]> {
  const model = requireText(true);
  const result = await generateText(model, {
    system: DETECT_PROMPT,
    messages: [{ role: 'user', content: [...(await imageParts([assetId], 1568)), { type: 'text', text: 'Find the people.' }] }],
    effort: 'low',
  });
  const items = looseJson<{ label?: string; box?: number[]; box_2d?: number[] }[]>(result.text);
  if (!Array.isArray(items)) return [];
  const clamp = (n: number) => Math.min(1, Math.max(0, n));
  return items
    .map((item, index) => {
      const box = item.box ?? item.box_2d;
      if (!Array.isArray(box) || box.length !== 4 || box.some((n) => typeof n !== 'number')) return null;
      const [ymin, xmin, ymax, xmax] = box.map((n) => clamp(n / 1000));
      if (xmax - xmin < 0.02 || ymax - ymin < 0.02) return null;
      return { label: String(item.label ?? `Kişi ${index + 1}`), x: xmin, y: ymin, w: xmax - xmin, h: ymax - ymin };
    })
    .filter((item): item is DetectedPerson => !!item);
}

const COLOR_ROLES: BrandColor['role'][] = ['primary', 'secondary', 'accent', 'neutral', 'background', 'text'];

/** Yapıştırılan metinden ve logodan marka kimliğini çıkarır; boş alanları doldurur. */
export async function extractBrand(entityId: string, material: string): Promise<Entity> {
  const entity = getEntity(entityId);
  if (!entity) throw new NotFound('Marka bulunamadı.');
  const images = entityAssets(entityId).filter((a) => a.kind === 'image').slice(0, 4);
  if (!material.trim() && !images.length) throw new Invalid('Markayı anlatan bir metin yapıştırın ya da bir logo ekleyin.');
  const model = requireText(images.length > 0);
  const result = await generateText(model, {
    system: BRAND_PROMPT,
    messages: [{
      role: 'user',
      content: [
        ...(await imageParts(images.map((a) => a.id))),
        { type: 'text', text: `Brand: ${entity.name}\n\nMaterial:\n${material.trim().slice(0, 20000) || '(only the attached visuals)'}` },
      ],
    }],
    effort: 'medium',
  });
  const parsed = looseJson<Record<string, unknown>>(result.text);
  if (!parsed) throw new ProviderError('Model marka bilgilerini okunabilir biçimde döndürmedi. Yeniden deneyin.');

  const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
  const colors = Array.isArray(parsed.colors)
    ? (parsed.colors as Record<string, unknown>[])
        .map((c) => ({
          name: text(c.name) ?? '',
          hex: (text(c.hex) ?? '').toUpperCase(),
          role: COLOR_ROLES.includes(c.role as BrandColor['role']) ? (c.role as BrandColor['role']) : 'accent',
        }))
        .filter((c) => /^#[0-9A-F]{6}$/.test(c.hex))
    : [];
  const fonts = parsed.fonts as { heading?: unknown; body?: unknown } | undefined;
  const patch: EntityData = {};
  const current = entity.data;
  // Kullanıcının elle girdiği alanların üzerine yazılmaz.
  for (const key of ['tagline', 'industry', 'audience', 'tone', 'values', 'dos', 'donts', 'website'] as const) {
    const value = text(parsed[key]);
    if (value && !current[key]) patch[key] = value;
  }
  if (colors.length && !current.colors?.length) patch.colors = colors.slice(0, 8);
  if (Array.isArray(parsed.hashtags) && !current.hashtags?.length) patch.hashtags = cleanHashtags(parsed.hashtags);
  if (fonts && !current.fonts?.heading && !current.fonts?.body) {
    patch.fonts = { heading: text(fonts.heading), body: text(fonts.body) };
  }
  return updateEntity(entityId, { data: patch });
}

function postContext(post: Post): string {
  const platform = getPlatform(post.platform);
  const brand = post.brandId ? getEntity(post.brandId) : undefined;
  return [
    `Platform: ${platform.label} (caption limit ${platform.captionLimit} characters, about ${platform.hashtagLimit} hashtags at most)`,
    post.title && `Working title: ${post.title}`,
    brand && `Brand:\n${entityBrief(brand)}`,
    post.notes && `Team notes: ${post.notes}`,
  ].filter(Boolean).join('\n');
}

export async function rewriteCaption(postId: string, instruction: string, draft?: string): Promise<string> {
  const post = getPost(postId);
  if (!post) throw new NotFound('Gönderi bulunamadı.');
  const model = requireText();
  const caption = draft ?? post.caption;
  const result = await generateText(model, {
    system: captionPrompt(instruction.trim() || 'Tighten it and make the first line stronger.'),
    messages: [{
      role: 'user',
      content: [{ type: 'text', text: `${postContext(post)}\n\nCurrent caption:\n${caption || '(empty — write one from the title and brand)'}` }],
    }],
    effort: 'medium',
  });
  const text = result.text.trim();
  if (!text) throw new ProviderError('Model bir metin döndürmedi. Yeniden deneyin.');
  return text;
}

export async function suggestHashtags(postId: string, draft?: string): Promise<string[]> {
  const post = getPost(postId);
  if (!post) throw new NotFound('Gönderi bulunamadı.');
  const model = pickUtilityModel() ?? requireText();
  const result = await generateText(model, {
    system: HASHTAG_PROMPT,
    messages: [{ role: 'user', content: [{ type: 'text', text: `${postContext(post)}\n\nCaption:\n${draft ?? post.caption}` }] }],
    effort: 'low',
  });
  return cleanHashtags(result.text).slice(0, getPlatform(post.platform).hashtagLimit);
}

export async function enhancePrompt(idea: string, entityIds: string[]): Promise<string> {
  const model = requireText();
  const briefs = entityIds.map((id) => getEntity(id)).filter((e): e is Entity => !!e).map(entityBrief);
  const result = await generateText(model, {
    system: ENHANCE_PROMPT,
    messages: [{ role: 'user', content: [{ type: 'text', text: `${briefs.length ? `Entities:\n${briefs.join('\n\n')}\n\n` : ''}Idea:\n${idea}` }] }],
    effort: 'low',
  });
  return result.text.trim() || idea;
}

export interface PlanInput {
  brandId?: string | null;
  from: string;
  to: string;
  count: number;
  platforms: string[];
  brief: string;
  generateImages?: boolean;
}

/** Tarih aralığı için içerik planı yazar ve gönderileri takvime kaydeder. */
export async function planPosts(input: PlanInput): Promise<Post[]> {
  const model = requireText();
  const brand = input.brandId ? getEntity(input.brandId) : undefined;
  const count = Math.min(31, Math.max(1, Math.round(input.count || 5)));
  const platforms = input.platforms.length ? input.platforms.map((p) => getPlatform(p).id) : ['instagram'];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.from) || !/^\d{4}-\d{2}-\d{2}$/.test(input.to) || input.from > input.to) {
    throw new Invalid('Geçerli bir tarih aralığı seçin.');
  }
  const request = [
    `Plan ${count} posts between ${input.from} and ${input.to} (inclusive), spread sensibly across the range.`,
    `Platforms to use: ${platforms.join(', ')}.`,
    brand ? `Brand:\n${entityBrief(brand)}` : 'No brand selected; write in a neutral, friendly voice.',
    input.brief.trim() ? `Brief from the team:\n${input.brief.trim()}` : 'No brief given: propose a balanced mix that fits the brand.',
  ].join('\n\n');

  const result = await generateText(model, {
    system: planSystemPrompt(),
    messages: [{ role: 'user', content: [{ type: 'text', text: request }] }],
    effort: 'medium',
  });

  const posts: Post[] = [];
  for (const action of extractActions(result.text)) {
    if (action.tag !== 'post') continue;
    const platform = getPlatform(action.attrs.platform ?? platforms[0]);
    const format = getFormat(platform.id, action.attrs.format ?? '');
    const image = innerTag(action.body, 'image_prompt');
    const post = createPost({
      brandId: brand?.id ?? null,
      title: innerTag(action.body, 'title')?.text ?? '',
      platform: platform.id,
      format: format.id,
      caption: innerTag(action.body, 'caption')?.text ?? '',
      hashtags: innerTag(action.body, 'hashtags')?.text ?? '',
      imagePrompt: storedPrompt(image?.text, image?.attrs.refs),
      scheduledAt: action.attrs.date ?? null,
    });
    posts.push(post);
    if (input.generateImages && image?.text) {
      const tokens = parseRefs(image.attrs.refs);
      const entityIds = tokens.handles.map((h) => getEntityByHandle(h)?.id).filter((id): id is string => !!id);
      if (brand && !entityIds.includes(brand.id)) entityIds.push(brand.id);
      try {
        createGenerationJob({
          type: 'image', prompt: image.text, userPrompt: post.title, width: format.width, height: format.height, count: 1, entityIds, postId: post.id,
        });
      } catch {
        // Görsel modeli yoksa plan yine de kaydedilir; görseller sonra üretilebilir.
      }
    }
  }
  if (!posts.length) throw new ProviderError('Model bir plan döndürmedi. Brifi biraz daha açıp yeniden deneyin.');
  return posts;
}

/** Kayıtlı bir gönderinin görselini, saklanan istemden üretir. */
export function generatePostImage(postId: string, options: { prompt?: string; modelRef?: string | null; count?: number } = {}) {
  const post = getPost(postId);
  if (!post) throw new NotFound('Gönderi bulunamadı.');
  const stored = (options.prompt ?? post.imagePrompt).trim();
  if (!stored) throw new Invalid('Önce görsel için bir istem yazın.');
  const format = getFormat(post.platform, post.format);
  const brand = post.brandId ? getEntity(post.brandId) ?? null : null;
  // İstemde @ ile anılan kişi ve markaların referans görselleri eklenir; markanın
  // paleti ise her durumda metne işlenir.
  const { prompt, entities } = splitStoredPrompt(stored, brand);
  return createGenerationJob({
    type: 'image',
    prompt,
    userPrompt: post.title || post.caption.slice(0, 80),
    width: format.width,
    height: format.height,
    count: options.count ?? 1,
    entityIds: entities.map((e) => e.id),
    modelRef: options.modelRef,
    postId: post.id,
    conversationId: post.conversationId,
  }).job;
}

// ───────────────────────── Kampanya paketi ─────────────────────────

export interface CampaignInput {
  brandId?: string | null;
  brief: string;
  platforms: string[];
  generateImages?: boolean;
  /** Görseller hazır olunca uygulanacak tasarım düzeni; boşsa uygulanmaz. */
  template?: string;
  date?: string | null;
}

/** Tek briften, her platforma uyarlanmış gönderilerden oluşan bir paket çıkarır. */
export async function createCampaignPack(input: CampaignInput): Promise<{ campaign: Campaign; posts: Post[] }> {
  const brief = input.brief.trim();
  if (!brief) throw new Invalid('Kampanyayı birkaç cümleyle anlatın.');
  const platforms = [...new Set(input.platforms.map((p) => getPlatform(p).id))] as PlatformId[];
  if (!platforms.length) throw new Invalid('En az bir platform seçin.');
  const model = requireText();
  const brand = input.brandId ? getEntity(input.brandId) : undefined;
  const overlay = !!input.template;

  const result = await generateText(model, {
    system: campaignSystemPrompt(overlay),
    messages: [{
      role: 'user',
      content: [{
        type: 'text',
        text: [
          `Platforms: ${platforms.join(', ')}.`,
          brand ? `Brand:\n${entityBrief(brand)}` : 'No brand selected; write in a neutral, friendly voice.',
          `Brief from the team:\n${brief}`,
        ].join('\n\n'),
      }],
    }],
    effort: 'medium',
  });

  const title = result.text.match(/<campaign_title>([\s\S]*?)<\/campaign_title>/)?.[1]?.trim() || brief.split(/[.!?\n]/)[0].slice(0, 60);
  const actions = extractActions(result.text).filter((a) => a.tag === 'post');
  if (!actions.length) throw new ProviderError('Model bir kampanya döndürmedi. Brifi biraz daha açıp yeniden deneyin.');

  const campaign = createCampaign({ brandId: brand?.id ?? null, title, brief, platforms, template: input.template });
  const posts: Post[] = [];
  const seen = new Set<string>();
  for (const action of actions) {
    const platform = getPlatform(action.attrs.platform ?? platforms[0]);
    if (!platforms.includes(platform.id) || seen.has(platform.id)) continue;
    seen.add(platform.id);
    const format = getFormat(platform.id, action.attrs.format ?? '');
    const image = innerTag(action.body, 'image_prompt');
    const post = createPost({
      brandId: brand?.id ?? null,
      campaignId: campaign.id,
      title: innerTag(action.body, 'title')?.text ?? title,
      platform: platform.id,
      format: format.id,
      caption: innerTag(action.body, 'caption')?.text ?? '',
      hashtags: innerTag(action.body, 'hashtags')?.text ?? '',
      imagePrompt: storedPrompt(image?.text, image?.attrs.refs),
      scheduledAt: input.date ?? null,
      data: { headline: innerTag(action.body, 'headline')?.text ?? '', subline: innerTag(action.body, 'subline')?.text ?? '' },
    });
    posts.push(post);
    if (input.generateImages !== false && image?.text) {
      const tokens = parseRefs(image.attrs.refs);
      const entityIds = tokens.handles.map((h) => getEntityByHandle(h)?.id).filter((id): id is string => !!id);
      // Düzen uygulanacaksa logo sonradan, kendi dosyasından yerleştirilir; modele gönderilmez.
      const refs = overlay ? entityIds.filter((id) => getEntity(id)?.type !== 'brand') : entityIds;
      try {
        createGenerationJob({
          type: 'image', prompt: image.text, userPrompt: post.title, width: format.width, height: format.height, count: 1,
          entityIds: refs, postId: post.id,
        });
      } catch {
        // Görsel modeli yoksa metinler yine de kaydedilir.
      }
    }
  }
  return { campaign: { ...campaign, postCount: posts.length }, posts };
}

// ───────────────────────── Kaydırmalı gönderi ─────────────────────────

export async function writeSlides(postId: string, count: number, topic: string): Promise<Post> {
  const post = getPost(postId);
  if (!post) throw new NotFound('Gönderi bulunamadı.');
  const model = requireText();
  const total = Math.min(10, Math.max(3, Math.round(count || 5)));
  const result = await generateText(model, {
    system: SLIDES_PROMPT,
    messages: [{
      role: 'user',
      content: [{
        type: 'text',
        text: `${postContext(post)}\n\nSlides wanted: ${total}\nTopic: ${topic.trim() || post.title || post.caption.slice(0, 300) || '(decide from the brand)'}\n${post.caption ? `Caption that will accompany it:\n${post.caption}` : ''}`,
      }],
    }],
    effort: 'medium',
  });
  const parsed = looseJson<{ headline?: unknown; body?: unknown }[]>(result.text);
  const slides: Slide[] = (Array.isArray(parsed) ? parsed : [])
    .map((item) => ({ headline: String(item?.headline ?? '').trim(), body: String(item?.body ?? '').trim() }))
    .filter((slide) => slide.headline || slide.body)
    .slice(0, 10);
  if (slides.length < 2) throw new ProviderError('Model kareleri okunabilir biçimde döndürmedi. Yeniden deneyin.');
  return updatePost(postId, { data: { slides } });
}

// ───────────────────────── Hafıza önerileri ─────────────────────────

const CATEGORIES: MemoryCategory[] = ['fact', 'preference', 'style', 'rule'];

function suggestions(text: string, fallback: MemoryCategory): MemorySuggestion[] {
  const parsed = looseJson<{ content?: unknown; category?: unknown }[]>(text);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((item) => ({
      content: String(item?.content ?? '').replace(/\s+/g, ' ').trim(),
      category: CATEGORIES.includes(item?.category as MemoryCategory) ? (item.category as MemoryCategory) : fallback,
    }))
    .filter((item) => item.content.length > 8)
    .slice(0, 6);
}

/** Sonuçları girilmiş gönderilerden, sonraki içerikleri yönlendirecek dersler çıkarır. */
export async function postInsights(brandId?: string | null): Promise<MemorySuggestion[]> {
  const posts = listPosts({ brandId: brandId || undefined }).filter((post) => Object.keys(post.data.metrics ?? {}).length > 0);
  if (posts.length < 3) throw new Invalid('İçgörü çıkarmak için sonuçları girilmiş en az üç gönderi gerekiyor.');
  const model = requireText();
  const brand = brandId ? getEntity(brandId) : undefined;
  const lines = posts.slice(0, 40).map((post) => {
    const m = post.data.metrics ?? {};
    const numbers = Object.entries(m).map(([key, value]) => `${key}=${value}`).join(' ');
    return `- [${post.platform}/${post.format}${post.scheduledAt ? ` ${post.scheduledAt.slice(0, 16)}` : ''}] ${numbers}\n  title: ${post.title}\n  caption: ${post.caption.replace(/\s+/g, ' ').slice(0, 400)}`;
  });
  const result = await generateText(model, {
    system: INSIGHTS_PROMPT,
    messages: [{ role: 'user', content: [{ type: 'text', text: `${brand ? `Brand:\n${entityBrief(brand)}\n\n` : ''}Posts and results:\n${lines.join('\n')}` }] }],
    effort: 'medium',
  });
  return suggestions(result.text, 'fact');
}

/** Favorilenen üretimlerden ekibin kalıcı görsel zevkini çıkarır. */
export async function learnFromFavorites(): Promise<MemorySuggestion[]> {
  const rows = all<Row>(
    `SELECT * FROM assets WHERE favorite = 1 AND deleted_at IS NULL AND kind = 'image' ORDER BY created_at DESC LIMIT 10`,
  );
  if (rows.length < 3) throw new Invalid('Zevkinizi öğrenebilmem için en az üç görseli favorileyin.');
  const model = requireText(true);
  const assets = hydrateAssets(rows);
  const content: ChatPart[] = [];
  for (const [index, asset] of assets.entries()) {
    content.push({ type: 'text', text: `Favourite ${index + 1}${asset.prompt ? ` — request: ${asset.prompt.slice(0, 300)}` : ''}` });
    content.push(...(await imageParts([asset.id], 896)));
  }
  content.push({ type: 'text', text: 'What do these have in common?' });
  const result = await generateText(model, { system: FAVORITES_PROMPT, messages: [{ role: 'user', content }], effort: 'medium' });
  return suggestions(result.text, 'style');
}

// ───────────────────────── Web sitesinden marka ─────────────────────────

export interface SiteImport {
  entity: Entity;
  summary: { logo: boolean; colors: number; fonts: string[]; analyzed: boolean };
}

/** Markanın sitesinden logo, renk, yazı tipi ve tanıtım metnini çekip boş alanları doldurur. */
export async function importBrandSite(entityId: string, url: string): Promise<SiteImport> {
  const entity = getEntity(entityId);
  if (!entity) throw new NotFound('Marka bulunamadı.');
  const site = await readSite(url);
  const patch: EntityData = {};
  if (!entity.data.website) patch.website = site.url.replace(/^https?:\/\//, '');
  if (!entity.data.colors?.length && site.colors.length) patch.colors = site.colors;
  if (!entity.data.fonts?.heading && !entity.data.fonts?.body && site.fonts.length) {
    patch.fonts = { heading: site.fonts[0], body: site.fonts[1] ?? site.fonts[0] };
  }
  if (!entity.data.tagline && site.description && site.description.length <= 90) patch.tagline = site.description;
  if (Object.keys(patch).length) updateEntity(entityId, { data: patch });

  let logo = false;
  if (site.logo && !entityAssets(entityId).some((a) => a.role === 'logo')) {
    try {
      const asset = await ingest({ data: site.logo.data, filename: site.logo.filename, source: 'upload', title: `${entity.name} logosu` });
      linkAssets(entityId, [asset.id], 'logo');
      logo = true;
    } catch {
      // Logo biçimi desteklenmiyorsa atlanır.
    }
  }

  // Ses tonu ve hedef kitle gibi yorum gerektiren alanlar için sayfa metnini modele okut.
  let analyzed = false;
  const material = [site.title, site.description, site.text].filter(Boolean).join('\n\n');
  if (pickModel('text') && material.length > 80) {
    try {
      await extractBrand(entityId, material);
      analyzed = true;
    } catch {
      // Model yoksa ya da yanıt veremezse okunabilen alanlar yine de kaydedilmiştir.
    }
  }
  return { entity: getEntity(entityId)!, summary: { logo, colors: patch.colors?.length ?? 0, fonts: site.fonts, analyzed } };
}
