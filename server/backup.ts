import { ZipArchive } from 'archiver';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Writable } from 'node:stream';
import yauzl from 'yauzl';
import type { BackupFile, BackupStatus } from '../shared/types.ts';
import { APP_VERSION, DATA_DIR, paths } from './config.ts';
import { closeDb, integrityCheck, openDb, schemaVersion, snapshotTo } from './db.ts';
import { emit } from './events.ts';
import { Invalid } from './repo/entities.ts';
import { getSettings, readSetting, writeSetting } from './settings.ts';
import { dirSize } from './storage.ts';

// Üç katmanlı koruma:
//  1. Veritabanının zamanlanmış anlık kopyaları (aynı diskte, hızlı geri dönüş).
//  2. İsteğe bağlı ayna klasör: kopyalar ve tüm medya ikinci bir konuma (harici
//     disk, iCloud Drive, Dropbox…) eşitlenir; disk arızasına karşı.
//  3. Elle indirilebilen tam ZIP arşivi; başka bir makineye taşımak için.

const REASONS: Record<string, string> = {
  otomatik: 'Otomatik',
  manuel: 'Elle alındı',
  acilis: 'Açılışta',
  'geri-yukleme-oncesi': 'Geri yükleme öncesi',
  'ice-aktarma-oncesi': 'İçe aktarma öncesi',
};

let integrity: BackupStatus['integrity'] = 'unknown';
let running: Promise<BackupFile> | null = null;

function stamp(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

function describe(name: string): string {
  const match = name.match(/^bellek-\d{8}-\d{6}-(.+)\.db$/);
  if (match) return REASONS[match[1]] ?? match[1];
  if (/surum\d+/.test(name)) return 'Güncelleme öncesi';
  return 'Yedek';
}

export async function listBackups(): Promise<BackupFile[]> {
  let names: string[] = [];
  try {
    names = (await fsp.readdir(paths.backups)).filter((n) => n.endsWith('.db'));
  } catch {
    return [];
  }
  const files = await Promise.all(
    names.map(async (name) => {
      const stat = await fsp.stat(path.join(paths.backups, name));
      return { name, size: stat.size, createdAt: stat.mtime.toISOString(), reason: describe(name) };
    }),
  );
  return files.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function prune(): Promise<void> {
  const { keep } = getSettings().backup;
  const files = await listBackups();
  const automatic = files.filter((f) => /-(otomatik|acilis)\.db$/.test(f.name));
  const others = files.filter((f) => !/-(otomatik|acilis)\.db$/.test(f.name));
  for (const file of [...automatic.slice(keep), ...others.slice(20)]) {
    await fsp.rm(path.join(paths.backups, file.name), { force: true });
  }
}

async function copyIfMissing(from: string, to: string): Promise<boolean> {
  try {
    const [a, b] = await Promise.all([fsp.stat(from), fsp.stat(to).catch(() => null)]);
    if (b && b.size === a.size) return false;
  } catch {
    return false;
  }
  await fsp.mkdir(path.dirname(to), { recursive: true });
  const tmp = `${to}.part`;
  await fsp.copyFile(from, tmp);
  await fsp.rename(tmp, to);
  return true;
}

async function mirror(snapshot: string): Promise<void> {
  const target = getSettings().backup.mirrorDir.trim();
  if (!target) return;
  const root = path.resolve(target.replace(/^~(?=$|\/)/, process.env.HOME ?? '~'));
  if (root === DATA_DIR || root.startsWith(DATA_DIR + path.sep)) {
    throw new Invalid('Ayna klasör, veri klasörünün içinde olamaz.');
  }
  await fsp.mkdir(path.join(root, 'backups'), { recursive: true });
  await copyIfMissing(snapshot, path.join(root, 'backups', path.basename(snapshot)));
  await fsp.copyFile(snapshot, path.join(root, 'bellek.db.part'));
  await fsp.rename(path.join(root, 'bellek.db.part'), path.join(root, 'bellek.db'));

  // Medya dosyaları değişmez olduğundan yalnızca eksik olanlar kopyalanır.
  async function walk(dir: string): Promise<void> {
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) await copyIfMissing(full, path.join(root, 'media', path.relative(paths.media, full)));
    }
  }
  await walk(paths.media);

  // Ayna klasördeki eski anlık kopyaları da aynı sayıda tut.
  const keep = getSettings().backup.keep;
  const names = (await fsp.readdir(path.join(root, 'backups'))).filter((n) => n.endsWith('.db')).sort().reverse();
  for (const name of names.slice(keep)) await fsp.rm(path.join(root, 'backups', name), { force: true });
}

export function runBackup(reason: keyof typeof REASONS | string = 'manuel'): Promise<BackupFile> {
  if (running) return running;
  running = (async () => {
    const name = `bellek-${stamp()}-${reason}.db`;
    const file = path.join(paths.backups, name);
    await fsp.mkdir(paths.backups, { recursive: true });
    snapshotTo(file);
    const at = new Date().toISOString();
    writeSetting('backup.last', at);
    try {
      await mirror(file);
      if (getSettings().backup.mirrorDir.trim()) writeSetting('backup.mirror', { at, error: null });
    } catch (error) {
      writeSetting('backup.mirror', {
        at: readSetting<{ at: string | null }>('backup.mirror', { at: null }).at,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    await prune();
    emit({ type: 'backup.done', at });
    const stat = await fsp.stat(file);
    return { name, size: stat.size, createdAt: at, reason: describe(name) };
  })().finally(() => {
    running = null;
  });
  return running;
}

export function lastBackupAt(): string | null {
  return readSetting<string | null>('backup.last', null);
}

export function currentIntegrity(): BackupStatus['integrity'] {
  return integrity;
}

export async function backupStatus(): Promise<BackupStatus> {
  const settings = getSettings();
  const mirrorState = readSetting<{ at: string | null; error: string | null }>('backup.mirror', { at: null, error: null });
  const media = await dirSize(paths.media);
  const dbSize = await fsp.stat(paths.db).then((s) => s.size).catch(() => 0);
  return {
    dataDir: DATA_DIR,
    dbSize,
    mediaSize: media.bytes,
    mediaCount: media.files,
    lastBackupAt: lastBackupAt(),
    lastMirrorAt: mirrorState.at,
    mirrorDir: settings.backup.mirrorDir,
    mirrorError: mirrorState.error,
    integrity,
    backups: await listBackups(),
  };
}

/** Açılışta bütünlüğü denetler, gerekiyorsa yedek alır ve zamanlayıcıyı kurar. */
export function startBackupScheduler(): void {
  integrity = integrityCheck() ? 'ok' : 'error';
  const due = (): boolean => {
    const last = lastBackupAt();
    const hours = getSettings().backup.intervalHours;
    return !last || Date.now() - new Date(last).getTime() >= hours * 3600000;
  };
  if (due()) void runBackup('acilis').catch((error) => console.error('[yedek] açılış yedeği alınamadı:', error));
  const timer = setInterval(() => {
    if (due()) void runBackup('otomatik').catch((error) => console.error('[yedek] otomatik yedek alınamadı:', error));
  }, 10 * 60000);
  timer.unref();
}

function assertSqlite(file: string): void {
  let probe: DatabaseSync;
  try {
    probe = new DatabaseSync(file, { readOnly: true });
    probe.prepare('SELECT 1 FROM sqlite_master LIMIT 1').get();
  } catch {
    throw new Invalid('Bu dosya bir Bellek yedeği değil.');
  }
  try {
    const row = probe.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('assets', 'entities', 'messages')`).get() as { n: number };
    if (Number(row.n) < 3) throw new Invalid('Bu dosya bir Bellek yedeği değil.');
    const check = probe.prepare('PRAGMA quick_check').get() as Record<string, unknown>;
    if (Object.values(check)[0] !== 'ok') throw new Invalid('Yedek dosyası bozuk görünüyor.');
  } finally {
    probe.close();
  }
}

async function swapDatabase(source: string, reason: string): Promise<void> {
  assertSqlite(source);
  // Önce şimdiki hâlin kopyasını al: geri yükleme de geri alınabilir olmalı.
  const safety = path.join(paths.backups, `bellek-${stamp()}-${reason}.db`);
  snapshotTo(safety);
  closeDb();
  try {
    for (const suffix of ['', '-wal', '-shm']) await fsp.rm(paths.db + suffix, { force: true });
    await fsp.copyFile(source, paths.db);
  } catch (error) {
    await fsp.copyFile(safety, paths.db);
    throw error;
  } finally {
    openDb();
    integrity = integrityCheck() ? 'ok' : 'error';
  }
}

export async function restoreBackup(name: string): Promise<void> {
  if (!/^[\w.-]+\.db$/.test(name)) throw new Invalid('Geçersiz yedek adı.');
  const file = path.join(paths.backups, name);
  if (!fs.existsSync(file)) throw new Invalid('Yedek bulunamadı.');
  await swapDatabase(file, 'geri-yukleme-oncesi');
}

/** Veritabanı ve tüm medyayı tek bir ZIP olarak akıtır. API anahtarları dahil edilmez. */
export async function exportArchive(output: Writable): Promise<void> {
  const snapshot = path.join(paths.tmp, `disa-aktarim-${stamp()}.db`);
  snapshotTo(snapshot);
  const archive = new ZipArchive({ zlib: { level: 6 } });
  const done = new Promise<void>((resolve, reject) => {
    archive.on('error', reject);
    archive.on('warning', (warning: Error) => console.warn('[yedek] arşiv uyarısı:', warning.message));
    output.on('finish', resolve);
    output.on('close', resolve);
    output.on('error', reject);
  });
  archive.pipe(output);
  archive.append(
    JSON.stringify({ app: 'Bellek', version: APP_VERSION, schema: schemaVersion(), exportedAt: new Date().toISOString() }, null, 2),
    { name: 'manifest.json' },
  );
  archive.file(snapshot, { name: 'bellek.db' });
  // Görseller ve videolar zaten sıkıştırılmıştır; yeniden sıkıştırmak yalnızca zaman kaybettirir.
  archive.directory(paths.media, 'media', (entry) => ({ ...entry, store: true }));
  try {
    await archive.finalize();
    await done;
  } finally {
    await fsp.rm(snapshot, { force: true });
  }
}

const MEDIA_ENTRY = /^media\/[0-9a-f]{2}\/[0-9a-f]{64}\.[a-z0-9]{2,5}$/;

/** Dışa aktarılmış bir ZIP'i geri yükler: medya eklenir, veritabanı değiştirilir. */
export async function importArchive(zipPath: string): Promise<{ media: number }> {
  const dbTarget = path.join(paths.tmp, `ice-aktarim-${stamp()}.db`);
  let foundDb = false;
  let media = 0;

  try {
    await new Promise<void>((resolve, reject) => {
      yauzl.open(zipPath, { lazyEntries: true }, (openError, zip) => {
        if (openError || !zip) return reject(new Invalid('ZIP dosyası açılamadı. Bellek\'ten dışa aktarılmış bir arşiv seçin.'));
        zip.on('error', reject);
        zip.on('end', resolve);
        zip.on('entry', (entry: yauzl.Entry) => {
          const name = entry.fileName.replace(/\\/g, '/');
          // Yalnızca beklenen adlar kabul edilir; arşiv dışına yazmaya çalışan girdiler atlanır.
          const isDb = name === 'bellek.db';
          const isMedia = MEDIA_ENTRY.test(name);
          if (!isDb && !isMedia) return zip.readEntry();
          const target = isDb ? dbTarget : path.join(paths.media, name.slice('media/'.length));
          if (isMedia && fs.existsSync(target)) return zip.readEntry();
          zip.openReadStream(entry, (streamError, stream) => {
            if (streamError || !stream) return reject(streamError ?? new Invalid('Arşiv okunamadı.'));
            fs.mkdirSync(path.dirname(target), { recursive: true });
            const part = `${target}.part`;
            const out = fs.createWriteStream(part);
            stream.on('error', reject);
            out.on('error', reject);
            out.on('close', () => {
              fs.renameSync(part, target);
              if (isDb) foundDb = true;
              else media++;
              zip.readEntry();
            });
            stream.pipe(out);
          });
        });
        zip.readEntry();
      });
    });

    if (!foundDb) throw new Invalid('Arşivde bellek.db bulunamadı; bu bir Bellek dışa aktarımı değil.');
    await swapDatabase(dbTarget, 'ice-aktarma-oncesi');
    return { media };
  } finally {
    await fsp.rm(dbTarget, { force: true });
    await fsp.rm(zipPath, { force: true });
  }
}
