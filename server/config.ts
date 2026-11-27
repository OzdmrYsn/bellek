import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_NAME = 'Bellek';
export const APP_VERSION = '0.1.0';

/**
 * Veriler bilerek proje klasörünün DIŞINDA tutulur: kodu silmek, yeniden
 * klonlamak ya da `git clean` çalıştırmak hafızaya dokunmaz. iCloud ile
 * eşitlenen Belgeler klasörü de kullanılmaz; canlı bir SQLite dosyasını bulut
 * eşitlemesine bırakmak bozulmaya davetiye çıkarır.
 */
function defaultDataDir(): string {
  const home = os.homedir();
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', APP_NAME);
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), APP_NAME);
  }
  return path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), APP_NAME.toLowerCase());
}

export const DATA_DIR = path.resolve(process.env.BELLEK_DATA_DIR || defaultDataDir());

export const paths = {
  db: path.join(DATA_DIR, 'bellek.db'),
  media: path.join(DATA_DIR, 'media'),
  thumbs: path.join(DATA_DIR, 'thumbs'),
  backups: path.join(DATA_DIR, 'backups'),
  secrets: path.join(DATA_DIR, 'secrets.json'),
  tmp: path.join(DATA_DIR, 'tmp'),
  /** Bölge düzenleme maskeleri; iş yeniden denenebilsin diye kalıcıdır. */
  masks: path.join(DATA_DIR, 'masks'),
};

export const PORT = Number(process.env.PORT || 8787);
export const HOST = process.env.HOST || '127.0.0.1';
export const IS_PROD = process.env.NODE_ENV === 'production';
/** Anahtarsız uçtan uca deneme için sahte sağlayıcıyı açar. */
export const MOCK = process.env.BELLEK_MOCK === '1';
/**
 * Kurulum kodu. Hesaplar geldiğinden beri stüdyoyu e-posta ve şifre korur; bu
 * değer yalnızca ilk hesabı (takım sahibini) başka bir bilgisayardan açarken sorulur.
 */
export const PASSWORD = process.env.BELLEK_PASSWORD || '';

/** Sunucu yalnızca bu bilgisayardan mı erişilebilir. */
export const LOOPBACK = HOST === '127.0.0.1' || HOST === 'localhost' || HOST === '::1';
export const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** `Host` başlığından portu ayıklar. */
export function hostOnly(host: string | undefined): string {
  if (!host) return '';
  return host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
}

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DIST_DIR = path.resolve(process.env.BELLEK_DIST_DIR || path.join(ROOT_DIR, 'dist'));

export function ensureDirs(): void {
  for (const dir of [DATA_DIR, paths.media, paths.thumbs, paths.backups, paths.tmp, paths.masks]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
