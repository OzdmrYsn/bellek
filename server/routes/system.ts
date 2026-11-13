import { Router } from 'express';
import { spawn } from 'node:child_process';
import type { Bootstrap, ModelConfig, ModelKind, Settings, TrashItem } from '../../shared/types.ts';
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
  addCustomProvider, getProvider, getSettings, listModels, listProviders, removeModel, removeProvider, saveProvider,
  setModelEnabled, updateSettings, upsertModel, usageReport, type ProviderPatch,
} from '../settings.ts';
import { FFMPEG, purgeAsset } from '../storage.ts';
import { query, upload } from './library.ts';

export const systemRouter = Router();

function count(table: string): number {
  return Number(get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE deleted_at IS NULL`)?.n ?? 0);
}

function bootstrap(): Bootstrap {
  return {
    app: {
      name: APP_NAME, version: APP_VERSION, dataDir: DATA_DIR, mock: MOCK, ffmpeg: !!FFMPEG,
      // Onay bağlantıları yalnızca sunucu ağa açıksa başkalarınca açılabilir.
      local: HOST === '127.0.0.1' || HOST === 'localhost',
      fal: !!listProviders().find((p) => p.id === 'fal' && p.enabled && p.hasKey),
    },
    settings: getSettings(),
    providers: listProviders(),
    models: listModels(),
    entities: listEntities(),
    conversations: listConversations(),
    counts: {
      assets: count('assets'),
      entities: count('entities'),
      memories: count('memories'),
      posts: count('posts'),
      trash: trashCount(),
    },
    backup: { lastBackupAt: lastBackupAt(), integrity: currentIntegrity() },
  };
}

systemRouter.get('/bootstrap', (_req, res) => {
  res.json(bootstrap());
});

systemRouter.get('/events', (_req, res) => {
  subscribe(res);
});

systemRouter.get('/search', (req, res) => {
  res.json(search(query(req, 'q')));
});

// ───────────────────────── Ayarlar ─────────────────────────

systemRouter.get('/settings', (_req, res) => {
  res.json(getSettings());
});

systemRouter.patch('/settings', (req, res) => {
  res.json(updateSettings(req.body as Partial<Settings>));
});

systemRouter.get('/usage', (req, res) => {
  res.json(usageReport(Math.min(365, Math.max(1, Number(query(req, 'days')) || 30))));
});

// ───────────────────────── Sağlayıcılar ─────────────────────────

function providersPayload() {
  return { providers: listProviders(), models: listModels() };
}

systemRouter.get('/providers', (_req, res) => {
  res.json(providersPayload());
});

systemRouter.post('/providers', (req, res) => {
  addCustomProvider(req.body as { name: string; baseUrl: string; apiKey?: string });
  res.status(201).json(providersPayload());
});

systemRouter.patch('/providers/:id', (req, res) => {
  saveProvider(req.params.id, req.body as ProviderPatch);
  res.json(providersPayload());
});

systemRouter.delete('/providers/:id', (req, res) => {
  removeProvider(req.params.id);
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

systemRouter.get('/backup', async (_req, res) => {
  res.json(await backupStatus());
});

systemRouter.post('/backup/run', async (_req, res) => {
  await runBackup('manuel');
  res.json(await backupStatus());
});

systemRouter.post('/backup/restore', async (req, res) => {
  await restoreBackup(String((req.body as { name?: string }).name ?? ''));
  res.json(await backupStatus());
});

systemRouter.get('/backup/export', async (_req, res) => {
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="bellek-${stamp}.zip"`);
  await exportArchive(res);
});

systemRouter.post('/backup/import', upload.single('file'), async (req, res) => {
  if (!req.file) throw new Invalid('Bir ZIP dosyası seçin.');
  const result = await importArchive(req.file.path);
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

systemRouter.get('/trash', (_req, res) => {
  res.json(listTrash());
});

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
  const body = req.body as { kind: TrashItem['kind']; id: string };
  restoreItem(body.kind, body.id);
  res.json(listTrash());
});

systemRouter.post('/trash/purge', async (req, res) => {
  const body = req.body as { kind: TrashItem['kind']; id: string };
  await purgeItem(body.kind, body.id);
  res.json(listTrash());
});

systemRouter.post('/trash/empty', async (_req, res) => {
  // Kalıcı silmeden önce son bir güvenlik kopyası al.
  await runBackup('manuel');
  for (const item of listTrash()) await purgeItem(item.kind, item.id);
  res.json(listTrash());
});

export function deletedAssetIds(): string[] {
  return all<{ id: string }>(`SELECT id FROM assets WHERE deleted_at IS NOT NULL`).map((r) => r.id);
}
