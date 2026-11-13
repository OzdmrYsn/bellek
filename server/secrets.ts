import fs from 'node:fs';
import { paths } from './config.ts';

// API anahtarları veritabanından ayrı, yalnızca kullanıcının okuyabildiği bir
// dosyada durur. Böylece yedekler ve dışa aktarımlar anahtar taşımaz, anahtarlar
// da arayüze hiçbir zaman tam hâliyle geri gönderilmez.

type SecretMap = Record<string, string>;

let cache: SecretMap | null = null;

function load(): SecretMap {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(paths.secrets, 'utf8')) as SecretMap;
  } catch {
    cache = {};
  }
  return cache;
}

function persist(): void {
  const tmp = `${paths.secrets}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(load(), null, 2), { mode: 0o600 });
  fs.renameSync(tmp, paths.secrets);
  try {
    fs.chmodSync(paths.secrets, 0o600);
  } catch {
    // Windows'ta chmod anlamsızdır; yok sayılır.
  }
}

export function getSecret(providerId: string): string {
  return load()[providerId] ?? '';
}

export function setSecret(providerId: string, value: string): void {
  const map = load();
  const trimmed = value.trim();
  if (trimmed) map[providerId] = trimmed;
  else delete map[providerId];
  persist();
}

export function hasSecret(providerId: string): boolean {
  return !!getSecret(providerId);
}

export function secretHint(providerId: string): string {
  const value = getSecret(providerId);
  if (!value) return '';
  return value.length <= 8 ? '••••' : `${value.slice(0, 4)}…${value.slice(-4)}`;
}

export function resetSecretCache(): void {
  cache = null;
}
