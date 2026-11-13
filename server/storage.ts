import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import sharp, { type Metadata } from 'sharp';
import type { Asset, AssetKind, AssetSource } from '../shared/types.ts';
import { paths } from './config.ts';
import { all, get, newId, now, parseJson, run, tx, type Row } from './db.ts';

// Medya dosyaları içeriğe göre adreslenir (sha256) ve bir kez yazılır; var olan
// bir dosyanın üzerine asla yazılmaz. Silme yalnızca çöp kutusundan "kalıcı sil"
// ile ve başka hiçbir kayıt aynı dosyayı göstermiyorsa gerçekleşir.

function findBinary(name: string): string | null {
  const candidates = [`/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`, `/usr/bin/${name}`];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8' });
  const found = probe.status === 0 ? probe.stdout.split('\n')[0].trim() : '';
  return found || null;
}

export const FFMPEG = findBinary('ffmpeg');
export const FFPROBE = findBinary('ffprobe');
const SIPS = process.platform === 'darwin' ? findBinary('sips') : null;

const IMAGE_EXT: Record<string, string> = {
  jpeg: 'jpg', png: 'png', webp: 'webp', gif: 'gif', avif: 'avif', tiff: 'tiff', svg: 'svg',
};
const IMAGE_MIME: Record<string, string> = {
  jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif',
  tiff: 'image/tiff', svg: 'image/svg+xml',
};
const VIDEO_MIME: Record<string, string> = {
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', m4v: 'video/mp4',
};

export class UploadError extends Error {}

function sniffContainer(head: Buffer): 'heic' | 'mp4' | 'mov' | 'webm' | null {
  if (head.length >= 12 && head.toString('latin1', 4, 8) === 'ftyp') {
    const brand = head.toString('latin1', 8, 12).toLowerCase();
    if (['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'].includes(brand)) return 'heic';
    if (brand === 'avif' || brand === 'avis') return null;
    if (brand.startsWith('qt')) return 'mov';
    return 'mp4';
  }
  if (head.length >= 4 && head.readUInt32BE(0) === 0x1a45dfa3) return 'webm';
  return null;
}

function runProcess(bin: string, args: string[], timeoutMs = 60000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

function tmpFile(ext: string): string {
  return path.join(paths.tmp, `${crypto.randomBytes(10).toString('hex')}.${ext}`);
}

async function heicToJpeg(input: Buffer): Promise<Buffer> {
  try {
    return await sharp(input).rotate().jpeg({ quality: 93 }).toBuffer();
  } catch {
    // sharp'ın hazır ikilileri HEVC çözemez; macOS'ta sistemin dönüştürücüsüne düşeriz.
  }
  if (!SIPS) throw new UploadError('HEIC görseller bu sistemde dönüştürülemiyor. Lütfen JPEG ya da PNG yükleyin.');
  const source = tmpFile('heic');
  const target = tmpFile('jpg');
  await fsp.writeFile(source, input);
  try {
    const result = await runProcess(SIPS, ['-s', 'format', 'jpeg', '-s', 'formatOptions', '93', source, '--out', target]);
    if (result.code !== 0) throw new UploadError('HEIC görsel dönüştürülemedi.');
    return await fsp.readFile(target);
  } finally {
    await fsp.rm(source, { force: true });
    await fsp.rm(target, { force: true });
  }
}

async function writeDurable(file: string, data: Buffer): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = tmpFile('part');
  const handle = await fsp.open(tmp, 'w');
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsp.rename(tmp, file);
}

function hashFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

async function probeVideo(file: string): Promise<{ width: number | null; height: number | null; duration: number | null }> {
  if (!FFPROBE) return { width: null, height: null, duration: null };
  const result = await runProcess(FFPROBE, [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height:format=duration', '-of', 'json', file,
  ]);
  try {
    const info = JSON.parse(result.stdout) as { streams?: { width?: number; height?: number }[]; format?: { duration?: string } };
    return {
      width: info.streams?.[0]?.width ?? null,
      height: info.streams?.[0]?.height ?? null,
      duration: info.format?.duration ? Number(info.format.duration) : null,
    };
  } catch {
    return { width: null, height: null, duration: null };
  }
}

async function videoPoster(file: string): Promise<Buffer | null> {
  if (!FFMPEG) return null;
  const target = tmpFile('jpg');
  try {
    // İlk kare çoğu zaman siyahtır; yarım saniye içeriden al, olmazsa başa dön.
    for (const offset of ['0.5', '0']) {
      const result = await runProcess(FFMPEG, ['-y', '-ss', offset, '-i', file, '-frames:v', '1', '-q:v', '3', target]);
      if (result.code === 0 && fs.existsSync(target)) return await fsp.readFile(target);
    }
    return null;
  } finally {
    await fsp.rm(target, { force: true });
  }
}

async function makeThumb(assetId: string, source: Buffer): Promise<string | null> {
  try {
    const name = `${assetId}.webp`;
    const data = await sharp(source, { animated: false })
      .rotate()
      .resize({ width: 720, height: 720, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer();
    await writeDurable(path.join(paths.thumbs, name), data);
    return name;
  } catch {
    return null;
  }
}

export interface IngestInput {
  data?: Buffer;
  /** Diskteki geçici dosya; işlem sonunda taşınır ya da silinir. */
  filePath?: string;
  filename: string;
  source: AssetSource;
  title?: string | null;
  prompt?: string | null;
  model?: string | null;
  provider?: string | null;
  params?: Record<string, unknown> | null;
  parentId?: string | null;
  jobId?: string | null;
}

/** Bir dosyayı kütüphaneye alır. Aynı içerik daha önce yüklenmişse o kayıt döner. */
export async function ingest(input: IngestInput): Promise<Asset> {
  let data = input.data ?? null;
  const filePath = input.filePath ?? null;
  if (!data && !filePath) throw new UploadError('Dosya boş.');

  try {
    const head = data ? data.subarray(0, 32) : await readHead(filePath!);
    const container = sniffContainer(head);
    const isVideo = container === 'mp4' || container === 'mov' || container === 'webm';

    let kind: AssetKind;
    let ext: string;
    let mime: string;
    let width: number | null = null;
    let height: number | null = null;
    let duration: number | null = null;
    let sha: string;
    let size: number;
    let thumbSource: Buffer | null = null;

    if (isVideo) {
      kind = 'video';
      ext = container === 'mov' ? 'mov' : container === 'webm' ? 'webm' : 'mp4';
      mime = VIDEO_MIME[ext];
      let working = filePath;
      if (!working) {
        working = tmpFile(ext);
        await fsp.writeFile(working, data!);
      }
      sha = await hashFile(working);
      size = (await fsp.stat(working)).size;
      const final = mediaFile(sha, ext);
      if (!fs.existsSync(final)) {
        await fsp.mkdir(path.dirname(final), { recursive: true });
        await moveFile(working, final);
      } else {
        await fsp.rm(working, { force: true });
      }
      const info = await probeVideo(final);
      width = info.width;
      height = info.height;
      duration = info.duration;
      thumbSource = await videoPoster(final);
    } else {
      kind = 'image';
      if (!data) data = await fsp.readFile(filePath!);
      if (container === 'heic') data = await heicToJpeg(data);
      let meta: Metadata;
      try {
        meta = await sharp(data).metadata();
      } catch {
        throw new UploadError(`"${input.filename}" desteklenen bir görsel ya da video değil.`);
      }
      if (meta.format === 'svg') {
        // SVG betik taşıyabilir; kütüphaneye yalnızca piksel hâli girer.
        data = await sharp(data, { density: 300 }).resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
        meta = await sharp(data).metadata();
      }
      const format = meta.format ?? '';
      ext = IMAGE_EXT[format] ?? '';
      if (!ext) throw new UploadError(`"${input.filename}" biçimi (${format || 'bilinmiyor'}) desteklenmiyor.`);
      mime = IMAGE_MIME[ext];
      const rotated = (meta.orientation ?? 1) >= 5;
      width = (rotated ? meta.height : meta.width) ?? null;
      height = (rotated ? meta.width : meta.height) ?? null;
      sha = crypto.createHash('sha256').update(data).digest('hex');
      size = data.length;
      const final = mediaFile(sha, ext);
      if (!fs.existsSync(final)) await writeDurable(final, data);
      thumbSource = data;
    }

    // Aynı dosya zaten kütüphanedeyse yeni kayıt açma; çöpteyse geri getir.
    if (input.source === 'upload') {
      const existing = get<Row>(`SELECT * FROM assets WHERE sha256 = ? AND source = 'upload' ORDER BY created_at LIMIT 1`, sha);
      if (existing) {
        if (existing.deleted_at) run(`UPDATE assets SET deleted_at = NULL WHERE id = ?`, existing.id);
        return getAsset(String(existing.id))!;
      }
    }

    const id = newId('as');
    const thumb = thumbSource ? await makeThumb(id, thumbSource) : null;
    const baseName = path.basename(input.filename).replace(/\.[^.]+$/, '') || 'dosya';
    run(
      `INSERT INTO assets (id, kind, source, filename, mime, size, width, height, duration, sha256, path, thumb,
         title, prompt, model, provider, params, parent_id, job_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, kind, input.source, `${baseName}.${ext}`, mime, size, width, height, duration, sha,
      path.join(sha.slice(0, 2), `${sha}.${ext}`), thumb,
      input.title ?? null, input.prompt ?? null, input.model ?? null, input.provider ?? null,
      input.params ? JSON.stringify(input.params) : null, input.parentId ?? null, input.jobId ?? null, now(),
    );
    return getAsset(id)!;
  } finally {
    if (filePath) await fsp.rm(filePath, { force: true });
  }
}

async function readHead(file: string): Promise<Buffer> {
  const handle = await fsp.open(file, 'r');
  try {
    const buffer = Buffer.alloc(32);
    const { bytesRead } = await handle.read(buffer, 0, 32, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function moveFile(from: string, to: string): Promise<void> {
  try {
    await fsp.rename(from, to);
  } catch {
    // Farklı disk bölümleri arasında yeniden adlandırma çalışmaz.
    await fsp.copyFile(from, to);
    await fsp.rm(from, { force: true });
  }
}

function mediaFile(sha: string, ext: string): string {
  return path.join(paths.media, sha.slice(0, 2), `${sha}.${ext}`);
}

export function assetFilePath(row: Row): string {
  return path.join(paths.media, String(row.path));
}

export function thumbFilePath(row: Row): string | null {
  return row.thumb ? path.join(paths.thumbs, String(row.thumb)) : null;
}

function toAsset(row: Row, entityIds: string[]): Asset {
  const id = String(row.id);
  // Küçük görsel yoksa (ffmpeg'siz video gibi) arayüz özgün dosyayı kullanır.
  return {
    id,
    kind: row.kind as AssetKind,
    source: row.source as AssetSource,
    filename: String(row.filename),
    mime: String(row.mime),
    size: Number(row.size),
    width: row.width === null ? null : Number(row.width),
    height: row.height === null ? null : Number(row.height),
    duration: row.duration === null ? null : Number(row.duration),
    title: (row.title as string | null) ?? null,
    prompt: (row.prompt as string | null) ?? null,
    model: (row.model as string | null) ?? null,
    provider: (row.provider as string | null) ?? null,
    params: parseJson<Record<string, unknown> | null>(row.params, null),
    parentId: (row.parent_id as string | null) ?? null,
    jobId: (row.job_id as string | null) ?? null,
    favorite: !!row.favorite,
    tags: parseJson<string[]>(row.tags, []),
    createdAt: String(row.created_at),
    deletedAt: (row.deleted_at as string | null) ?? null,
    url: `/media/${id}`,
    thumbUrl: row.thumb ? `/media/${id}/thumb` : row.kind === 'image' ? `/media/${id}` : '',
    entityIds,
  };
}

export function hydrateAssets(rows: Row[]): Asset[] {
  if (!rows.length) return [];
  const ids = rows.map((r) => String(r.id));
  const links = new Map<string, string[]>();
  const marks = ids.map(() => '?').join(',');
  for (const link of all<{ asset_id: string; entity_id: string }>(
    `SELECT ea.asset_id, ea.entity_id FROM entity_assets ea
       JOIN entities e ON e.id = ea.entity_id AND e.deleted_at IS NULL
      WHERE ea.asset_id IN (${marks})`,
    ...ids,
  )) {
    const list = links.get(link.asset_id) ?? [];
    list.push(link.entity_id);
    links.set(link.asset_id, list);
  }
  return rows.map((row) => toAsset(row, links.get(String(row.id)) ?? []));
}

export function getAssetRow(id: string): Row | undefined {
  return get<Row>(`SELECT * FROM assets WHERE id = ?`, id);
}

export function getAsset(id: string): Asset | undefined {
  const row = getAssetRow(id);
  return row ? hydrateAssets([row])[0] : undefined;
}

export function getAssets(ids: string[]): Asset[] {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return [];
  const rows = all<Row>(`SELECT * FROM assets WHERE id IN (${unique.map(() => '?').join(',')})`, ...unique);
  const byId = new Map(hydrateAssets(rows).map((a) => [a.id, a]));
  return unique.map((id) => byId.get(id)).filter((a): a is Asset => !!a);
}

export async function readAsset(id: string): Promise<{ data: Buffer; mime: string; row: Row }> {
  const row = getAssetRow(id);
  if (!row) throw new Error('Görsel bulunamadı.');
  return { data: await fsp.readFile(assetFilePath(row)), mime: String(row.mime), row };
}

export interface Payload {
  data: Buffer;
  mime: string;
}

/**
 * Sağlayıcıya gönderilecek sürüm: yönü düzeltilmiş, makul boyuta indirilmiş.
 * Saydamlığı olan görseller (logolar) PNG kalır, gerisi JPEG olur.
 */
export async function assetPayload(id: string, maxEdge = 2048): Promise<Payload> {
  const row = getAssetRow(id);
  if (!row) throw new Error('Referans görsel bulunamadı.');
  if (row.kind === 'video') {
    const poster = await videoPoster(assetFilePath(row));
    if (!poster) throw new Error('Video karesi alınamadı (ffmpeg gerekli).');
    return { data: poster, mime: 'image/jpeg' };
  }
  const source = await fsp.readFile(assetFilePath(row));
  const image = sharp(source, { animated: false }).rotate().resize({
    width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true,
  });
  const meta = await sharp(source).metadata();
  if (meta.hasAlpha) return { data: await image.png({ compressionLevel: 8 }).toBuffer(), mime: 'image/png' };
  return { data: await image.jpeg({ quality: 90 }).toBuffer(), mime: 'image/jpeg' };
}

/** Kayıt ve dosyayı kalıcı olarak kaldırır; dosya yalnızca başka kayıt göstermiyorsa silinir. */
export async function purgeAsset(id: string): Promise<void> {
  const row = getAssetRow(id);
  if (!row) return;
  tx(() => {
    run(`DELETE FROM entity_assets WHERE asset_id = ?`, id);
    run(`UPDATE entities SET avatar_asset_id = NULL WHERE avatar_asset_id = ?`, id);
    run(`DELETE FROM assets WHERE id = ?`, id);
  });
  const shared = get<{ n: number }>(`SELECT COUNT(*) AS n FROM assets WHERE sha256 = ?`, row.sha256);
  if (!shared?.n) await fsp.rm(assetFilePath(row), { force: true });
  const thumb = thumbFilePath(row);
  if (thumb) await fsp.rm(thumb, { force: true });
}

export async function clearTmp(): Promise<void> {
  try {
    for (const name of await fsp.readdir(paths.tmp)) {
      await fsp.rm(path.join(paths.tmp, name), { force: true, recursive: true });
    }
  } catch {
    // Geçici klasör yoksa temizlenecek bir şey de yoktur.
  }
}

export async function dirSize(dir: string): Promise<{ bytes: number; files: number }> {
  let bytes = 0;
  let files = 0;
  async function walk(current: string): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) {
        bytes += (await fsp.stat(full)).size;
        files++;
      }
    }
  }
  await walk(dir);
  return { bytes, files };
}
