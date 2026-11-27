import { Router } from 'express';
import type { EntityAssetRole } from '../../shared/types.ts';
import { extractBrand, generateProfile, importBrandSite, learnFromFavorites } from '../ai/tasks.ts';
import {
  NotFound, createEntity, createMemory, deleteEntity, deleteMemory, getEntityDetail, linkAssets, listEntities,
  listMemories, reorderAssets, unlinkAsset, updateEntity, updateLink, updateMemory, type EntityInput,
} from '../repo/entities.ts';
import { query } from './library.ts';
import { triggerIntegrationEvent } from '../integrations.ts';
import { actorOf, need } from '../middleware/auth.ts';
import { getEntity, getMemory } from '../repo/entities.ts';
import { logActivity } from '../repo/teams.ts';

export const entityRouter = Router();
export const memoryRouter = Router();

entityRouter.get('/', (req, res) => {
  res.json(listEntities(query(req, 'type') || undefined));
});

entityRouter.post('/', need('memory.edit'), (req, res) => {
  const body = req.body as EntityInput & { assetIds?: string[]; role?: EntityAssetRole };
  const entity = createEntity(body);
  void triggerIntegrationEvent('entity.created', { entityId: entity.id, entity });
  res.status(201).json(entity);
});

entityRouter.get('/:id', (req, res) => {
  const detail = getEntityDetail(req.params.id);
  if (!detail) throw new NotFound('Varlık bulunamadı.');
  res.json(detail);
});

entityRouter.patch('/:id', need('memory.edit'), (req, res) => {
  updateEntity(req.params.id, req.body as EntityInput);
  const detail = getEntityDetail(req.params.id);
  if (detail) void triggerIntegrationEvent('entity.updated', { entityId: req.params.id, entity: detail });
  res.json(detail);
});

entityRouter.delete('/:id', need('memory.delete'), (req, res) => {
  const entity = getEntity(req.params.id);
  deleteEntity(req.params.id);
  if (entity && !entity.deletedAt) logActivity(actorOf(req), 'memory.delete', `Hafızadan “${entity.name}” kaydını sildi.`);
  res.json({ ok: true });
});

entityRouter.post('/:id/assets', need('memory.edit'), (req, res) => {
  const body = req.body as { assetIds?: string[]; role?: EntityAssetRole };
  linkAssets(req.params.id, body.assetIds ?? [], body.role ?? 'reference');
  res.json(getEntityDetail(req.params.id));
});

entityRouter.patch('/:id/assets/:assetId', need('memory.edit'), (req, res) => {
  updateLink(req.params.id, req.params.assetId, req.body as { role?: EntityAssetRole; note?: string | null });
  res.json(getEntityDetail(req.params.id));
});

entityRouter.delete('/:id/assets/:assetId', need('memory.edit'), (req, res) => {
  unlinkAsset(req.params.id, req.params.assetId);
  res.json(getEntityDetail(req.params.id));
});

entityRouter.post('/:id/reorder', need('memory.edit'), (req, res) => {
  reorderAssets(req.params.id, (req.body as { assetIds?: string[] }).assetIds ?? []);
  res.json(getEntityDetail(req.params.id));
});

entityRouter.post('/:id/profile', need('memory.edit', 'studio.generate'), async (req, res) => {
  await generateProfile(req.params.id);
  res.json(getEntityDetail(req.params.id));
});

entityRouter.post('/:id/brand-extract', need('memory.edit', 'studio.generate'), async (req, res) => {
  await extractBrand(req.params.id, String((req.body as { text?: string }).text ?? ''));
  res.json(getEntityDetail(req.params.id));
});

/** Markanın web sitesinden logo, renk, yazı tipi ve tanıtım metnini çeker. */
entityRouter.post('/:id/brand-site', need('memory.edit', 'studio.generate'), async (req, res) => {
  const result = await importBrandSite(req.params.id, String((req.body as { url?: string }).url ?? ''));
  res.json({ entity: getEntityDetail(req.params.id), summary: result.summary });
});

memoryRouter.post('/learn', need('memory.edit', 'studio.generate'), async (_req, res) => {
  res.json(await learnFromFavorites());
});

memoryRouter.get('/', (req, res) => {
  res.json(listMemories({ entityId: query(req, 'entity') || undefined }));
});

memoryRouter.post('/', need('memory.edit'), (req, res) => {
  const body = req.body as { content?: string; category?: string; entityId?: string | null; pinned?: boolean };
  res.status(201).json(createMemory({ content: body.content ?? '', category: body.category, entityId: body.entityId, pinned: body.pinned }));
});

memoryRouter.patch('/:id', need('memory.edit'), (req, res) => {
  res.json(updateMemory(req.params.id, req.body));
});

memoryRouter.delete('/:id', need('memory.delete'), (req, res) => {
  const memory = getMemory(req.params.id);
  deleteMemory(req.params.id);
  if (memory && !memory.deletedAt) logActivity(actorOf(req), 'memory.delete', `Hafızadan bir notu sildi: “${memory.content.slice(0, 80)}”`);
  res.json({ ok: true });
});
