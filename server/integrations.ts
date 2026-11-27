import crypto from 'node:crypto';
import { get, now, run } from './db.ts';
import { emit } from './events.ts';
import type {
  Integration,
  IntegrationConfig,
  IntegrationEvent,
  IntegrationInput,
  IntegrationPatch,
} from '../shared/types.ts';

const SETTINGS_KEY = 'integrations';

// ───────────────────────── Saklama ─────────────────────────

function readStored(): Integration[] {
  const row = get<{ value: string }>(`SELECT value FROM settings WHERE key = ?`, SETTINGS_KEY);
  if (!row) return [];
  try {
    return JSON.parse(row.value) as Integration[];
  } catch {
    return [];
  }
}

function writeStored(list: Integration[]): void {
  run(
    `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    SETTINGS_KEY,
    JSON.stringify(list),
  );
}

// ───────────────────────── Webhook gönderme ─────────────────────────

function signPayload(secret: string, payload: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

async function deliverWebhook(
  config: IntegrationConfig,
  event: IntegrationEvent,
  payload: Record<string, unknown>,
): Promise<{ ok: boolean; error: string | null }> {
  // Gizli anahtar gövdeye yazılmaz; yalnızca imzayı üretmekte kullanılır.
  const body = JSON.stringify({ event, payload, timestamp: new Date().toISOString() });
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'Bellek/1.0 (webhook)',
  };
  if (config.secret) {
    headers['X-Bellek-Signature'] = `sha256=${signPayload(config.secret, body)}`;
    headers['X-Bellek-Event'] = event;
  }

  try {
    const response = await fetch(config.url, {
      method: 'POST',
      headers,
      body,
      // 10 saniye zaman aşımı
      signal: AbortSignal.timeout(10000),
    });
    if (response.ok) {
      return { ok: true, error: null };
    }
    return { ok: false, error: `HTTP ${response.status}` };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Webhook gönderilemedi.',
    };
  }
}

// ───────────────────────── Olay yönlendirme ─────────────────────────

/**
 * Belirli bir olaya abone olan aktif webhook entegrasyonlarını tetikler.
 * Gönderim arka planda yapılır; hata durumunda entegrasyonun lastError güncellenir.
 */
export async function triggerIntegrationEvent(
  event: IntegrationEvent,
  payload: Record<string, unknown>,
): Promise<void> {
  const integrations = readStored().filter(
    (i) => i.status !== 'inactive' && i.config.events.includes(event),
  );
  if (!integrations.length) return;

  const nowStamp = now();
  for (const integration of integrations) {
    const result = await deliverWebhook(integration.config, event, payload);
    // Gönderim sürerken liste değişmiş olabilir; güncel hâli üzerinden yaz.
    writeStored(
      readStored().map((item) =>
        item.id === integration.id
          ? {
              ...item,
              status: result.ok ? 'active' : 'error',
              lastError: result.ok ? null : result.error,
              lastTriggeredAt: nowStamp,
              updatedAt: nowStamp,
            }
          : item,
      ),
    );
  }
  emit({ type: 'integration.changed' });
}

// ───────────────────────── CRUD ─────────────────────────

export function listIntegrations(): Integration[] {
  return readStored();
}

export function getIntegration(id: string): Integration | undefined {
  return readStored().find((i) => i.id === id);
}

export function createIntegration(input: IntegrationInput): Integration {
  const id = `int_${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`;
  const stamp = now();
  const integration: Integration = {
    id,
    type: input.type,
    name: input.name.trim(),
    config: input.config,
    status: 'active',
    lastError: null,
    lastTriggeredAt: null,
    createdAt: stamp,
    updatedAt: stamp,
  };
  const list = readStored();
  list.push(integration);
  writeStored(list);
  emit({ type: 'integration.changed' });
  return integration;
}

export function updateIntegration(id: string, patch: IntegrationPatch): Integration | undefined {
  const list = readStored();
  const index = list.findIndex((i) => i.id === id);
  if (index === -1) return undefined;
  const stamp = now();
  const next = {
    ...list[index],
    ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
    ...(patch.config !== undefined ? { config: { ...list[index].config, ...patch.config } } : {}),
    ...(patch.status !== undefined ? { status: patch.status } : {}),
    updatedAt: stamp,
  };
  list[index] = next;
  writeStored(list);
  emit({ type: 'integration.changed' });
  return next;
}

export function deleteIntegration(id: string): boolean {
  const list = readStored();
  const filtered = list.filter((i) => i.id !== id);
  if (filtered.length === list.length) return false;
  writeStored(filtered);
  emit({ type: 'integration.changed' });
  return true;
}

/** Webhook'u test etmek için örnek bir olay gönderir. */
export async function testIntegration(id: string): Promise<{ ok: boolean; error: string | null }> {
  const integration = getIntegration(id);
  if (!integration) throw new Error('Entegrasyon bulunamadı.');
  if (integration.type !== 'webhook') throw new Error('Bu entegrasyon türü test edilemez.');

  const result = await deliverWebhook(
    integration.config,
    'post.created',
    { test: true, message: 'Bellek webhook testi' },
  );
  return result;
}