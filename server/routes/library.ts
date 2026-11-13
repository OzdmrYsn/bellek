import { Router, type Request } from 'express';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import multer from 'multer';
import path from 'node:path';
import sharp from 'sharp';
import type { Asset, AssetSource, DetectedPerson, EntityAssetRole, PeopleDetection } from '../../shared/types.ts';
import { detectPeople } from '../ai/tasks.ts';
import { paths } from '../config.ts';
import { all, now, run, type Row } from '../db.ts';
import { emit } from '../events.ts';
import { createToolJob } from '../jobs.ts';
import { detectPeopleLocal } from '../media/people.ts';
import { Invalid, NotFound, linkAssets, unlinkAsset } from '../repo/entities.ts';
import {
  UploadError, assetFilePath, getAsset, getAssetRow, hydrateAssets, ingest, thumbFilePath,
} from '../storage.ts';

export const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, done) => done(null, paths.tmp),
    filename: (_req, file, done) => done(null, `yukleme-${Date.now()}-${Math.round(Math.random() * 1e9)}${path.extname(file.originalname).slice(0, 8)}`),
  }),
  limits: { fileSize: 2 * 1024 * 1024 * 1024, files: 300 },
});

export function query(req: Request, name: string): string {
  const value = req.query[name];
  return typeof value === 'string' ? value : '';
}

/** Tarayıcılar dosya adını latin1 olarak gönderir; Türkçe karakterleri geri çevir. */
function originalName(file: Express.Multer.File): string {
  try {
    const decoded = Buffer.from(file.originalname, 'latin1').toString('utf8');
    return decoded.includes('�') ? file.originalname : decoded;
  } catch {
    return file.originalname;
  }
}

const SOURCES: AssetSource[] = ['upload', 'generated', 'crop', 'design'];

export const libraryRouter = Router();
export const mediaRouter = Router();

// ───────────────────────── Dosya sunumu ─────────────────────────

const IMMUTABLE = 'private, max-age=31536000, immutable';

mediaRouter.get('/:id', (req, res) => {
  const row = getAssetRow(req.params.id);
  if (!row) throw new NotFound('Dosya bulunamadı.');
  res.sendFile(String(row.path), {
    root: paths.media,
    dotfiles: 'allow',
    headers: { 'Content-Type': String(row.mime), 'Cache-Control': IMMUTABLE },
  });
});

mediaRouter.get('/:id/thumb', async (req, res) => {
  const row = getAssetRow(req.params.id);
  if (!row) throw new NotFound('Dosya bulunamadı.');
  let thumb = thumbFilePath(row);
  // Küçük görseller yeniden üretilebilir: yedekten dönüldüğünde eksikse yerinde oluştur.
  if ((!thumb || !fs.existsSync(thumb)) && row.kind === 'image') {
    const name = `${row.id}.webp`;
    thumb = path.join(paths.thumbs, name);
    try {
      const data = await sharp(assetFilePath(row), { animated: false })
        .rotate()
        .resize({ width: 720, height: 720, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer();
      await fsp.writeFile(thumb, data);
      run(`UPDATE assets SET thumb = ? WHERE id = ?`, name, row.id);
    } catch {
      thumb = null;
    }
  }
  if (!thumb || !fs.existsSync(thumb)) {
    if (row.kind === 'image') {
      return res.sendFile(String(row.path), { root: paths.media, dotfiles: 'allow', headers: { 'Content-Type': String(row.mime) } });
    }
    throw new NotFound('Önizleme yok.');
  }
  res.sendFile(path.basename(thumb), {
    root: paths.thumbs,
    dotfiles: 'allow',
    headers: { 'Content-Type': 'image/webp', 'Cache-Control': IMMUTABLE },
  });
});

mediaRouter.get('/:id/download', (req, res) => {
  const row = getAssetRow(req.params.id);
  if (!row) throw new NotFound('Dosya bulunamadı.');
  res.download(assetFilePath(row), String(row.filename), { dotfiles: 'allow' });
});

// ───────────────────────── Kütüphane ─────────────────────────

libraryRouter.get('/', (req, res) => {
  const where: string[] = [query(req, 'trashed') === '1' ? 'deleted_at IS NOT NULL' : 'deleted_at IS NULL'];
  const params: unknown[] = [];
  const kind = query(req, 'kind');
  if (kind === 'image' || kind === 'video') {
    where.push('kind = ?');
    params.push(kind);
  }
  const source = query(req, 'source');
  if (source === 'uploaded') where.push(`source IN ('upload', 'crop')`);
  else if (SOURCES.includes(source as AssetSource)) {
    where.push('source = ?');
    params.push(source);
  }
  if (query(req, 'favorite') === '1') where.push('favorite = 1');
  const entity = query(req, 'entity');
  if (entity) {
    where.push(`(id IN (SELECT asset_id FROM entity_assets WHERE entity_id = ?)
      OR job_id IN (SELECT j.id FROM jobs j WHERE EXISTS (SELECT 1 FROM json_each(j.input, '$.entityIds') WHERE value = ?)))`);
    params.push(entity, entity);
  }
  const search = query(req, 'q').trim();
  if (search) {
    const like = `%${search.replace(/[%_]/g, '')}%`;
    where.push('(title LIKE ? OR prompt LIKE ? OR filename LIKE ? OR model LIKE ?)');
    params.push(like, like, like, like);
  }
  const before = query(req, 'before');
  if (before) {
    where.push('created_at < ?');
    params.push(before);
  }
  const limit = Math.min(200, Math.max(1, Number(query(req, 'limit')) || 60));
  const rows = all<Row>(
    `SELECT * FROM assets WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`,
    ...params, limit + 1,
  );
  const page = rows.slice(0, limit);
  res.json({
    items: hydrateAssets(page),
    nextCursor: rows.length > limit ? String(page[page.length - 1].created_at) : null,
  });
});

libraryRouter.post('/', upload.array('files', 300), async (req, res) => {
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  if (!files.length) throw new UploadError('Yüklenecek dosya seçilmedi.');
  const body = req.body as Record<string, string | undefined>;
  const source: AssetSource = SOURCES.includes(body.source as AssetSource) ? (body.source as AssetSource) : 'upload';
  const assets: Asset[] = [];
  const errors: { filename: string; error: string }[] = [];
  for (const file of files) {
    const filename = originalName(file);
    try {
      assets.push(
        await ingest({
          filePath: file.path,
          filename,
          source,
          title: body.title || null,
          parentId: body.parentId || null,
          prompt: body.prompt || null,
        }),
      );
    } catch (error) {
      errors.push({ filename, error: error instanceof Error ? error.message : 'Dosya işlenemedi.' });
      await fsp.rm(file.path, { force: true });
    }
  }
  if (body.entityId && assets.length) {
    linkAssets(body.entityId, assets.map((a) => a.id), (body.role as EntityAssetRole) || 'reference');
  }
  emit({ type: 'asset.changed' });
  res.status(assets.length ? 201 : 400).json({ assets: assets.map((a) => getAsset(a.id)!), errors });
});

libraryRouter.get('/:id', (req, res) => {
  const asset = getAsset(req.params.id);
  if (!asset) throw new NotFound('Görsel bulunamadı.');
  res.json(asset);
});

libraryRouter.patch('/:id', (req, res) => {
  const row = getAssetRow(req.params.id);
  if (!row) throw new NotFound('Görsel bulunamadı.');
  const body = req.body as { title?: string | null; favorite?: boolean; tags?: string[] };
  run(
    `UPDATE assets SET title = ?, favorite = ?, tags = ? WHERE id = ?`,
    body.title !== undefined ? body.title?.trim() || null : row.title,
    body.favorite !== undefined ? body.favorite : row.favorite,
    body.tags !== undefined ? JSON.stringify(body.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 30)) : row.tags,
    req.params.id,
  );
  emit({ type: 'asset.changed' });
  res.json(getAsset(req.params.id));
});

libraryRouter.delete('/:id', (req, res) => {
  run(`UPDATE assets SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL`, now(), req.params.id);
  emit({ type: 'asset.changed' });
  res.json({ ok: true });
});

libraryRouter.post('/bulk', (req, res) => {
  const body = req.body as { ids?: string[]; action?: string; entityId?: string; role?: EntityAssetRole };
  const ids = Array.isArray(body.ids) ? body.ids.filter((id) => typeof id === 'string').slice(0, 1000) : [];
  if (!ids.length) return res.json({ ok: true, count: 0 });
  const marks = ids.map(() => '?').join(',');
  switch (body.action) {
    case 'delete':
      run(`UPDATE assets SET deleted_at = ? WHERE id IN (${marks}) AND deleted_at IS NULL`, now(), ...ids);
      break;
    case 'restore':
      run(`UPDATE assets SET deleted_at = NULL WHERE id IN (${marks})`, ...ids);
      break;
    case 'favorite':
    case 'unfavorite':
      run(`UPDATE assets SET favorite = ? WHERE id IN (${marks})`, body.action === 'favorite', ...ids);
      break;
    case 'link':
      if (!body.entityId) throw new UploadError('Bir varlık seçin.');
      linkAssets(body.entityId, ids, body.role ?? 'reference');
      break;
    case 'unlink':
      if (!body.entityId) throw new UploadError('Bir varlık seçin.');
      for (const id of ids) unlinkAsset(body.entityId, id);
      break;
    default:
      throw new UploadError('Bilinmeyen işlem.');
  }
  emit({ type: 'asset.changed' });
  res.json({ ok: true, count: ids.length });
});

const TOOL_OPS = ['inpaint', 'remove-bg', 'upscale'] as const;

/** Görsel araçları: bölge düzenleme, arka plan silme, büyütme. Sonuç yeni bir görseldir; özgün dosya değişmez. */
libraryRouter.post('/:id/tools', async (req, res) => {
  const body = req.body as { op?: string; prompt?: string; mask?: string; modelRef?: string | null };
  const op = TOOL_OPS.find((item) => item === body.op);
  if (!op) throw new UploadError('Bu araç tanınmıyor.');
  const encoded = typeof body.mask === 'string' ? body.mask.replace(/^data:image\/png;base64,/, '') : '';
  res.status(201).json(
    await createToolJob({
      op,
      sourceAssetId: req.params.id,
      prompt: body.prompt,
      mask: encoded ? Buffer.from(encoded, 'base64') : undefined,
      modelRef: body.modelRef,
    }),
  );
});

// Aynı görsel için algılama yinelenmesin: pencere her açıldığında ve her tıklamada sorulur.
const detections = new Map<string, { local?: DetectedPerson[] | null; model?: DetectedPerson[] }>();

/**
 * Görseldeki kişileri bulur. Önce bu bilgisayardaki ücretsiz algılayıcı denenir;
 * o bir şey bulamazsa ve `allowModel` verilmişse bağlı yapay zekâ modeline sorulur.
 */
libraryRouter.post('/:id/detect', async (req, res) => {
  const row = getAssetRow(req.params.id);
  if (!row || row.deleted_at) throw new NotFound('Görsel bulunamadı.');
  if (row.kind !== 'image') throw new Invalid('Kişi seçimi yalnızca görsellerde yapılır.');
  const allowModel = (req.body as { allowModel?: boolean } | undefined)?.allowModel !== false;
  if (detections.size > 300) detections.clear();
  const entry = detections.get(req.params.id) ?? {};
  detections.set(req.params.id, entry);

  if (entry.local === undefined) {
    entry.local = await detectPeopleLocal(assetFilePath(row), Number(row.width) || null, Number(row.height) || null);
  }
  let result: PeopleDetection;
  if (entry.local?.length) {
    result = { people: entry.local, method: 'local' };
  } else if (allowModel) {
    try {
      entry.model ??= await detectPeople(req.params.id);
      result = { people: entry.model, method: 'model' };
    } catch (error) {
      // Yerel algılayıcı çalıştıysa "kimse yok" geçerli bir yanıttır; model eksikliği hataya dönüşmez.
      if (entry.local === null) throw error;
      result = { people: [], method: 'local' };
    }
  } else {
    result = { people: [], method: entry.local === null ? 'none' : 'local' };
  }
  res.json(result);
});
