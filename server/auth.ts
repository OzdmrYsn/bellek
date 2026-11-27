import type { Request, Response } from 'express';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import type { SessionInfo } from '../shared/types.ts';
import { all, get, newId, now, run, type Row } from './db.ts';
import { disconnectSession, disconnectSessions } from './events.ts';

// Kimlik doğrulamanın alt katmanı: şifre özeti, oturumlar, çerez ve deneme sınırı.
// Kullanıcı kayıtları ve yetkiler `repo/teams.ts` içindedir.

export class Unauthorized extends Error {}
export class Forbidden extends Error {}
export class TooMany extends Error {}

// ───────────────────────── Şifreler ─────────────────────────

const scrypt = promisify(crypto.scrypt) as (
  password: string, salt: Buffer, keylen: number, options: crypto.ScryptOptions,
) => Promise<Buffer>;

const SCRYPT = { N: 16384, r: 8, p: 1 };
const KEY_LENGTH = 64;
export const MIN_PASSWORD = 8;

/** Şifrenin kendisi hiçbir yerde saklanmaz; yalnızca tuzlanmış scrypt özeti yazılır. */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64url'), hash.toString('base64url')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  try {
    const actual = await scrypt(password.normalize('NFKC'), Buffer.from(salt, 'base64url'), expected.length, {
      N: Number(n), r: Number(r), p: Number(p),
    });
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

let decoy: Promise<string> | null = null;

/** Kayıtlı olmayan bir e-postada da aynı süre harcanır; yanıt süresi hesabın varlığını ele vermez. */
export async function burnPassword(password: string): Promise<void> {
  decoy ??= hashPassword(crypto.randomBytes(12).toString('hex'));
  await verifyPassword(password, await decoy);
}

/** Geçerliyse `null`, değilse kullanıcıya gösterilecek açıklama. */
export function passwordProblem(password: unknown): string | null {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) return `Şifre en az ${MIN_PASSWORD} karakter olmalı.`;
  if (password.length > 200) return 'Şifre en fazla 200 karakter olabilir.';
  return null;
}

// ───────────────────────── Oturumlar ─────────────────────────

const SESSION_DAYS = 30;
const SESSION_MS = SESSION_DAYS * 24 * 60 * 60 * 1000;
const TOUCH_MS = 5 * 60 * 1000;
const COOKIE = 'bellek_oturum';

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function clientIp(req: Request): string {
  return (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
}

/** Oturum açar ve çerezde taşınacak belirteci döndürür. Veritabanına yalnızca belirtecin özeti yazılır. */
export function createSession(userId: string, req: Request): string {
  const token = crypto.randomBytes(32).toString('base64url');
  const stamp = now();
  run(
    `INSERT INTO sessions (id, user_id, token_hash, user_agent, ip, created_at, last_seen_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    newId('ss'), userId, hashToken(token), String(req.headers['user-agent'] ?? '').slice(0, 300), clientIp(req),
    stamp, stamp, new Date(Date.now() + SESSION_MS).toISOString(),
  );
  return token;
}

/** Belirteç geçerliyse oturumu döndürür ve süresini kullanıldıkça uzatır. */
export function resolveSession(token: string): { sessionId: string; userId: string } | null {
  if (!token || token.length > 200) return null;
  const row = get<Row>(`SELECT id, user_id, last_seen_at, expires_at FROM sessions WHERE token_hash = ?`, hashToken(token));
  if (!row) return null;
  const nowMs = Date.now();
  if (new Date(String(row.expires_at)).getTime() <= nowMs) {
    run(`DELETE FROM sessions WHERE id = ?`, row.id);
    return null;
  }
  if (nowMs - new Date(String(row.last_seen_at)).getTime() > TOUCH_MS) {
    const stamp = new Date(nowMs).toISOString();
    run(`UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?`, stamp, new Date(nowMs + SESSION_MS).toISOString(), row.id);
    run(`UPDATE users SET last_seen_at = ? WHERE id = ?`, stamp, row.user_id);
  }
  return { sessionId: String(row.id), userId: String(row.user_id) };
}

export function deleteSession(sessionId: string, userId?: string): void {
  const { changes } = userId
    ? run(`DELETE FROM sessions WHERE id = ? AND user_id = ?`, sessionId, userId)
    : run(`DELETE FROM sessions WHERE id = ?`, sessionId);
  // Oturum kapandıysa o sekmenin canlı olay bağlantısı da kapanır.
  if (changes) disconnectSession(sessionId);
}

/** Kullanıcının oturumlarını kapatır; `exceptId` verilirse o oturum açık kalır. */
export function deleteSessionsOf(userId: string, exceptId?: string): void {
  if (exceptId) run(`DELETE FROM sessions WHERE user_id = ? AND id <> ?`, userId, exceptId);
  else run(`DELETE FROM sessions WHERE user_id = ?`, userId);
  disconnectSessions(userId, exceptId);
}

export function pruneSessions(): void {
  run(`DELETE FROM sessions WHERE expires_at <= ?`, now());
}

function describeDevice(agent: string): string {
  const browser = /Edg\//.test(agent) ? 'Edge'
    : /OPR\//.test(agent) ? 'Opera'
    : /Firefox\//.test(agent) ? 'Firefox'
    : /Chrome\//.test(agent) ? 'Chrome'
    : /Safari\//.test(agent) ? 'Safari'
    : '';
  const system = /iPhone|iPad/.test(agent) ? 'iOS'
    : /Android/.test(agent) ? 'Android'
    : /Mac OS X|Macintosh/.test(agent) ? 'macOS'
    : /Windows/.test(agent) ? 'Windows'
    : /Linux/.test(agent) ? 'Linux'
    : '';
  return [browser, system].filter(Boolean).join(' · ') || 'Bilinmeyen cihaz';
}

export function listSessions(userId: string, currentId: string | undefined): SessionInfo[] {
  return all<Row>(
    `SELECT id, user_agent, ip, created_at, last_seen_at FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY last_seen_at DESC`,
    userId, now(),
  ).map((row) => ({
    id: String(row.id),
    current: row.id === currentId,
    device: describeDevice(String(row.user_agent ?? '')),
    ip: String(row.ip ?? ''),
    createdAt: String(row.created_at),
    lastSeenAt: String(row.last_seen_at),
  }));
}

// ───────────────────────── Çerez ─────────────────────────

export function readSessionCookie(req: Request): string {
  const header = req.headers.cookie;
  if (!header) return '';
  for (const part of header.split(';')) {
    const text = part.trim();
    if (text.startsWith(`${COOKIE}=`)) return text.slice(COOKIE.length + 1);
  }
  return '';
}

function secureSuffix(req: Request): string {
  // Tünel ya da ters vekil arkasında HTTPS ise çerez yalnızca şifreli bağlantıda gönderilir.
  return req.secure || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
}

export function setSessionCookie(req: Request, res: Response, token: string): void {
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 24 * 60 * 60}${secureSuffix(req)}`);
}

export function clearSessionCookie(req: Request, res: Response): void {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureSuffix(req)}`);
}

// ───────────────────────── Deneme sınırı ─────────────────────────

const WINDOW_MS = 15 * 60 * 1000;
const LIMITS = { pair: 8, email: 20, ip: 40 };
const failures = new Map<string, { count: number; resetAt: number }>();

function bucketKeys(ip: string, email: string): { key: string; limit: number }[] {
  return [
    { key: `p:${ip}|${email}`, limit: LIMITS.pair },
    { key: `e:${email}`, limit: LIMITS.email },
    { key: `i:${ip}`, limit: LIMITS.ip },
  ];
}

/** Şifre denemeye başlamadan önce çağrılır; sınır aşıldıysa bekleme süresiyle birlikte reddeder. */
export function assertLoginAllowed(ip: string, email: string): void {
  const nowMs = Date.now();
  for (const { key, limit } of bucketKeys(ip, email)) {
    const entry = failures.get(key);
    if (!entry) continue;
    if (entry.resetAt <= nowMs) {
      failures.delete(key);
      continue;
    }
    if (entry.count >= limit) {
      const minutes = Math.max(1, Math.ceil((entry.resetAt - nowMs) / 60000));
      throw new TooMany(`Çok fazla hatalı deneme yapıldı. ${minutes} dakika sonra yeniden deneyin.`);
    }
  }
}

export function recordLoginFailure(ip: string, email: string): void {
  const nowMs = Date.now();
  if (failures.size > 5000) {
    for (const [key, entry] of failures) if (entry.resetAt <= nowMs) failures.delete(key);
  }
  for (const { key } of bucketKeys(ip, email)) {
    const entry = failures.get(key);
    if (entry && entry.resetAt > nowMs) entry.count++;
    else failures.set(key, { count: 1, resetAt: nowMs + WINDOW_MS });
  }
}

export function clearLoginFailures(ip: string, email: string): void {
  failures.delete(`p:${ip}|${email}`);
  failures.delete(`e:${email}`);
}
