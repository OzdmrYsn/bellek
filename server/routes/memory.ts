import { Router } from 'express';
import type { EntityAssetRole } from '../../shared/types.ts';
import { extractBrand, generateProfile, importBrandSite, learnFromFavorites } from '../ai/tasks.ts';
import {
  NotFound, createEntity, createMemory, deleteEntity, deleteMemory, getEntityDetail, linkAssets, listEntities,
  listMemories, reorderAssets, unlinkAsset, updateEntity, updateLink, updateMemory, type EntityInput,
} from '../repo/entities.ts';
import { query } from './library.ts';

export const entityRouter = Router();
export const memoryRouter = Router();

entityRouter.get('/', (req, res) => {
  res.json(listEntities(query(req, 'type') || undefined));
});

entityRouter.post('/', (req, res) => {
  const body = req.body as EntityInput & { assetIds?: string[]; role?: EntityAssetRole };
  res.status(201).json(createEntity(body));
});

entityRouter.get('/:id', (req, res) => {
  const detail = getEntityDetail(req.params.id);
  if (!detail) throw new NotFound('Varlık bulunamadı.');
  res.json(detail);
});

entityRouter.patch('/:id', (req, res) => {
  updateEntity(req.params.id, req.body as EntityInput);
  res.json(getEntityDetail(req.params.id));
});

entityRouter.delete('/:id', (req, res) => {
  deleteEntity(req.params.id);
  res.json({ ok: true });
});

entityRouter.post('/:id/assets', (req, res) => {
  const body = req.body as { assetIds?: string[]; role?: EntityAssetRole };
  linkAssets(req.params.id, body.assetIds ?? [], body.role ?? 'reference');
  res.json(getEntityDetail(req.params.id));
});

entityRouter.patch('/:id/assets/:assetId', (req, res) => {
  updateLink(req.params.id, req.params.assetId, req.body as { role?: EntityAssetRole; note?: string | null });
  res.json(getEntityDetail(req.params.id));
});

entityRouter.delete('/:id/assets/:assetId', (req, res) => {
  unlinkAsset(req.params.id, req.params.assetId);
  res.json(getEntityDetail(req.params.id));
});

entityRouter.post('/:id/reorder', (req, res) => {
  reorderAssets(req.params.id, (req.body as { assetIds?: string[] }).assetIds ?? []);
  res.json(getEntityDetail(req.params.id));
});

entityRouter.post('/:id/profile', async (req, res) => {
  await generateProfile(req.params.id);
  res.json(getEntityDetail(req.params.id));
});

entityRouter.post('/:id/brand-extract', async (req, res) => {
  await extractBrand(req.params.id, String((req.body as { text?: string }).text ?? ''));
  res.json(getEntityDetail(req.params.id));
});

/** Markanın web sitesinden logo, renk, yazı tipi ve tanıtım metnini çeker. */
entityRouter.post('/:id/brand-site', async (req, res) => {
  const result = await importBrandSite(req.params.id, String((req.body as { url?: string }).url ?? ''));
  res.json({ entity: getEntityDetail(req.params.id), summary: result.summary });
});

memoryRouter.post('/learn', async (_req, res) => {
  res.json(await learnFromFavorites());
});

memoryRouter.get('/', (req, res) => {
  res.json(listMemories({ entityId: query(req, 'entity') || undefined }));
});

memoryRouter.post('/', (req, res) => {
  const body = req.body as { content?: string; category?: string; entityId?: string | null; pinned?: boolean };
  res.status(201).json(createMemory({ content: body.content ?? '', category: body.category, entityId: body.entityId, pinned: body.pinned }));
});

memoryRouter.patch('/:id', (req, res) => {
  res.json(updateMemory(req.params.id, req.body));
});

memoryRouter.delete('/:id', (req, res) => {
  deleteMemory(req.params.id);
  res.json({ ok: true });
});
