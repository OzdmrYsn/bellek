import { ALL_PERMISSIONS, normalizePermissions, type Permission } from '../../shared/permissions.ts';
import type { ActivityEntry, Me, TeamMember, UserRole } from '../../shared/types.ts';
import crypto from 'node:crypto';
import { hashPassword } from '../auth.ts';
import { all, get, newId, now, parseJson, run, tx, type Row } from '../db.ts';
import { readSetting, writeSetting } from '../settings.ts';
import { Invalid, NotFound } from './entities.ts';

// Tek bir takım vardır: çalışma alanının kendisi. İlk hesap sahiptir; üyeleri
// sahip (ya da takımı yönetebilen biri) e-posta ve şifre vererek açar.

/** İstek boyunca taşınan, oturumu açmış kullanıcı. */
export interface Actor {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  permissions: Permission[];
  onboarded: boolean;
  disabled: boolean;
  avatarAt: string | null;
  /** Şifreyi yönetici belirledi; üye kendi şifresini koyana kadar yalnızca hesap uçlarına erişir. */
  mustChangePassword: boolean;
}

// Profil resmi (BLOB) bilerek seçilmez; yalnızca gösterilirken okunur.
const COLUMNS = `id, email, name, role, permissions, password_hash, avatar_at, onboarded_at, disabled_at,
  last_seen_at, created_by, created_at, updated_at, must_change_password, invite_token, monthly_limit`;

function avatarUrl(id: string, avatarAt: string | null): string | null {
  if (!avatarAt) return null;
  return `/api/avatars/${id}?v=${new Date(avatarAt).getTime().toString(36)}`;
}

function rolePermissions(row: Row): Permission[] {
  return row.role === 'owner' ? [...ALL_PERMISSIONS] : normalizePermissions(parseJson<string[]>(row.permissions, []));
}

function toActor(row: Row): Actor {
  return {
    id: String(row.id),
    email: String(row.email),
    name: String(row.name ?? ''),
    role: row.role === 'owner' ? 'owner' : 'member',
    permissions: rolePermissions(row),
    onboarded: !!row.onboarded_at,
    disabled: !!row.disabled_at,
    avatarAt: (row.avatar_at as string | null) ?? null,
    mustChangePassword: !!row.must_change_password,
  };
}

export function toMe(actor: Actor): Me {
  return {
    id: actor.id,
    email: actor.email,
    name: actor.name,
    avatarUrl: avatarUrl(actor.id, actor.avatarAt),
    role: actor.role,
    permissions: actor.permissions,
    onboarded: actor.onboarded,
    mustChangePassword: actor.mustChangePassword,
  };
}

function toMember(row: Row, full: boolean): TeamMember {
  const member: TeamMember = {
    id: String(row.id),
    name: String(row.name || '') || String(row.email).split('@')[0],
    avatarUrl: avatarUrl(String(row.id), (row.avatar_at as string | null) ?? null),
    role: row.role === 'owner' ? 'owner' : 'member',
  };
  if (!full) return member;
  return {
    ...member,
    email: String(row.email),
    permissions: rolePermissions(row),
    onboarded: !!row.onboarded_at,
    disabled: !!row.disabled_at,
    lastSeenAt: (row.last_seen_at as string | null) ?? null,
    createdAt: String(row.created_at),
    monthlyLimit: row.monthly_limit === null || row.monthly_limit === undefined ? null : Number(row.monthly_limit),
    // Davet bağlantısı yalnızca üye ilk girişini tamamlayana kadar geçerlidir.
    invitePath: !row.onboarded_at && row.invite_token ? `/davet/${row.invite_token}` : null,
  };
}

/** Sınır tutarı: boş ya da sıfır "sınırsız" demektir. */
export function cleanLimit(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) throw new Invalid('Harcama sınırı sıfırdan büyük bir tutar olmalı.');
  return amount > 0 ? Math.round(amount * 100) / 100 : null;
}

/** Davet bağlantısından gelen ziyaretçiye gösterilecek kadarı: henüz katılmamış, açık bir hesap. */
export function findInvite(token: string): { email: string; name: string } | undefined {
  if (!token || token.length > 100) return undefined;
  const row = get<Row>(`SELECT email, name FROM users WHERE invite_token = ? AND onboarded_at IS NULL AND disabled_at IS NULL`, token);
  return row ? { email: String(row.email), name: String(row.name ?? '') } : undefined;
}

// ───────────────────────── Okuma ─────────────────────────

export function countUsers(): number {
  return Number(get<{ n: number }>(`SELECT COUNT(*) AS n FROM users`)?.n ?? 0);
}

export function getActor(id: string): Actor | undefined {
  const row = get<Row>(`SELECT ${COLUMNS} FROM users WHERE id = ?`, id);
  return row ? toActor(row) : undefined;
}

export function normalizeEmail(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

function assertEmail(email: string): void {
  if (email.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new Invalid('Geçerli bir e-posta adresi yazın.');
}

/** Giriş için: hesap ve şifre özeti. */
export function findLogin(email: string): { actor: Actor; passwordHash: string } | undefined {
  const row = get<Row>(`SELECT ${COLUMNS} FROM users WHERE email = ?`, normalizeEmail(email));
  return row ? { actor: toActor(row), passwordHash: String(row.password_hash) } : undefined;
}

export function passwordHashOf(id: string): string {
  return String(get<Row>(`SELECT password_hash FROM users WHERE id = ?`, id)?.password_hash ?? '');
}

export function ownerId(): string | null {
  return (get<Row>(`SELECT id FROM users WHERE role = 'owner' ORDER BY created_at LIMIT 1`)?.id as string | undefined) ?? null;
}

export function listMembers(full: boolean): TeamMember[] {
  return all<Row>(`SELECT ${COLUMNS} FROM users ORDER BY role = 'owner' DESC, created_at`)
    .filter((row) => full || !row.disabled_at)
    .map((row) => toMember(row, full));
}

export function getMember(id: string): TeamMember | undefined {
  const row = get<Row>(`SELECT ${COLUMNS} FROM users WHERE id = ?`, id);
  return row ? toMember(row, true) : undefined;
}

export function teamName(): string {
  return readSetting<string>('team.name', '');
}

export function setTeamName(name: string): string {
  const clean = name.trim().slice(0, 60);
  if (!clean) throw new Invalid('Takım adı boş olamaz.');
  writeSetting('team.name', clean);
  return clean;
}

// ───────────────────────── Yazma ─────────────────────────

export interface NewUser {
  email: string;
  password: string;
  name?: string;
  role: UserRole;
  permissions: Permission[];
  createdBy: string | null;
  /** İlk hesap kendi adını kurulumda yazar; üyeler ilk girişte tamamlar. */
  onboarded: boolean;
  monthlyLimit?: number | null;
}

export async function createUser(input: NewUser): Promise<Actor> {
  const email = normalizeEmail(input.email);
  assertEmail(email);
  if (get<Row>(`SELECT id FROM users WHERE email = ?`, email)) throw new Invalid('Bu e-posta ile zaten bir hesap var.');
  const passwordHash = await hashPassword(input.password);
  const id = newId('us');
  const stamp = now();
  // Şifresini başkası belirlediyse üye ilk girişte kendi şifresini koyar ve davet bağlantısı alır.
  const invited = !input.onboarded;
  try {
    run(
      `INSERT INTO users (id, email, name, role, permissions, password_hash, onboarded_at, created_by, created_at, updated_at,
         must_change_password, invite_token, monthly_limit)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, email, (input.name ?? '').trim().slice(0, 80), input.role, JSON.stringify(normalizePermissions(input.permissions)),
      passwordHash, input.onboarded ? stamp : null, input.createdBy, stamp, stamp,
      invited, invited ? crypto.randomBytes(24).toString('base64url') : null, input.monthlyLimit ?? null,
    );
  } catch (error) {
    // Şifre özeti hesaplanırken aynı e-posta başka bir istekle eklenmiş olabilir.
    if (/UNIQUE/i.test(String((error as Error)?.message))) throw new Invalid('Bu e-posta ile zaten bir hesap var.');
    throw error;
  }
  return getActor(id)!;
}

export interface UserPatch {
  name?: string;
  email?: string;
  permissions?: Permission[];
  disabled?: boolean;
  onboarded?: boolean;
  password?: string;
  /** Şifreyle birlikte verilir: `true` ise üye bir sonraki girişte yeni şifre belirlemek zorundadır. */
  mustChangePassword?: boolean;
  monthlyLimit?: number | null;
}

export async function updateUser(id: string, patch: UserPatch): Promise<Actor> {
  const row = get<Row>(`SELECT ${COLUMNS} FROM users WHERE id = ?`, id);
  if (!row) throw new NotFound('Üye bulunamadı.');
  let email = String(row.email);
  if (patch.email !== undefined && normalizeEmail(patch.email) !== email) {
    email = normalizeEmail(patch.email);
    assertEmail(email);
    if (get<Row>(`SELECT id FROM users WHERE email = ? AND id <> ?`, email, id)) throw new Invalid('Bu e-posta ile zaten bir hesap var.');
  }
  let name = String(row.name ?? '');
  if (patch.name !== undefined) {
    name = patch.name.trim().slice(0, 80);
    // Henüz katılmamış üyenin adı boş kalabilir; ilk girişte kendisi yazar.
    if (!name && (row.onboarded_at || patch.onboarded)) throw new Invalid('Ad boş olamaz.');
  }
  const passwordHash = patch.password !== undefined ? await hashPassword(patch.password) : String(row.password_hash);
  const stamp = now();
  const onboardedAt = patch.onboarded ? row.onboarded_at ?? stamp : row.onboarded_at;
  run(
    `UPDATE users SET email = ?, name = ?, permissions = ?, password_hash = ?, onboarded_at = ?, disabled_at = ?, updated_at = ?,
            must_change_password = ?, invite_token = ?, monthly_limit = ? WHERE id = ?`,
    email, name,
    patch.permissions !== undefined ? JSON.stringify(normalizePermissions(patch.permissions)) : row.permissions,
    passwordHash,
    onboardedAt,
    patch.disabled === undefined ? row.disabled_at : patch.disabled ? row.disabled_at ?? stamp : null,
    stamp,
    patch.mustChangePassword === undefined ? row.must_change_password : patch.mustChangePassword,
    // Üye katıldığı anda davet bağlantısı geçersiz olur.
    onboardedAt ? null : row.invite_token,
    patch.monthlyLimit === undefined ? row.monthly_limit : patch.monthlyLimit,
    id,
  );
  return getActor(id)!;
}

/** Üyeyi siler. Sohbetleri kaybolmaz: takım sahibine devredilir. */
export function deleteUser(id: string): void {
  const owner = ownerId();
  tx(() => {
    run(`UPDATE conversations SET user_id = ? WHERE user_id = ?`, owner, id);
    run(`DELETE FROM users WHERE id = ? AND role <> 'owner'`, id);
  });
}

/** Hesaplar açılmadan önce yapılmış her şey (sohbetler, işler, dosyalar, harcama) takım sahibinin olur. */
export function adoptOrphanConversations(userId: string): void {
  tx(() => {
    for (const table of ['conversations', 'jobs', 'assets', 'usage_log']) {
      run(`UPDATE ${table} SET user_id = ? WHERE user_id IS NULL`, userId);
    }
  });
}

export function setAvatar(id: string, image: Uint8Array | null): void {
  const stamp = now();
  run(`UPDATE users SET avatar = ?, avatar_at = ?, updated_at = ? WHERE id = ?`, image, image ? stamp : null, stamp, id);
}

export function getAvatar(id: string): Uint8Array | null {
  const row = get<{ avatar: Uint8Array | null }>(`SELECT avatar FROM users WHERE id = ?`, id);
  return row?.avatar ?? null;
}

// ───────────────────────── Etkinlik günlüğü ─────────────────────────

const ACTIVITY_KEEP = 3000;
let activityWrites = 0;

/** Kim, ne zaman, ne yaptı. Silme ve yetki değişiklikleri gibi geri dönüp bakılacak işler yazılır. */
export function logActivity(actor: Pick<Actor, 'id' | 'name' | 'email'> | null, action: string, summary: string): void {
  try {
    run(
      `INSERT INTO activity (ts, user_id, user_name, action, summary) VALUES (?, ?, ?, ?, ?)`,
      now(), actor?.id ?? null, actor ? actor.name || actor.email : '', action, summary.slice(0, 300),
    );
    if (++activityWrites % 200 === 0) {
      run(`DELETE FROM activity WHERE id <= (SELECT MAX(id) FROM activity) - ?`, ACTIVITY_KEEP);
    }
  } catch (error) {
    // Günlük yazılamadı diye asıl işlem başarısız sayılmaz.
    console.error('[etkinlik] kayıt yazılamadı:', error);
  }
}

export function listActivity(limit = 150): ActivityEntry[] {
  return all<Row>(`SELECT * FROM activity ORDER BY id DESC LIMIT ?`, Math.min(500, Math.max(1, limit))).map((row) => ({
    id: Number(row.id),
    at: String(row.ts),
    userId: (row.user_id as string | null) ?? null,
    userName: String(row.user_name ?? ''),
    action: String(row.action),
    summary: String(row.summary ?? ''),
  }));
}

// ───────────────────────── Geri yüklemede hesapları koruma ─────────────────────────

export interface AccountSnapshot {
  users: Row[];
  sessions: Row[];
  activity: Row[];
  teamName: string;
}

/** Yedeğe dönmeden önce çağrılır: hesaplar içerik değil, erişimdir; eski bir yedek kimseyi dışarıda bırakmamalı. */
export function snapshotAccounts(): AccountSnapshot {
  return {
    users: all<Row>(`SELECT * FROM users`),
    sessions: all<Row>(`SELECT * FROM sessions`),
    activity: all<Row>(`SELECT * FROM activity ORDER BY id`),
    teamName: teamName(),
  };
}

function insertRows(table: string, rows: Row[]): void {
  for (const row of rows) {
    const keys = Object.keys(row);
    run(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`, ...keys.map((key) => row[key]));
  }
}

/** Geri yüklenen veritabanına şimdiki hesapları yazar; sahipsiz kalan sohbetleri takım sahibine verir. */
export function restoreAccounts(snapshot: AccountSnapshot): void {
  if (!snapshot.users.length) return;
  tx(() => {
    run(`DELETE FROM sessions`);
    run(`DELETE FROM users`);
    run(`DELETE FROM activity`);
    insertRows('users', snapshot.users);
    insertRows('sessions', snapshot.sessions);
    insertRows('activity', snapshot.activity);
    if (snapshot.teamName) writeSetting('team.name', snapshot.teamName);
    const owner = ownerId();
    run(`UPDATE conversations SET user_id = ? WHERE user_id IS NULL OR user_id NOT IN (SELECT id FROM users)`, owner);
  });
}
