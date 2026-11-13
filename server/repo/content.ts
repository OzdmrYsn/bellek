import { foldText } from '../../shared/handles.ts';
import { getFormat, getPlatform } from '../../shared/platforms.ts';
import crypto from 'node:crypto';
import type {
  Campaign, Design, DesignDoc, PlatformId, Post, PostData, PostReview, PostStatus, ReviewStatus, ReviewView,
  SearchResult, TrashItem,
} from '../../shared/types.ts';
import { all, get, newId, now, parseJson, run, type Row } from '../db.ts';
import { emit } from '../events.ts';
import { getAssets } from '../storage.ts';
import { Invalid, NotFound } from './entities.ts';

const STATUSES: PostStatus[] = ['idea', 'draft', 'scheduled', 'published'];

// ───────────────────────── Gönderiler ─────────────────────────

function toReview(row: Row): PostReview {
  return {
    token: String(row.token),
    status: row.status as ReviewStatus,
    reviewer: String(row.reviewer ?? ''),
    comment: String(row.comment ?? ''),
    createdAt: String(row.created_at),
    decidedAt: (row.decided_at as string | null) ?? null,
  };
}

function reviewsFor(postIds: string[]): Map<string, PostReview> {
  const map = new Map<string, PostReview>();
  if (!postIds.length) return map;
  const rows = all<Row>(
    `SELECT * FROM reviews WHERE post_id IN (${postIds.map(() => '?').join(',')}) ORDER BY created_at`,
    ...postIds,
  );
  // Gönderi başına en son bağlantı geçerlidir.
  for (const row of rows) map.set(String(row.post_id), toReview(row));
  return map;
}

function hydratePosts(rows: Row[]): Post[] {
  const reviews = reviewsFor(rows.map((r) => String(r.id)));
  return rows.map((row) => toPost(row, reviews.get(String(row.id)) ?? null));
}

function toPost(row: Row, review: PostReview | null): Post {
  const assetIds = parseJson<string[]>(row.asset_ids, []);
  return {
    id: String(row.id),
    brandId: (row.brand_id as string | null) ?? null,
    campaignId: (row.campaign_id as string | null) ?? null,
    data: parseJson<PostData>(row.data, {}),
    review,
    title: String(row.title ?? ''),
    platform: row.platform as PlatformId,
    format: String(row.format),
    caption: String(row.caption ?? ''),
    hashtags: parseJson<string[]>(row.hashtags, []),
    assetIds,
    assets: getAssets(assetIds).filter((a) => !a.deletedAt),
    imagePrompt: String(row.image_prompt ?? ''),
    status: row.status as PostStatus,
    scheduledAt: (row.scheduled_at as string | null) ?? null,
    notes: String(row.notes ?? ''),
    designId: (row.design_id as string | null) ?? null,
    conversationId: (row.conversation_id as string | null) ?? null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    deletedAt: (row.deleted_at as string | null) ?? null,
  };
}

export function listPosts(filter: { from?: string; to?: string; brandId?: string; status?: string; campaignId?: string } = {}): Post[] {
  const where = ['deleted_at IS NULL'];
  const params: unknown[] = [];
  if (filter.campaignId) {
    where.push('campaign_id = ?');
    params.push(filter.campaignId);
  }
  if (filter.brandId) {
    where.push('brand_id = ?');
    params.push(filter.brandId);
  }
  if (filter.status) {
    where.push('status = ?');
    params.push(filter.status);
  }
  if (filter.from) {
    where.push('scheduled_at >= ?');
    params.push(filter.from);
  }
  if (filter.to) {
    where.push('scheduled_at < ?');
    params.push(filter.to);
  }
  return hydratePosts(
    all<Row>(
      `SELECT * FROM posts WHERE ${where.join(' AND ')} ORDER BY COALESCE(scheduled_at, updated_at) DESC LIMIT 1000`,
      ...params,
    ),
  );
}

export function getPost(id: string): Post | undefined {
  const row = get<Row>(`SELECT * FROM posts WHERE id = ?`, id);
  return row ? hydratePosts([row])[0] : undefined;
}

export function getPosts(ids: string[]): Post[] {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return [];
  return hydratePosts(all<Row>(`SELECT * FROM posts WHERE id IN (${unique.map(() => '?').join(',')})`, ...unique));
}

export function cleanHashtags(input: unknown): string[] {
  const raw = Array.isArray(input) ? input.join(' ') : String(input ?? '');
  const tags = raw
    .split(/[\s,]+/)
    .map((tag) => tag.trim().replace(/^#+/, '').replace(/[^\p{L}\p{N}_]/gu, ''))
    .filter(Boolean)
    .map((tag) => `#${tag}`);
  return [...new Set(tags)].slice(0, 30);
}

export interface PostInput {
  brandId?: string | null;
  title?: string;
  platform?: string;
  format?: string;
  caption?: string;
  hashtags?: unknown;
  assetIds?: string[];
  imagePrompt?: string;
  status?: string;
  scheduledAt?: string | null;
  notes?: string;
  designId?: string | null;
  conversationId?: string | null;
  campaignId?: string | null;
  /** Verilen alanlar var olanlarla birleştirilir. */
  data?: PostData;
}

function cleanData(data: PostData | undefined, base: PostData = {}): PostData {
  if (!data) return base;
  const next: PostData = { ...base };
  if (data.headline !== undefined) next.headline = String(data.headline).slice(0, 200);
  if (data.subline !== undefined) next.subline = String(data.subline).slice(0, 300);
  if (data.slides !== undefined) {
    next.slides = (Array.isArray(data.slides) ? data.slides : [])
      .slice(0, 12)
      .map((slide) => ({ headline: String(slide?.headline ?? '').slice(0, 200), body: String(slide?.body ?? '').slice(0, 600) }));
  }
  if (data.metrics !== undefined) {
    const metrics: PostData['metrics'] = {};
    for (const key of ['reach', 'likes', 'comments', 'saves', 'shares', 'clicks'] as const) {
      const value = Number(data.metrics?.[key]);
      if (Number.isFinite(value) && value >= 0 && data.metrics?.[key] !== undefined && String(data.metrics[key]) !== '') metrics[key] = Math.round(value);
    }
    next.metrics = metrics;
  }
  return next;
}

function normalizeDate(value: string | null | undefined): string | null {
  if (!value) return null;
  // Yalnızca tarih verilmişse öğlen 10:00 varsayılır; takvimde gün kaymasın.
  const text = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T10:00:00` : value;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function createPost(input: PostInput): Post {
  const platform = getPlatform(input.platform ?? 'instagram');
  const format = getFormat(platform.id, input.format ?? '');
  const scheduledAt = normalizeDate(input.scheduledAt);
  const status = STATUSES.includes(input.status as PostStatus)
    ? (input.status as PostStatus)
    : scheduledAt ? 'scheduled' : 'draft';
  const id = newId('po');
  const stamp = now();
  run(
    `INSERT INTO posts (id, brand_id, title, platform, format, caption, hashtags, asset_ids, image_prompt, status,
       scheduled_at, notes, design_id, conversation_id, campaign_id, data, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, input.brandId ?? null, (input.title ?? '').trim().slice(0, 160), platform.id, format.id,
    input.caption ?? '', JSON.stringify(cleanHashtags(input.hashtags)), JSON.stringify(input.assetIds ?? []),
    input.imagePrompt ?? '', status, scheduledAt, input.notes ?? '', input.designId ?? null,
    input.conversationId ?? null, input.campaignId ?? null, JSON.stringify(cleanData(input.data)), stamp, stamp,
  );
  const post = getPost(id)!;
  emit({ type: 'post.updated', post });
  return post;
}

export function updatePost(id: string, patch: PostInput): Post {
  const row = get<Row>(`SELECT * FROM posts WHERE id = ?`, id);
  if (!row) throw new NotFound('Gönderi bulunamadı.');
  const platformId = patch.platform !== undefined ? getPlatform(patch.platform).id : String(row.platform);
  const formatId =
    patch.format !== undefined || patch.platform !== undefined
      ? getFormat(platformId, patch.format ?? String(row.format)).id
      : String(row.format);
  const scheduledAt = patch.scheduledAt !== undefined ? normalizeDate(patch.scheduledAt) : (row.scheduled_at as string | null);
  let status = STATUSES.includes(patch.status as PostStatus) ? (patch.status as PostStatus) : (row.status as PostStatus);
  // Tarih verilince taslak "planlandı"ya, tarih kaldırılınca "taslak"a döner.
  if (patch.status === undefined && patch.scheduledAt !== undefined) {
    if (scheduledAt && (status === 'draft' || status === 'idea')) status = 'scheduled';
    if (!scheduledAt && status === 'scheduled') status = 'draft';
  }
  run(
    `UPDATE posts SET brand_id = ?, title = ?, platform = ?, format = ?, caption = ?, hashtags = ?, asset_ids = ?,
            image_prompt = ?, status = ?, scheduled_at = ?, notes = ?, design_id = ?, data = ?, updated_at = ? WHERE id = ?`,
    patch.brandId !== undefined ? patch.brandId : row.brand_id,
    patch.title !== undefined ? patch.title.trim().slice(0, 160) : row.title,
    platformId, formatId,
    patch.caption !== undefined ? patch.caption : row.caption,
    patch.hashtags !== undefined ? JSON.stringify(cleanHashtags(patch.hashtags)) : row.hashtags,
    patch.assetIds !== undefined ? JSON.stringify([...new Set(patch.assetIds)]) : row.asset_ids,
    patch.imagePrompt !== undefined ? patch.imagePrompt : row.image_prompt,
    status, scheduledAt,
    patch.notes !== undefined ? patch.notes : row.notes,
    patch.designId !== undefined ? patch.designId : row.design_id,
    patch.data !== undefined ? JSON.stringify(cleanData(patch.data, parseJson<PostData>(row.data, {}))) : row.data,
    now(), id,
  );
  const post = getPost(id)!;
  emit({ type: 'post.updated', post });
  return post;
}

// ───────────────────────── Kampanyalar ─────────────────────────

function toCampaign(row: Row): Campaign {
  const data = parseJson<{ platforms?: PlatformId[]; template?: string }>(row.data, {});
  return {
    id: String(row.id),
    brandId: (row.brand_id as string | null) ?? null,
    title: String(row.title ?? ''),
    brief: String(row.brief ?? ''),
    platforms: data.platforms ?? [],
    template: data.template ?? '',
    postCount: Number(row.post_count ?? 0),
    createdAt: String(row.created_at),
  };
}

const CAMPAIGN_SELECT = `SELECT c.*, (SELECT COUNT(*) FROM posts p WHERE p.campaign_id = c.id AND p.deleted_at IS NULL) AS post_count FROM campaigns c`;

export function listCampaigns(): Campaign[] {
  return all<Row>(`${CAMPAIGN_SELECT} WHERE c.deleted_at IS NULL ORDER BY c.created_at DESC LIMIT 200`).map(toCampaign);
}

export function getCampaign(id: string): Campaign | undefined {
  const row = get<Row>(`${CAMPAIGN_SELECT} WHERE c.id = ?`, id);
  return row ? toCampaign(row) : undefined;
}

export function createCampaign(input: { brandId?: string | null; title: string; brief: string; platforms: PlatformId[]; template?: string }): Campaign {
  const id = newId('cm');
  run(
    `INSERT INTO campaigns (id, brand_id, title, brief, data, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    id, input.brandId ?? null, input.title.trim().slice(0, 160), input.brief.trim(),
    JSON.stringify({ platforms: input.platforms, template: input.template ?? '' }), now(),
  );
  return getCampaign(id)!;
}

export function renameCampaign(id: string, title: string): Campaign | undefined {
  run(`UPDATE campaigns SET title = ? WHERE id = ?`, title.trim().slice(0, 160), id);
  return getCampaign(id);
}

// ───────────────────────── Onay bağlantıları ─────────────────────────

/** Gönderi için onay bağlantısı açar; bekleyen bir tane varsa onu döndürür. */
export function openReview(postId: string): Post {
  if (!get<Row>(`SELECT id FROM posts WHERE id = ? AND deleted_at IS NULL`, postId)) throw new NotFound('Gönderi bulunamadı.');
  const pending = get<Row>(`SELECT token FROM reviews WHERE post_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1`, postId);
  if (!pending) {
    run(
      `INSERT INTO reviews (token, post_id, created_at) VALUES (?, ?, ?)`,
      crypto.randomBytes(18).toString('base64url'), postId, now(),
    );
  }
  const post = getPost(postId)!;
  emit({ type: 'post.updated', post });
  return post;
}

export function closeReview(postId: string): Post {
  run(`DELETE FROM reviews WHERE post_id = ?`, postId);
  const post = getPost(postId);
  if (!post) throw new NotFound('Gönderi bulunamadı.');
  emit({ type: 'post.updated', post });
  return post;
}

function reviewRow(token: string): Row {
  const row = /^[\w-]{16,40}$/.test(token) ? get<Row>(`SELECT * FROM reviews WHERE token = ?`, token) : undefined;
  if (!row) throw new NotFound('Bu onay bağlantısı geçerli değil ya da kaldırılmış.');
  return row;
}

export function reviewView(token: string): ReviewView {
  const row = reviewRow(token);
  const post = getPost(String(row.post_id));
  if (!post || post.deletedAt) throw new NotFound('Bu gönderi artık yok.');
  const brand = post.brandId ? get<{ name: string }>(`SELECT name FROM entities WHERE id = ? AND deleted_at IS NULL`, post.brandId) : undefined;
  return {
    review: toReview(row),
    post: {
      title: post.title,
      platform: post.platform,
      format: post.format,
      caption: post.caption,
      hashtags: post.hashtags,
      scheduledAt: post.scheduledAt,
      // Medya, oturum gerektirmeyen ve yalnızca bu gönderiyle sınırlı bir yoldan sunulur.
      media: post.assets.map((asset) => ({ url: `/api/review/${token}/media/${asset.id}`, kind: asset.kind })),
    },
    brandName: brand?.name ?? null,
  };
}

/** Onay bağlantısıyla erişilebilecek medya: yalnızca o gönderinin dosyaları. */
export function reviewAsset(token: string, assetId: string): string {
  const row = reviewRow(token);
  const post = getPost(String(row.post_id));
  if (!post || !post.assetIds.includes(assetId)) throw new NotFound('Dosya bulunamadı.');
  return assetId;
}

export function decideReview(token: string, input: { status?: string; reviewer?: string; comment?: string }): ReviewView {
  const row = reviewRow(token);
  const status: ReviewStatus = input.status === 'approved' ? 'approved' : input.status === 'changes' ? 'changes' : 'pending';
  if (status === 'pending') throw new Invalid('Onaylayın ya da değişiklik isteyin.');
  if (status === 'changes' && !String(input.comment ?? '').trim()) throw new Invalid('Neyin değişmesini istediğinizi yazın.');
  run(
    `UPDATE reviews SET status = ?, reviewer = ?, comment = ?, decided_at = ? WHERE token = ?`,
    status, String(input.reviewer ?? '').trim().slice(0, 80), String(input.comment ?? '').trim().slice(0, 2000), now(), token,
  );
  const post = getPost(String(row.post_id));
  if (post) emit({ type: 'post.updated', post });
  return reviewView(token);
}

export function attachAssetsToPost(postId: string, assetIds: string[]): Post | undefined {
  const post = getPost(postId);
  if (!post) return undefined;
  return updatePost(postId, { assetIds: [...post.assetIds, ...assetIds] });
}

export function deletePost(id: string): void {
  run(`UPDATE posts SET deleted_at = ? WHERE id = ?`, now(), id);
  const post = getPost(id);
  if (post) emit({ type: 'post.updated', post });
}

// ───────────────────────── Tasarımlar ─────────────────────────

function toDesign(row: Row): Design {
  const assetId = (row.asset_id as string | null) ?? null;
  return {
    id: String(row.id),
    name: String(row.name ?? ''),
    width: Number(row.width),
    height: Number(row.height),
    doc: parseJson<DesignDoc>(row.doc, { background: '#ffffff', layers: [] }),
    assetId,
    thumbUrl: assetId ? `/media/${assetId}/thumb` : null,
    postId: (row.post_id as string | null) ?? null,
    brandId: (row.brand_id as string | null) ?? null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    deletedAt: (row.deleted_at as string | null) ?? null,
  };
}

export function listDesigns(): Design[] {
  return all<Row>(`SELECT * FROM designs WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT 300`).map(toDesign);
}

export function getDesign(id: string): Design | undefined {
  const row = get<Row>(`SELECT * FROM designs WHERE id = ?`, id);
  return row ? toDesign(row) : undefined;
}

export interface DesignInput {
  name?: string;
  width?: number;
  height?: number;
  doc?: DesignDoc;
  assetId?: string | null;
  postId?: string | null;
  brandId?: string | null;
}

export function createDesign(input: DesignInput): Design {
  const width = Math.round(Number(input.width) || 1080);
  const height = Math.round(Number(input.height) || 1350);
  if (width < 64 || height < 64 || width > 8192 || height > 8192) throw new Invalid('Tasarım boyutu geçersiz.');
  const id = newId('ds');
  const stamp = now();
  run(
    `INSERT INTO designs (id, name, width, height, doc, asset_id, post_id, brand_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, (input.name ?? '').trim() || 'Adsız tasarım', width, height,
    JSON.stringify(input.doc ?? { background: '#ffffff', layers: [] }),
    input.assetId ?? null, input.postId ?? null, input.brandId ?? null, stamp, stamp,
  );
  return getDesign(id)!;
}

export function updateDesign(id: string, patch: DesignInput): Design {
  const row = get<Row>(`SELECT * FROM designs WHERE id = ?`, id);
  if (!row) throw new NotFound('Tasarım bulunamadı.');
  run(
    `UPDATE designs SET name = ?, width = ?, height = ?, doc = ?, asset_id = ?, post_id = ?, brand_id = ?, updated_at = ?
      WHERE id = ?`,
    patch.name !== undefined ? patch.name.trim() || row.name : row.name,
    patch.width !== undefined ? Math.round(patch.width) : row.width,
    patch.height !== undefined ? Math.round(patch.height) : row.height,
    patch.doc !== undefined ? JSON.stringify(patch.doc) : row.doc,
    patch.assetId !== undefined ? patch.assetId : row.asset_id,
    patch.postId !== undefined ? patch.postId : row.post_id,
    patch.brandId !== undefined ? patch.brandId : row.brand_id,
    now(), id,
  );
  return getDesign(id)!;
}

export function deleteDesign(id: string): void {
  run(`UPDATE designs SET deleted_at = ? WHERE id = ?`, now(), id);
}

// ───────────────────────── Çöp kutusu ─────────────────────────

export function listTrash(): TrashItem[] {
  const items: TrashItem[] = [];
  for (const row of all<Row>(`SELECT id, filename, title, thumb, kind, deleted_at FROM assets WHERE deleted_at IS NOT NULL`)) {
    items.push({
      kind: 'asset', id: String(row.id), title: String(row.title || row.filename),
      thumbUrl: row.thumb ? `/media/${row.id}/thumb` : null, deletedAt: String(row.deleted_at),
    });
  }
  for (const row of all<Row>(`SELECT id, name, handle, deleted_at FROM entities WHERE deleted_at IS NOT NULL`)) {
    items.push({ kind: 'entity', id: String(row.id), title: `${row.name} · @${row.handle}`, thumbUrl: null, deletedAt: String(row.deleted_at) });
  }
  for (const row of all<Row>(`SELECT id, title, deleted_at FROM conversations WHERE deleted_at IS NOT NULL`)) {
    items.push({ kind: 'conversation', id: String(row.id), title: String(row.title || 'Adsız sohbet'), thumbUrl: null, deletedAt: String(row.deleted_at) });
  }
  for (const row of all<Row>(`SELECT id, title, caption, deleted_at FROM posts WHERE deleted_at IS NOT NULL`)) {
    items.push({
      kind: 'post', id: String(row.id), title: String(row.title || String(row.caption).slice(0, 60) || 'Adsız gönderi'),
      thumbUrl: null, deletedAt: String(row.deleted_at),
    });
  }
  for (const row of all<Row>(`SELECT id, content, deleted_at FROM memories WHERE deleted_at IS NOT NULL`)) {
    items.push({ kind: 'memory', id: String(row.id), title: String(row.content).slice(0, 80), thumbUrl: null, deletedAt: String(row.deleted_at) });
  }
  for (const row of all<Row>(`SELECT id, name, asset_id, deleted_at FROM designs WHERE deleted_at IS NOT NULL`)) {
    items.push({
      kind: 'design', id: String(row.id), title: String(row.name),
      thumbUrl: row.asset_id ? `/media/${row.asset_id}/thumb` : null, deletedAt: String(row.deleted_at),
    });
  }
  return items.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
}

export function trashCount(): number {
  const row = get<{ n: number }>(
    `SELECT (SELECT COUNT(*) FROM assets WHERE deleted_at IS NOT NULL)
          + (SELECT COUNT(*) FROM entities WHERE deleted_at IS NOT NULL)
          + (SELECT COUNT(*) FROM conversations WHERE deleted_at IS NOT NULL)
          + (SELECT COUNT(*) FROM posts WHERE deleted_at IS NOT NULL)
          + (SELECT COUNT(*) FROM memories WHERE deleted_at IS NOT NULL)
          + (SELECT COUNT(*) FROM designs WHERE deleted_at IS NOT NULL) AS n`,
  );
  return Number(row?.n ?? 0);
}

const TRASH_TABLES: Record<Exclude<TrashItem['kind'], 'asset' | 'entity'>, string> = {
  conversation: 'conversations', post: 'posts', memory: 'memories', design: 'designs',
};

export function restoreSimple(kind: keyof typeof TRASH_TABLES, id: string): void {
  run(`UPDATE ${TRASH_TABLES[kind]} SET deleted_at = NULL WHERE id = ?`, id);
}

export function purgeSimple(kind: keyof typeof TRASH_TABLES | 'entity', id: string): void {
  if (kind === 'entity') {
    run(`DELETE FROM entity_assets WHERE entity_id = ?`, id);
    run(`DELETE FROM memories WHERE entity_id = ?`, id);
    run(`DELETE FROM entities WHERE id = ? AND deleted_at IS NOT NULL`, id);
    return;
  }
  if (kind === 'conversation') {
    run(`DELETE FROM messages WHERE conversation_id = ? AND EXISTS (SELECT 1 FROM conversations WHERE id = ? AND deleted_at IS NOT NULL)`, id, id);
  }
  run(`DELETE FROM ${TRASH_TABLES[kind]} WHERE id = ? AND deleted_at IS NOT NULL`, id);
}

// ───────────────────────── Arama ─────────────────────────

export function search(query: string): SearchResult[] {
  const needle = query.trim();
  if (needle.length < 2) return [];
  const like = `%${needle.replace(/[%_]/g, '')}%`;
  const folded = `%${foldText(needle).replace(/[%_]/g, '')}%`;
  const results: SearchResult[] = [];

  for (const row of all<Row>(
    `SELECT id, name, handle, type FROM entities WHERE deleted_at IS NULL AND (name LIKE ? OR handle LIKE ? OR description LIKE ?) LIMIT 8`,
    like, folded, like,
  )) {
    results.push({ kind: 'entity', id: String(row.id), title: String(row.name), subtitle: `@${row.handle}`, thumbUrl: null });
  }
  for (const row of all<Row>(
    `SELECT DISTINCT c.id, c.title FROM conversations c LEFT JOIN messages m ON m.conversation_id = c.id
      WHERE c.deleted_at IS NULL AND (c.title LIKE ? OR m.content LIKE ?) ORDER BY c.updated_at DESC LIMIT 8`,
    like, like,
  )) {
    results.push({ kind: 'conversation', id: String(row.id), title: String(row.title || 'Adsız sohbet'), subtitle: 'Sohbet', thumbUrl: null });
  }
  for (const row of all<Row>(
    `SELECT id, title, caption, platform FROM posts WHERE deleted_at IS NULL AND (title LIKE ? OR caption LIKE ?) ORDER BY updated_at DESC LIMIT 8`,
    like, like,
  )) {
    results.push({
      kind: 'post', id: String(row.id), title: String(row.title || String(row.caption).slice(0, 60)),
      subtitle: `Gönderi · ${getPlatform(String(row.platform)).label}`, thumbUrl: null,
    });
  }
  for (const row of all<Row>(
    `SELECT id, filename, title, prompt, thumb FROM assets WHERE deleted_at IS NULL AND (title LIKE ? OR prompt LIKE ? OR filename LIKE ?)
      ORDER BY created_at DESC LIMIT 10`,
    like, like, like,
  )) {
    results.push({
      kind: 'asset', id: String(row.id), title: String(row.title || row.prompt || row.filename).slice(0, 80),
      subtitle: 'Kütüphane', thumbUrl: row.thumb ? `/media/${row.id}/thumb` : null,
    });
  }
  for (const row of all<Row>(`SELECT id, content FROM memories WHERE deleted_at IS NULL AND content LIKE ? LIMIT 6`, like)) {
    results.push({ kind: 'memory', id: String(row.id), title: String(row.content).slice(0, 90), subtitle: 'Hafıza notu', thumbUrl: null });
  }
  return results;
}
