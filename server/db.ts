import { DatabaseSync, type StatementSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ensureDirs, paths } from './config.ts';

type Param = string | number | bigint | null | Uint8Array;
export type Row = Record<string, unknown>;

let db: DatabaseSync | null = null;
let statements = new Map<string, StatementSync>();

/** Şema sürümleri sırayla uygulanır; uygulanmış bir sürüm asla değiştirilmez. */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE assets (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    source TEXT NOT NULL,
    filename TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL DEFAULT 0,
    width INTEGER,
    height INTEGER,
    duration REAL,
    sha256 TEXT NOT NULL,
    path TEXT NOT NULL,
    thumb TEXT,
    title TEXT,
    prompt TEXT,
    model TEXT,
    provider TEXT,
    params TEXT,
    parent_id TEXT,
    job_id TEXT,
    favorite INTEGER NOT NULL DEFAULT 0,
    tags TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    deleted_at TEXT
  );
  CREATE INDEX assets_created ON assets(created_at DESC);
  CREATE INDEX assets_sha ON assets(sha256);
  CREATE INDEX assets_job ON assets(job_id);

  CREATE TABLE entities (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    name TEXT NOT NULL,
    handle TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    profile TEXT NOT NULL DEFAULT '',
    data TEXT NOT NULL DEFAULT '{}',
    avatar_asset_id TEXT,
    pinned INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );
  CREATE UNIQUE INDEX entities_handle ON entities(handle) WHERE deleted_at IS NULL;

  CREATE TABLE entity_assets (
    entity_id TEXT NOT NULL,
    asset_id TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'reference',
    position INTEGER NOT NULL DEFAULT 0,
    note TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (entity_id, asset_id)
  );
  CREATE INDEX entity_assets_asset ON entity_assets(asset_id);

  CREATE TABLE memories (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'fact',
    entity_id TEXT,
    source TEXT NOT NULL DEFAULT 'manual',
    source_message_id TEXT,
    pinned INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );
  CREATE INDEX memories_entity ON memories(entity_id);

  CREATE TABLE conversations (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '',
    pinned INTEGER NOT NULL DEFAULT 0,
    brand_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );
  CREATE INDEX conversations_updated ON conversations(updated_at DESC);

  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    parts TEXT NOT NULL DEFAULT '[]',
    mode TEXT NOT NULL DEFAULT 'auto',
    mentions TEXT NOT NULL DEFAULT '[]',
    attachments TEXT NOT NULL DEFAULT '[]',
    options TEXT NOT NULL DEFAULT '{}',
    model TEXT,
    status TEXT NOT NULL DEFAULT 'done',
    error TEXT,
    usage TEXT,
    seq INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE INDEX messages_conversation ON messages(conversation_id, seq);

  CREATE TABLE jobs (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    status TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    model_label TEXT NOT NULL DEFAULT '',
    input TEXT NOT NULL DEFAULT '{}',
    asset_ids TEXT NOT NULL DEFAULT '[]',
    external_id TEXT,
    external_meta TEXT,
    progress REAL,
    stage TEXT,
    error TEXT,
    conversation_id TEXT,
    message_id TEXT,
    post_id TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT
  );
  CREATE INDEX jobs_status ON jobs(status);
  CREATE INDEX jobs_message ON jobs(message_id);
  CREATE INDEX jobs_conversation ON jobs(conversation_id);

  CREATE TABLE posts (
    id TEXT PRIMARY KEY,
    brand_id TEXT,
    title TEXT NOT NULL DEFAULT '',
    platform TEXT NOT NULL DEFAULT 'instagram',
    format TEXT NOT NULL DEFAULT 'portrait',
    caption TEXT NOT NULL DEFAULT '',
    hashtags TEXT NOT NULL DEFAULT '[]',
    asset_ids TEXT NOT NULL DEFAULT '[]',
    image_prompt TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'draft',
    scheduled_at TEXT,
    notes TEXT NOT NULL DEFAULT '',
    design_id TEXT,
    conversation_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );
  CREATE INDEX posts_scheduled ON posts(scheduled_at);

  CREATE TABLE designs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    doc TEXT NOT NULL DEFAULT '{}',
    asset_id TEXT,
    post_id TEXT,
    brand_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );

  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE cache (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE usage_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    kind TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    units INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX usage_ts ON usage_log(ts);
  `,
  // v2 — kampanyalar, kaydırmalı gönderiler, sonuç ölçümleri ve onay bağlantıları.
  `
  ALTER TABLE posts ADD COLUMN campaign_id TEXT;
  ALTER TABLE posts ADD COLUMN data TEXT NOT NULL DEFAULT '{}';
  CREATE INDEX posts_campaign ON posts(campaign_id);

  CREATE TABLE campaigns (
    id TEXT PRIMARY KEY,
    brand_id TEXT,
    title TEXT NOT NULL DEFAULT '',
    brief TEXT NOT NULL DEFAULT '',
    data TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    deleted_at TEXT
  );

  CREATE TABLE reviews (
    token TEXT PRIMARY KEY,
    post_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    reviewer TEXT NOT NULL DEFAULT '',
    comment TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    decided_at TEXT
  );
  CREATE INDEX reviews_post ON reviews(post_id);
  `,
];

function handle(): DatabaseSync {
  if (!db) throw new Error('Veritabanı açık değil');
  return db;
}

function clean(value: unknown): Param {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'string') return value;
  if (value instanceof Uint8Array) return value;
  return JSON.stringify(value);
}

function statement(sql: string): StatementSync {
  let stmt = statements.get(sql);
  if (!stmt) {
    stmt = handle().prepare(sql);
    statements.set(sql, stmt);
  }
  return stmt;
}

export function run(sql: string, ...params: unknown[]): { changes: number } {
  const result = statement(sql).run(...params.map(clean));
  return { changes: Number(result.changes) };
}

export function get<T = Row>(sql: string, ...params: unknown[]): T | undefined {
  return statement(sql).get(...params.map(clean)) as T | undefined;
}

export function all<T = Row>(sql: string, ...params: unknown[]): T[] {
  return statement(sql).all(...params.map(clean)) as T[];
}

export function exec(sql: string): void {
  handle().exec(sql);
}

let depth = 0;

/** Eşzamanlı işlem. İç içe çağrılar en dıştaki işleme katılır. */
export function tx<T>(fn: () => T): T {
  if (depth > 0) return fn();
  handle().exec('BEGIN IMMEDIATE');
  depth++;
  try {
    const result = fn();
    handle().exec('COMMIT');
    return result;
  } catch (error) {
    handle().exec('ROLLBACK');
    throw error;
  } finally {
    depth--;
  }
}

export function now(): string {
  return new Date().toISOString();
}

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

/** Zamana göre sıralanabilen kısa kimlik: ön ek + zaman damgası + rastgele kuyruk. */
export function newId(prefix: string): string {
  let time = Date.now();
  let stamp = '';
  for (let i = 0; i < 9; i++) {
    stamp = ALPHABET[time % 32] + stamp;
    time = Math.floor(time / 32);
  }
  const bytes = crypto.randomBytes(8);
  let tail = '';
  for (const byte of bytes) tail += ALPHABET[byte % 32];
  return `${prefix}_${stamp}${tail}`;
}

export function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || !value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function userVersion(): number {
  const row = handle().prepare('PRAGMA user_version').get() as { user_version: number };
  return Number(row.user_version);
}

export function schemaVersion(): number {
  return userVersion();
}

export function isOpen(): boolean {
  return db !== null;
}

export function closeDb(): void {
  if (!db) return;
  statements = new Map();
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch {
    // Kapanışta denetim noktası alınamazsa WAL dosyası bir sonraki açılışta işlenir.
  }
  db.close();
  db = null;
}

/** Tutarlı bir anlık kopya üretir; veritabanı kullanımdayken de güvenlidir. */
export function snapshotTo(file: string): void {
  if (fs.existsSync(file)) fs.rmSync(file);
  handle().exec(`VACUUM INTO '${file.replaceAll("'", "''")}'`);
}

export function integrityCheck(): boolean {
  try {
    const row = handle().prepare('PRAGMA quick_check').get() as Record<string, unknown> | undefined;
    return !!row && Object.values(row)[0] === 'ok';
  } catch {
    return false;
  }
}

export interface OpenResult {
  created: boolean;
  migratedFrom: number | null;
}

export function openDb(): OpenResult {
  ensureDirs();
  const existed = fs.existsSync(paths.db);
  db = new DatabaseSync(paths.db);
  statements = new Map();
  // WAL + FULL: işlem tamamlandı dendiği anda veri diske yazılmıştır; elektrik
  // kesilse bile onaylanmış kayıt kaybolmaz.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = FULL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');

  const current = userVersion();
  let migratedFrom: number | null = null;
  if (current < MIGRATIONS.length) {
    if (existed && current > 0) {
      // Şema değişmeden önce mevcut hâlin kopyasını al.
      migratedFrom = current;
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      snapshotTo(path.join(paths.backups, `bellek-${stamp}-surum${current}.db`));
    }
    for (let version = current; version < MIGRATIONS.length; version++) {
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec(MIGRATIONS[version]);
        db.exec(`PRAGMA user_version = ${version + 1}`);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    }
  }
  return { created: !existed, migratedFrom };
}
