import { handleCandidates, normalizeHandle } from '../../shared/handles.ts';
import type {
  Asset, Entity, EntityAsset, EntityAssetRole, EntityData, EntityDetail, EntityType, Memory, MemoryCategory,
} from '../../shared/types.ts';
import { all, get, newId, now, parseJson, run, tx, type Row } from '../db.ts';
import { emit } from '../events.ts';
import { hydrateAssets } from '../storage.ts';

const TYPES: EntityType[] = ['person', 'brand', 'product', 'style', 'place'];
const ROLES: EntityAssetRole[] = ['reference', 'logo', 'example'];

export class NotFound extends Error {}
export class Invalid extends Error {}

// ───────────────────────── Varlıklar ─────────────────────────

interface LinkRow {
  entity_id: string;
  asset_id: string;
  thumb: string | null;
  kind: string;
}

function previews(entityIds: string[]): Map<string, LinkRow[]> {
  const map = new Map<string, LinkRow[]>();
  if (!entityIds.length) return map;
  const rows = all<LinkRow>(
    `SELECT ea.entity_id, ea.asset_id, a.thumb, a.kind
       FROM entity_assets ea JOIN assets a ON a.id = ea.asset_id AND a.deleted_at IS NULL
      WHERE ea.entity_id IN (${entityIds.map(() => '?').join(',')})
      ORDER BY ea.entity_id, CASE ea.role WHEN 'logo' THEN 0 WHEN 'reference' THEN 1 ELSE 2 END, ea.position, ea.created_at`,
    ...entityIds,
  );
  for (const row of rows) {
    const list = map.get(row.entity_id) ?? [];
    list.push(row);
    map.set(row.entity_id, list);
  }
  return map;
}

function thumbOf(assetId: string): string {
  return `/media/${assetId}/thumb`;
}

function toEntity(row: Row, links: LinkRow[]): Entity {
  const avatarId = (row.avatar_asset_id as string | null) ?? null;
  const avatar = links.find((l) => l.asset_id === avatarId) ?? links[0];
  return {
    id: String(row.id),
    type: row.type as EntityType,
    name: String(row.name),
    handle: String(row.handle),
    description: String(row.description ?? ''),
    profile: String(row.profile ?? ''),
    data: parseJson<EntityData>(row.data, {}),
    avatarAssetId: avatar?.asset_id ?? null,
    avatarUrl: avatar ? thumbOf(avatar.asset_id) : null,
    previewUrls: links.slice(0, 4).map((l) => thumbOf(l.asset_id)),
    pinned: !!row.pinned,
    assetCount: links.length,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    deletedAt: (row.deleted_at as string | null) ?? null,
  };
}

function hydrateEntities(rows: Row[]): Entity[] {
  const links = previews(rows.map((r) => String(r.id)));
  return rows.map((row) => toEntity(row, links.get(String(row.id)) ?? []));
}

export function listEntities(type?: string): Entity[] {
  const rows = type
    ? all<Row>(`SELECT * FROM entities WHERE deleted_at IS NULL AND type = ? ORDER BY pinned DESC, name COLLATE NOCASE`, type)
    : all<Row>(`SELECT * FROM entities WHERE deleted_at IS NULL ORDER BY pinned DESC, name COLLATE NOCASE`);
  return hydrateEntities(rows);
}

export function getEntity(id: string): Entity | undefined {
  const row = get<Row>(`SELECT * FROM entities WHERE id = ?`, id);
  return row ? hydrateEntities([row])[0] : undefined;
}

export function getEntities(ids: string[]): Entity[] {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return [];
  const rows = all<Row>(
    `SELECT * FROM entities WHERE deleted_at IS NULL AND id IN (${unique.map(() => '?').join(',')})`,
    ...unique,
  );
  const byId = new Map(hydrateEntities(rows).map((e) => [e.id, e]));
  return unique.map((id) => byId.get(id)).filter((e): e is Entity => !!e);
}

export function getEntityByHandle(handle: string): Entity | undefined {
  const row = get<Row>(`SELECT * FROM entities WHERE handle = ? AND deleted_at IS NULL`, normalizeHandle(handle));
  return row ? hydrateEntities([row])[0] : undefined;
}

function freeHandle(name: string, wanted?: string, exceptId?: string): string {
  const taken = (handle: string): boolean => {
    const row = get<{ id: string }>(`SELECT id FROM entities WHERE handle = ? AND deleted_at IS NULL`, handle);
    return !!row && row.id !== exceptId;
  };
  if (wanted) {
    const handle = normalizeHandle(wanted);
    if (!handle) throw new Invalid('Kimlik yalnızca harf, rakam, nokta, tire ve alt çizgi içerebilir.');
    if (taken(handle)) throw new Invalid(`@${handle} kimliği başka bir varlıkta kullanılıyor.`);
    return handle;
  }
  const candidates = handleCandidates(name);
  for (const candidate of candidates) if (!taken(candidate)) return candidate;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${candidates[0]}${n}`;
    if (!taken(candidate)) return candidate;
  }
  return `${candidates[0]}-${Date.now()}`;
}

export interface EntityInput {
  type?: EntityType;
  name?: string;
  handle?: string;
  description?: string;
  profile?: string;
  data?: EntityData;
  pinned?: boolean;
  avatarAssetId?: string | null;
}

export function createEntity(input: EntityInput & { assetIds?: string[]; role?: EntityAssetRole }): Entity {
  const name = (input.name ?? '').trim();
  if (!name) throw new Invalid('Bir ad girin.');
  const type = TYPES.includes(input.type as EntityType) ? (input.type as EntityType) : 'person';
  const id = newId('en');
  const stamp = now();
  tx(() => {
    run(
      `INSERT INTO entities (id, type, name, handle, description, profile, data, pinned, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, type, name, freeHandle(name, input.handle), input.description?.trim() ?? '', input.profile?.trim() ?? '',
      JSON.stringify(input.data ?? {}), !!input.pinned, stamp, stamp,
    );
    if (input.assetIds?.length) linkAssets(id, input.assetIds, input.role ?? 'reference');
  });
  emit({ type: 'entity.changed', entityId: id });
  return getEntity(id)!;
}

export function updateEntity(id: string, patch: EntityInput): Entity {
  const row = get<Row>(`SELECT * FROM entities WHERE id = ?`, id);
  if (!row) throw new NotFound('Varlık bulunamadı.');
  const name = patch.name !== undefined ? patch.name.trim() : String(row.name);
  if (!name) throw new Invalid('Ad boş olamaz.');
  const handle =
    patch.handle !== undefined && normalizeHandle(patch.handle) !== row.handle
      ? freeHandle(name, patch.handle, id)
      : String(row.handle);
  const data = patch.data !== undefined ? { ...parseJson<EntityData>(row.data, {}), ...patch.data } : parseJson<EntityData>(row.data, {});
  run(
    `UPDATE entities SET type = ?, name = ?, handle = ?, description = ?, profile = ?, data = ?, pinned = ?,
            avatar_asset_id = ?, updated_at = ? WHERE id = ?`,
    patch.type && TYPES.includes(patch.type) ? patch.type : row.type,
    name, handle,
    patch.description !== undefined ? patch.description : row.description,
    patch.profile !== undefined ? patch.profile : row.profile,
    JSON.stringify(data),
    patch.pinned !== undefined ? patch.pinned : row.pinned,
    patch.avatarAssetId !== undefined ? patch.avatarAssetId : row.avatar_asset_id,
    now(), id,
  );
  emit({ type: 'entity.changed', entityId: id });
  return getEntity(id)!;
}

export function deleteEntity(id: string): void {
  run(`UPDATE entities SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL`, now(), id);
  emit({ type: 'entity.changed', entityId: id });
}

export function restoreEntity(id: string): void {
  const row = get<Row>(`SELECT * FROM entities WHERE id = ?`, id);
  if (!row) throw new NotFound('Varlık bulunamadı.');
  // Çöpteyken kimliği başkası aldıysa çakışmayı yeni bir kimlikle çöz.
  const handle = freeHandle(String(row.name), undefined, id);
  const clash = get<{ id: string }>(`SELECT id FROM entities WHERE handle = ? AND deleted_at IS NULL`, row.handle);
  run(`UPDATE entities SET deleted_at = NULL, handle = ? WHERE id = ?`, clash ? handle : row.handle, id);
  emit({ type: 'entity.changed', entityId: id });
}

export function linkAssets(entityId: string, assetIds: string[], role: EntityAssetRole = 'reference'): void {
  const safeRole = ROLES.includes(role) ? role : 'reference';
  tx(() => {
    const max = get<{ p: number | null }>(`SELECT MAX(position) AS p FROM entity_assets WHERE entity_id = ?`, entityId);
    let position = (max?.p ?? -1) + 1;
    for (const assetId of assetIds) {
      const result = run(
        `INSERT OR IGNORE INTO entity_assets (entity_id, asset_id, role, position, created_at) VALUES (?, ?, ?, ?, ?)`,
        entityId, assetId, safeRole, position, now(),
      );
      if (result.changes) position++;
    }
    run(`UPDATE entities SET updated_at = ? WHERE id = ?`, now(), entityId);
  });
  emit({ type: 'entity.changed', entityId });
}

export function unlinkAsset(entityId: string, assetId: string): void {
  tx(() => {
    run(`DELETE FROM entity_assets WHERE entity_id = ? AND asset_id = ?`, entityId, assetId);
    run(`UPDATE entities SET avatar_asset_id = NULL WHERE id = ? AND avatar_asset_id = ?`, entityId, assetId);
    run(`UPDATE entities SET updated_at = ? WHERE id = ?`, now(), entityId);
  });
  emit({ type: 'entity.changed', entityId });
}

export function updateLink(entityId: string, assetId: string, patch: { role?: EntityAssetRole; note?: string | null }): void {
  if (patch.role && ROLES.includes(patch.role)) {
    run(`UPDATE entity_assets SET role = ? WHERE entity_id = ? AND asset_id = ?`, patch.role, entityId, assetId);
  }
  if (patch.note !== undefined) {
    run(`UPDATE entity_assets SET note = ? WHERE entity_id = ? AND asset_id = ?`, patch.note, entityId, assetId);
  }
  emit({ type: 'entity.changed', entityId });
}

export function reorderAssets(entityId: string, orderedIds: string[]): void {
  tx(() => {
    orderedIds.forEach((assetId, index) => {
      run(`UPDATE entity_assets SET position = ? WHERE entity_id = ? AND asset_id = ?`, index, entityId, assetId);
    });
  });
  emit({ type: 'entity.changed', entityId });
}

export function entityAssets(entityId: string): EntityAsset[] {
  const rows = all<Row>(
    `SELECT a.*, ea.role AS link_role, ea.position AS link_position, ea.note AS link_note
       FROM entity_assets ea JOIN assets a ON a.id = ea.asset_id AND a.deleted_at IS NULL
      WHERE ea.entity_id = ?
      ORDER BY CASE ea.role WHEN 'logo' THEN 0 WHEN 'reference' THEN 1 ELSE 2 END, ea.position, ea.created_at`,
    entityId,
  );
  const assets = hydrateAssets(rows);
  return assets.map((asset, index) => ({
    ...asset,
    role: rows[index].link_role as EntityAssetRole,
    position: Number(rows[index].link_position),
    note: (rows[index].link_note as string | null) ?? null,
  }));
}

export function getEntityDetail(id: string): EntityDetail | undefined {
  const entity = getEntity(id);
  if (!entity) return undefined;
  // Bu varlıkla yapılmış işlerin çıktıları: işin girdisindeki entityIds alanına bakılır.
  const generationRows = all<Row>(
    `SELECT a.* FROM assets a JOIN jobs j ON j.id = a.job_id
      WHERE a.deleted_at IS NULL AND EXISTS (SELECT 1 FROM json_each(j.input, '$.entityIds') WHERE value = ?)
      ORDER BY a.created_at DESC LIMIT 60`,
    id,
  );
  return {
    ...entity,
    assets: entityAssets(id),
    memories: listMemories({ entityId: id }),
    generations: hydrateAssets(generationRows),
  };
}

/** Üretimde referans olarak gönderilecek görseller, öncelik sırasıyla. */
export function referenceAssets(entityId: string, limit: number): { asset: Asset; role: EntityAssetRole }[] {
  const entity = getEntity(entityId);
  const links = entityAssets(entityId).filter((a) => a.kind === 'image');
  if (!entity) return [];
  // Kapak seçilmişse en güçlü referans odur; öne al.
  links.sort((a, b) => Number(b.id === entity.avatarAssetId) - Number(a.id === entity.avatarAssetId));
  return links.slice(0, limit).map((asset) => ({ asset, role: asset.role }));
}

// ───────────────────────── Hafıza notları ─────────────────────────

const CATEGORIES: MemoryCategory[] = ['fact', 'preference', 'style', 'rule'];

function toMemory(row: Row): Memory {
  return {
    id: String(row.id),
    content: String(row.content),
    category: row.category as MemoryCategory,
    entityId: (row.entity_id as string | null) ?? null,
    source: row.source === 'auto' ? 'auto' : 'manual',
    pinned: !!row.pinned,
    enabled: !!row.enabled,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    deletedAt: (row.deleted_at as string | null) ?? null,
  };
}

export function listMemories(filter: { entityId?: string; enabledOnly?: boolean } = {}): Memory[] {
  const where = ['deleted_at IS NULL'];
  const params: unknown[] = [];
  if (filter.entityId) {
    where.push('entity_id = ?');
    params.push(filter.entityId);
  }
  if (filter.enabledOnly) where.push('enabled = 1');
  return all<Row>(
    `SELECT * FROM memories WHERE ${where.join(' AND ')} ORDER BY pinned DESC, created_at DESC`,
    ...params,
  ).map(toMemory);
}

export function getMemory(id: string): Memory | undefined {
  const row = get<Row>(`SELECT * FROM memories WHERE id = ?`, id);
  return row ? toMemory(row) : undefined;
}

export function createMemory(input: {
  content: string; category?: string; entityId?: string | null; source?: 'manual' | 'auto';
  sourceMessageId?: string | null; pinned?: boolean;
}): Memory {
  const content = input.content.trim();
  if (!content) throw new Invalid('Not boş olamaz.');
  const id = newId('me');
  const stamp = now();
  run(
    `INSERT INTO memories (id, content, category, entity_id, source, source_message_id, pinned, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, content, CATEGORIES.includes(input.category as MemoryCategory) ? input.category : 'fact',
    input.entityId ?? null, input.source ?? 'manual', input.sourceMessageId ?? null, !!input.pinned, stamp, stamp,
  );
  emit({ type: 'memory.changed' });
  return getMemory(id)!;
}

export function updateMemory(id: string, patch: Partial<Pick<Memory, 'content' | 'category' | 'entityId' | 'pinned' | 'enabled'>>): Memory {
  const row = get<Row>(`SELECT * FROM memories WHERE id = ?`, id);
  if (!row) throw new NotFound('Not bulunamadı.');
  run(
    `UPDATE memories SET content = ?, category = ?, entity_id = ?, pinned = ?, enabled = ?, updated_at = ? WHERE id = ?`,
    patch.content !== undefined ? patch.content.trim() || row.content : row.content,
    patch.category && CATEGORIES.includes(patch.category) ? patch.category : row.category,
    patch.entityId !== undefined ? patch.entityId : row.entity_id,
    patch.pinned !== undefined ? patch.pinned : row.pinned,
    patch.enabled !== undefined ? patch.enabled : row.enabled,
    now(), id,
  );
  emit({ type: 'memory.changed' });
  return getMemory(id)!;
}

export function deleteMemory(id: string): void {
  run(`UPDATE memories SET deleted_at = ? WHERE id = ?`, now(), id);
  emit({ type: 'memory.changed' });
}
