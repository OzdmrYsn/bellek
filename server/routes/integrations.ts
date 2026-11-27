import { Router } from 'express';
import type { IntegrationEvent, IntegrationInput, IntegrationPatch } from '../../shared/types.ts';
import {
  createIntegration,
  deleteIntegration,
  getIntegration,
  listIntegrations,
  testIntegration,
  triggerIntegrationEvent,
  updateIntegration,
} from '../integrations.ts';
import { Invalid, NotFound } from '../repo/entities.ts';
import { query } from './library.ts';

export const integrationsRouter = Router();

/** Gizli anahtar bir kez yazılır, geri okunmaz. */
function masked<T extends { config: { secret?: string } }>(integration: T): T {
  return integration.config.secret ? { ...integration, config: { ...integration.config, secret: '••••' } } : integration;
}

integrationsRouter.get('/', (_req, res) => {
  res.json(listIntegrations().map(masked));
});

integrationsRouter.post('/', (req, res) => {
  const body = req.body as IntegrationInput;
  if (!body.type || !body.name || !body.config) throw new Invalid('Tür, ad ve yapılandırma gerekli.');
  if (body.type !== 'webhook') throw new Invalid('Şu anda yalnızca webhook entegrasyonu desteklenir.');
  if (!Array.isArray(body.config.events) || !body.config.events.length) {
    throw new Invalid('En az bir olay seçin.');
  }
  if (!/^https?:\/\//i.test(body.config.url)) {
    throw new Invalid('Webhook URL\'si http:// veya https:// ile başlamalı.');
  }
  res.status(201).json(masked(createIntegration(body)));
});

integrationsRouter.get('/:id', (req, res) => {
  const integration = getIntegration(req.params.id);
  if (!integration) throw new NotFound('Entegrasyon bulunamadı.');
  res.json(masked(integration));
});

integrationsRouter.patch('/:id', (req, res) => {
  const body = req.body as IntegrationPatch;
  // Maskelenmiş değer geri gönderilirse saklanan anahtar korunur.
  if (body.config?.secret === '••••') delete body.config.secret;
  const integration = updateIntegration(req.params.id, body);
  if (!integration) throw new NotFound('Entegrasyon bulunamadı.');
  res.json(masked(integration));
});

integrationsRouter.delete('/:id', (req, res) => {
  const ok = deleteIntegration(req.params.id);
  if (!ok) throw new NotFound('Entegrasyon bulunamadı.');
  res.json({ ok: true });
});

integrationsRouter.post('/:id/test', async (req, res) => {
  const result = await testIntegration(req.params.id);
  if (!result.ok) {
    res.json({ ok: false, error: result.error });
    return;
  }
  res.json({ ok: true });
});

// Olayları manuel olarak tetikleme (geliştirme/test amacıyla)
integrationsRouter.post('/trigger', (req, res) => {
  const body = req.body as { event?: IntegrationEvent; payload?: Record<string, unknown> };
  if (!body.event) throw new Invalid('Olay belirtilmedi.');
  const validEvents: IntegrationEvent[] = [
    'post.created',
    'post.updated',
    'post.deleted',
    'post.approved',
    'post.changes-requested',
    'job.completed',
    'job.failed',
    'asset.created',
    'asset.deleted',
    'entity.created',
    'entity.updated',
  ];
  if (!validEvents.includes(body.event)) throw new Invalid('Geçersiz olay.');
  void triggerIntegrationEvent(body.event, body.payload ?? {});
  res.json({ ok: true, event: body.event });
});