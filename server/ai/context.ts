import { findMentions } from '../../shared/handles.ts';
import { PLATFORMS, entityTypeLabel, ratioOf } from '../../shared/platforms.ts';
import type { ChatMode, Entity, Mention, Message, MessageOptions } from '../../shared/types.ts';
import { getJob } from '../repo/chat.ts';
import { getPost } from '../repo/content.ts';
import { entityAssets, getEntity, getEntityByHandle, listEntities, listMemories } from '../repo/entities.ts';
import { getSettings } from '../settings.ts';
import { getAssets } from '../storage.ts';

const DIRECTORY_LIMIT = 150;
const MEMORY_BUDGET = 9000;
const HISTORY_MESSAGES = 30;
const HISTORY_BUDGET = 28000;

export function resolveMentions(text: string): { mentions: Mention[]; entities: Entity[] } {
  const entities: Entity[] = [];
  const seen = new Set<string>();
  for (const token of findMentions(text)) {
    const entity = getEntityByHandle(token.handle);
    if (entity && !seen.has(entity.id)) {
      seen.add(entity.id);
      entities.push(entity);
    }
  }
  return { mentions: entities.map((e) => ({ entityId: e.id, handle: e.handle })), entities };
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function brandFacts(entity: Entity): string[] {
  const d = entity.data;
  const lines: string[] = [];
  if (d.tagline) lines.push(`Tagline: ${d.tagline}`);
  if (d.industry) lines.push(`Industry: ${d.industry}`);
  if (d.audience) lines.push(`Audience: ${d.audience}`);
  if (d.tone) lines.push(`Voice and tone: ${d.tone}`);
  if (d.values) lines.push(`Values: ${d.values}`);
  if (d.colors?.length) lines.push(`Palette: ${d.colors.map((c) => `${c.name || c.role} ${c.hex} (${c.role})`).join(', ')}`);
  if (d.fonts?.heading || d.fonts?.body) {
    lines.push(`Typography: ${[d.fonts.heading && `headings ${d.fonts.heading}`, d.fonts.body && `body ${d.fonts.body}`].filter(Boolean).join(', ')}`);
  }
  if (d.hashtags?.length) lines.push(`Signature hashtags: ${d.hashtags.join(' ')}`);
  if (d.emoji) lines.push(`Emoji use: ${d.emoji === 'none' ? 'never' : d.emoji === 'light' ? 'sparingly' : 'freely'}`);
  if (d.dos) lines.push(`Always: ${d.dos}`);
  if (d.donts) lines.push(`Never: ${d.donts}`);
  if (d.website) lines.push(`Website: ${d.website}`);
  return lines;
}

/** Bir varlığın modele verilecek tam dökümü. */
export function entityBrief(entity: Entity): string {
  const assets = entityAssets(entity.id);
  const logos = assets.filter((a) => a.role === 'logo').length;
  const refs = assets.length - logos;
  const lines = [`@${entity.handle} — ${entity.type} "${entity.name}"`];
  if (entity.data.role) lines.push(`Role: ${entity.data.role}`);
  if (entity.description) lines.push(`Notes: ${clip(entity.description, 700)}`);
  if (entity.profile) lines.push(`${entity.type === 'person' ? 'Appearance' : 'Profile'}: ${clip(entity.profile, 900)}`);
  if (entity.type === 'brand') lines.push(...brandFacts(entity));
  if (entity.type === 'product') {
    if (entity.data.category) lines.push(`Category: ${entity.data.category}`);
    if (entity.data.price) lines.push(`Price: ${entity.data.price}`);
  }
  const stored = [logos && `${logos} logo file${logos > 1 ? 's' : ''}`, refs && `${refs} reference image${refs > 1 ? 's' : ''}`]
    .filter(Boolean)
    .join(', ');
  lines.push(stored ? `Stored visuals: ${stored} (attached automatically when listed in refs)` : 'Stored visuals: none yet');
  const notes = listMemories({ entityId: entity.id, enabledOnly: true }).slice(0, 12);
  for (const note of notes) lines.push(`Remembered: ${clip(note.content, 300)}`);
  return lines.join('\n');
}

/** Sistem isteminin hafıza bölümü. Turlar arasında olabildiğince sabit kalır. */
export function memorySection(): string {
  const entities = listEntities().slice(0, DIRECTORY_LIMIT);
  const sections: string[] = [];

  if (entities.length) {
    const lines = entities.map((e) => {
      const summary = clip(e.data.tagline || e.data.role || e.description || e.profile || '', 110);
      return `- @${e.handle} — ${e.type} — ${e.name}${e.assetCount ? ` — ${e.assetCount} stored image${e.assetCount > 1 ? 's' : ''}` : ''}${summary ? ` — ${summary}` : ''}`;
    });
    sections.push(`### Saved entities (use the @handle)\n${lines.join('\n')}`);
  } else {
    sections.push('### Saved entities\nNone yet. If the user describes a person or brand they will reuse, suggest saving it under Hafıza so it stays consistent.');
  }

  const byId = new Map(entities.map((e) => [e.id, e]));
  const notes = listMemories({ enabledOnly: true });
  if (notes.length) {
    let used = 0;
    const lines: string[] = [];
    for (const note of notes) {
      const about = note.entityId && byId.get(note.entityId) ? ` (@${byId.get(note.entityId)!.handle})` : '';
      const line = `- [${note.category}]${about} ${clip(note.content, 400)}`;
      if (used + line.length > MEMORY_BUDGET) break;
      used += line.length;
      lines.push(line);
    }
    sections.push(`### What the team asked you to remember\n${lines.join('\n')}`);
  }

  const instructions = getSettings().customInstructions.trim();
  if (instructions) sections.push(`### Standing instructions from the team\n${instructions}`);
  return sections.join('\n\n');
}

export interface RequestContext {
  mode: ChatMode;
  options: MessageOptions;
  attachments: string[];
  entities: Entity[];
  brand: Entity | null;
}

/** Her kullanıcı mesajının başına eklenen, o isteğe özel bağlam. */
export function requestContext(ctx: RequestContext): string {
  const generation = getSettings().generation;
  const exact = ctx.options.width && ctx.options.height ? `${ctx.options.width}x${ctx.options.height}` : '';
  const attrs = [
    `mode="${ctx.mode}"`,
    `aspect="${exact ? ratioOf(ctx.options.width!, ctx.options.height!) : ctx.options.aspect ?? generation.aspect}"`,
    ...(exact ? [`size="${exact}"`] : []),
    `count="${ctx.options.count ?? generation.count}"`,
    `duration="${ctx.options.duration ?? generation.videoDuration}"`,
  ];
  const lines: string[] = [];
  const attachments = getAssets(ctx.attachments);
  if (attachments.length) {
    lines.push('Attachments (shown to you below, reference them as asset:ID):');
    for (const asset of attachments) {
      lines.push(`- asset:${asset.id} — ${asset.kind}${asset.width ? ` ${asset.width}×${asset.height}` : ''} "${asset.title ?? asset.filename}"`);
    }
  }
  if (ctx.entities.length) {
    lines.push('Mentioned in this message:');
    for (const entity of ctx.entities) lines.push(entityBrief(entity), '');
  }
  if (ctx.brand && !ctx.entities.some((e) => e.id === ctx.brand!.id)) {
    lines.push('Active brand for this conversation (apply it unless told otherwise):', entityBrief(ctx.brand), '');
  } else if (ctx.brand) {
    lines.push(`Active brand for this conversation: @${ctx.brand.handle}`);
  }
  return `<request_context ${attrs.join(' ')}>\n${lines.join('\n').trim()}\n</request_context>`;
}

/** Geçmiş bir asistan mesajını, eylemlerinin sonuçlarıyla birlikte düz metne çevirir. */
function assistantTranscript(message: Message): string {
  const chunks: string[] = [];
  for (const part of message.parts) {
    if (part.type === 'text') chunks.push(part.text);
    else if (part.type === 'job') {
      const job = getJob(part.jobId);
      if (!job) continue;
      const results = job.assetIds.map((id) => `asset:${id}`).join(', ');
      const state = job.status === 'succeeded' ? `results: ${results}` : job.status === 'failed' ? `failed: ${job.error}` : job.status;
      chunks.push(`[${job.type} generated with ${job.modelLabel} — prompt: "${clip(job.input.prompt, 500)}" — ${state}]`);
    } else if (part.type === 'post') {
      const post = getPost(part.postId);
      if (!post) continue;
      chunks.push(
        `[post ${post.id} saved — ${post.platform}/${post.format}${post.scheduledAt ? ` on ${post.scheduledAt.slice(0, 10)}` : ''} — "${post.title}" — caption: "${clip(post.caption, 300)}"${post.assetIds.length ? ` — visuals: ${post.assetIds.map((id) => `asset:${id}`).join(', ')}` : ''}]`,
      );
    } else if (part.type === 'memory') {
      chunks.push(`[remembered: ${part.content}]`);
    }
  }
  return chunks.join('\n').trim();
}

export interface HistoryTurn {
  role: 'user' | 'assistant';
  text: string;
}

/** Son mesajları, bütçeyi aşmayacak biçimde ve kullanıcı mesajıyla başlayacak şekilde döndürür. */
export function historyTurns(messages: Message[]): HistoryTurn[] {
  const turns: HistoryTurn[] = [];
  let used = 0;
  for (const message of [...messages].reverse().slice(0, HISTORY_MESSAGES)) {
    let text: string;
    if (message.role === 'user') {
      const attached = message.attachments.length ? `\n[attached: ${message.attachments.map((id) => `asset:${id}`).join(', ')}]` : '';
      text = `${message.content}${attached}`;
    } else {
      text = assistantTranscript(message) || (message.error ? `[failed: ${message.error}]` : '[no reply]');
    }
    if (used + text.length > HISTORY_BUDGET && turns.length) break;
    used += text.length;
    turns.unshift({ role: message.role, text });
  }
  while (turns.length && turns[0].role !== 'user') turns.shift();
  return turns;
}

export function activeBrand(brandId: string | null): Entity | null {
  if (!brandId) return null;
  const entity = getEntity(brandId);
  return entity && !entity.deletedAt ? entity : null;
}

/** Metin modeli olmadan, doğrudan görsel/video modeline gidecek istemi kurar. */
export function directPrompt(text: string, entities: Entity[], brand: Entity | null): string {
  let prompt = text;
  for (const token of findMentions(text).reverse()) {
    const entity = entities.find((e) => e.handle === token.handle);
    if (entity) prompt = prompt.slice(0, token.start) + entity.name + prompt.slice(token.end);
  }
  const extras: string[] = [];
  const all = brand && !entities.some((e) => e.id === brand.id) ? [...entities, brand] : entities;
  for (const entity of all) {
    if (entity.type === 'brand') {
      const facts = brandFacts(entity).filter((line) => /^(Palette|Typography|Voice)/.test(line));
      if (facts.length) extras.push(`${entity.name} brand — ${facts.join('. ')}`);
    } else if (entity.profile) {
      extras.push(`${entity.name}: ${clip(entity.profile, 400)}`);
    }
  }
  return extras.length ? `${prompt.trim()}\n\n${extras.join('\n')}` : prompt.trim();
}

/**
 * Gönderiyle saklanan görsel istemi: metnin sonuna referans kimlikleri eklenir
 * ("…istem…\n\n@yasin @acme"). Böylece kullanıcı düzenleyicide hangi kişi ve
 * markanın referans gideceğini görür, @ yazarak değiştirebilir.
 */
export function storedPrompt(text: string | undefined, refs: string | undefined): string {
  const prompt = (text ?? '').trim();
  if (!prompt) return '';
  const handles = (refs ?? '')
    .split(/[\s,;]+/)
    .filter((token) => token.startsWith('@') && getEntityByHandle(token))
    .map((token) => `@${getEntityByHandle(token)!.handle}`);
  return handles.length ? `${prompt}\n\n${[...new Set(handles)].join(' ')}` : prompt;
}

/** Saklanan istemi modele gidecek metne ve referans varlıklarına ayırır. */
export function splitStoredPrompt(stored: string, brand: Entity | null): { prompt: string; entities: Entity[] } {
  const { entities } = resolveMentions(stored);
  const body = stored.replace(/\n+\s*(?:@[\p{L}\p{N}_.-]+[\s,]*)+$/u, '').trim();
  return { prompt: directPrompt(body || stored, entities, brand), entities };
}

export function platformGuide(): string {
  return PLATFORMS.map(
    (p) => `${p.id}: ${p.formats.map((f) => `${f.id} (${f.aspect})`).join(' | ')}; caption up to ${p.captionLimit} characters`,
  ).join('\n');
}

export function typeLabel(entity: Entity): string {
  return entityTypeLabel(entity.type);
}
