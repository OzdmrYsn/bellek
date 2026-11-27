import { Router } from 'express';
import { spawn } from 'node:child_process';
import { can, type Permission } from '../../shared/permissions.ts';
import type { Bootstrap, ModelConfig, ModelKind, Settings, TrashItem } from '../../shared/types.ts';
import { assertConversation, conversationAccess, conversationOwnerFilter } from '../access.ts';
import { actorOf, assertAny, need } from '../middleware/auth.ts';
import { listMembers, logActivity, teamName, toMe, type Actor } from '../repo/teams.ts';
import {
  backupStatus, currentIntegrity, exportArchive, importArchive, lastBackupAt, restoreBackup, runBackup,
} from '../backup.ts';
import { APP_NAME, APP_VERSION, DATA_DIR, HOST, MOCK } from '../config.ts';
import { all, get, run } from '../db.ts';
import { subscribe } from '../events.ts';
import { describeFalModel, searchFalCatalog } from '../providers/fal.ts';
import { createAdapter } from '../providers/index.ts';
import { ProviderError } from '../providers/types.ts';
import { listConversations, restoreConversation } from '../repo/chat.ts';
import { listTrash, purgeSimple, restoreSimple, search, trashCount } from '../repo/content.ts';
import { Invalid, NotFound, listEntities, restoreEntity } from '../repo/entities.ts';
import { getSecret } from '../secrets.ts';
import {
  addCustomProvider, getProvider, getSettings, listModels, listProviders, memberLimit, monthSpend, removeModel, removeProvider, saveProvider,
  setModelEnabled, updateSettings, upsertModel, usageReport, type ProviderPatch,
} from '../settings.ts';
import { FFMPEG, purgeAsset } from '../storage.ts';
import { query, upload } from './library.ts';

export const systemRouter = Router();

function count(table: string): number {
  return Number(get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE deleted_at IS NULL`)?.n ?? 0);
}

/** Açılış verisi kullanıcıya göre biçilir: göremeyeceği şey tarayıcıya hiç gönderilmez. */
function bootstrap(actor: Actor): Bootstrap {
  return {
    app: {
      name: APP_NAME, version: APP_VERSION, dataDir: can(actor, 'data.manage') ? DATA_DIR : '', mock: MOCK, ffmpeg: !!FFMPEG,
      // Onay bağlantıları yalnızca sunucu ağa açıksa başkalarınca açılabilir.
      local: HOST === '127.0.0.1' || HOST === 'localhost',
      fal: !!listProviders().find((p) => p.id === 'fal' && p.enabled && p.hasKey),
    },
    settings: getSettings(),
    // Model seçici herkese gerekir; sağlayıcılar ve anahtar ipuçları yalnızca yetkiliye gider.
    providers: can(actor, 'providers.view') ? listProviders() : [],
    models: listModels(),
    entities: listEntities(),
    conversations: listConversations(conversationOwnerFilter(actor)),
    counts: {
      assets: count('assets'),
      entities: count('entities'),
      memories: count('memories'),
      posts: count('posts'),
      trash: can(actor, 'trash.manage') ? trashCount() : 0,
    },
    backup: { lastBackupAt: lastBackupAt(), integrity: currentIntegrity() },
    me: toMe(actor),
    team: { name: teamName(), members: listMembers(false) },
    spend: { month: monthSpend(actor.id).spend, limit: memberLimit(actor.id) },
  };
}

systemRouter.get('/bootstrap', (req, res) => {
  res.json(bootstrap(actorOf(req)));
});

systemRouter.get('/events', (req, res) => {
  subscribe(res, actorOf(req).id, req.sessionId);
});

systemRouter.get('/search', (req, res) => {
  const actor = actorOf(req);
  res.json(search(query(req, 'q')).filter((item) => item.kind !== 'conversation' || conversationAccess(actor, item.id) !== 'none'));
});

// ───────────────────────── Ayarlar ─────────────────────────

systemRouter.get('/settings', (_req, res) => {
  res.json(getSettings());
});

systemRouter.patch('/settings', need('settings.manage'), (req, res) => {
  res.json(updateSettings(req.body as Partial<Settings>));
});

systemRouter.get('/usage', need('usage.view'), (req, res) => {
  res.json(usageReport(Math.min(365, Math.max(1, Number(query(req, 'days')) || 30))));
});

// ───────────────────────── Sağlayıcılar ─────────────────────────

function providersPayload() {
  return { providers: listProviders(), models: listModels() };
}

// Sağlayıcılar: görmek ayrı, değiştirmek ayrı yetkidir. Anahtarın tamamı hiçbir uçtan dönmez.
systemRouter.use(['/providers', '/fal'], (req, _res, next) => {
  const readOnly = req.method === 'GET' && (req.path === '/' || req.path === '');
  need(readOnly ? 'providers.view' : 'providers.manage')(req, _res, next);
});

systemRouter.get('/providers', (_req, res) => {
  res.json(providersPayload());
});

systemRouter.post('/providers', (req, res) => {
  const body = req.body as { name: string; baseUrl: string; apiKey?: string };
  addCustomProvider(body);
  logActivity(actorOf(req), 'provider.add', `“${String(body.name ?? '').slice(0, 60)}” sağlayıcısını ekledi.`);
  res.status(201).json(providersPayload());
});

systemRouter.patch('/providers/:id', (req, res) => {
  const body = req.body as ProviderPatch;
  const name = getProvider(req.params.id)?.name ?? req.params.id;
  saveProvider(req.params.id, body);
  if (body.apiKey !== undefined) {
    logActivity(actorOf(req), 'provider.key', `${name} API anahtarını ${body.apiKey ? 'değiştirdi' : 'kaldırdı'}.`);
  }
  res.json(providersPayload());
});

systemRouter.delete('/providers/:id', (req, res) => {
  const name = getProvider(req.params.id)?.name ?? req.params.id;
  removeProvider(req.params.id);
  logActivity(actorOf(req), 'provider.remove', `${name} sağlayıcısını kaldırdı.`);
  res.json(providersPayload());
});

function adapterOf(id: string) {
  const provider = getProvider(id);
  if (!provider) throw new NotFound('Sağlayıcı bulunamadı.');
  if (provider.needsKey && !provider.hasKey) throw new Invalid('Önce bir API anahtarı girin.');
  return { provider, adapter: createAdapter(provider, getSecret(provider.id)) };
}

systemRouter.post('/providers/:id/test', async (req, res) => {
  const { adapter } = adapterOf(req.params.id);
  try {
    res.json({ ok: true, message: await adapter.test() });
  } catch (error) {
    res.json({ ok: false, message: error instanceof Error ? error.message : 'Bağlantı kurulamadı.' });
  }
});

systemRouter.get('/providers/:id/remote-models', async (req, res) => {
  const { adapter, provider } = adapterOf(req.params.id);
  if (!adapter.listModels) throw new ProviderError(`${provider.name} model listesi sunmuyor; modelleri katalogdan ekleyin.`);
  const known = new Set(provider.models.map((m) => `${m.kind}:${m.id}`));
  const models = await adapter.listModels();
  res.json(models.map((m) => ({ ...m, added: known.has(`${m.kind}:${m.id}`) })));
});

systemRouter.post('/providers/:id/models', (req, res) => {
  const provider = getProvider(req.params.id);
  if (!provider) throw new NotFound('Sağlayıcı bulunamadı.');
  const body = req.body as Partial<ModelConfig>;
  const kind: ModelKind = body.kind === 'image' || body.kind === 'video' ? body.kind : 'text';
  upsertModel(provider.id, {
    id: String(body.id ?? ''),
    label: String(body.label ?? body.id ?? ''),
    kind,
    vision: kind === 'text' ? body.vision ?? true : undefined,
    maxRefs: kind === 'text' ? undefined : body.maxRefs ?? (kind === 'image' ? 8 : 1),
    durations: kind === 'video' ? body.durations ?? [5, 8, 10] : undefined,
    aspects: kind === 'video' ? body.aspects ?? ['16:9', '9:16'] : undefined,
    note: body.note,
    options: body.options,
    enabled: true,
    custom: true,
  });
  res.status(201).json(providersPayload());
});

systemRouter.patch('/providers/:id/models', (req, res) => {
  const body = req.body as { modelId?: string; enabled?: boolean };
  if (!body.modelId) throw new Invalid('Model seçilmedi.');
  setModelEnabled(req.params.id, body.modelId, !!body.enabled);
  res.json(providersPayload());
});

systemRouter.delete('/providers/:id/models', (req, res) => {
  const modelId = query(req, 'modelId');
  if (!modelId) throw new Invalid('Model seçilmedi.');
  removeModel(req.params.id, modelId);
  res.json(providersPayload());
});

systemRouter.get('/fal/catalog', async (req, res) => {
  res.json(await searchFalCatalog(query(req, 'q'), query(req, 'category')));
});

systemRouter.post('/fal/models', async (req, res) => {
  const model = await describeFalModel(String((req.body as { endpointId?: string }).endpointId ?? ''));
  upsertModel('fal', model);
  res.status(201).json({ ...providersPayload(), added: model });
});

// ───────────────────────── Yedekleme ─────────────────────────

systemRouter.use('/backup', need('data.manage'));

systemRouter.get('/backup', async (_req, res) => {
  res.json(await backupStatus());
});

systemRouter.post('/backup/run', async (_req, res) => {
  await runBackup('manuel');
  res.json(await backupStatus());
});

systemRouter.post('/backup/restore', async (req, res) => {
  const name = String((req.body as { name?: string }).name ?? '');
  await restoreBackup(name);
  logActivity(actorOf(req), 'backup.restore', `Veritabanını bir yedeğe döndürdü (${name}).`);
  res.json(await backupStatus());
});

systemRouter.get('/backup/export', async (req, res) => {
  logActivity(actorOf(req), 'backup.export', 'Tüm veriyi dışa aktardı.');
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="bellek-${stamp}.zip"`);
  await exportArchive(res);
});

systemRouter.post('/backup/import', upload.single('file'), async (req, res) => {
  if (!req.file) throw new Invalid('Bir ZIP dosyası seçin.');
  const result = await importArchive(req.file.path);
  logActivity(actorOf(req), 'backup.import', 'Bir arşivi içe aktardı.');
  res.json({ ...result, status: await backupStatus() });
});

systemRouter.post('/backup/reveal', (_req, res) => {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  try {
    spawn(command, [DATA_DIR], { detached: true, stdio: 'ignore' }).unref();
    res.json({ ok: true });
  } catch {
    res.json({ ok: false });
  }
});

// ───────────────────────── Çöp kutusu ─────────────────────────

systemRouter.get('/trash', need('trash.manage'), (_req, res) => {
  res.json(listTrash());
});

/** Bir türü silebilen, sildiğini "Geri al" ile geri de getirebilir. */
const RESTORE_BY_KIND: Record<Exclude<TrashItem['kind'], 'conversation'>, Permission> = {
  asset: 'library.delete', entity: 'memory.delete', memory: 'memory.delete', post: 'content.delete', design: 'content.delete',
};

function restoreItem(kind: TrashItem['kind'], id: string): void {
  if (kind === 'asset') run(`UPDATE assets SET deleted_at = NULL WHERE id = ?`, id);
  else if (kind === 'entity') restoreEntity(id);
  else if (kind === 'conversation') restoreConversation(id);
  else restoreSimple(kind, id);
}

async function purgeItem(kind: TrashItem['kind'], id: string): Promise<void> {
  if (kind === 'asset') {
    const row = get<{ deleted_at: string | null }>(`SELECT deleted_at FROM assets WHERE id = ?`, id);
    if (row?.deleted_at) await purgeAsset(id);
  } else purgeSimple(kind, id);
}

systemRouter.post('/trash/restore', (req, res) => {
  const actor = actorOf(req);
  const body = req.body as { kind: TrashItem['kind']; id: string };
  const manager = can(actor, 'trash.manage');
  if (!manager) {
    if (body.kind === 'conversation') assertConversation(actor, String(body.id), 'write');
    else if (RESTORE_BY_KIND[body.kind]) assertAny(req, RESTORE_BY_KIND[body.kind]);
    else throw new Invalid('Bilinmeyen öğe türü.');
  }
  restoreItem(body.kind, body.id);
  res.json(manager ? listTrash() : []);
});

systemRouter.post('/trash/purge', need('trash.manage'), async (req, res) => {
  const body = req.body as { kind: TrashItem['kind']; id: string };
  const item = listTrash().find((entry) => entry.kind === body.kind && entry.id === body.id);
  await purgeItem(body.kind, body.id);
  if (item) logActivity(actorOf(req), 'trash.purge', `“${item.title}” öğesini kalıcı olarak sildi.`);
  res.json(listTrash());
});

systemRouter.post('/trash/empty', need('trash.manage'), async (req, res) => {
  // Kalıcı silmeden önce son bir güvenlik kopyası al.
  await runBackup('manuel');
  const items = listTrash();
  for (const item of items) await purgeItem(item.kind, item.id);
  if (items.length) logActivity(actorOf(req), 'trash.empty', `Çöp kutusunu boşalttı (${items.length} öğe kalıcı olarak silindi).`);
  res.json(listTrash());
});

export function deletedAssetIds(): string[] {
  return all<{ id: string }>(`SELECT id FROM assets WHERE deleted_at IS NOT NULL`).map((r) => r.id);
}
