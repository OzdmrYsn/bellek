import type {
  BudgetSettings, Defaults, ModelConfig, ModelKind, ModelPrice, ModelRef, ProviderInfo, ProviderKind, Settings,
  UsageReport, UsageRow,
} from '../shared/types.ts';
import { all, get, newId, now, parseJson, run } from './db.ts';
import { CATALOG } from './providers/catalog.ts';
import { ProviderError } from './providers/types.ts';
import { getSecret, hasSecret, secretHint, setSecret } from './secrets.ts';

// ───────────────────────── Anahtar-değer ayarlar ─────────────────────────

export function readSetting<T>(key: string, fallback: T): T {
  const row = get<{ value: string }>(`SELECT value FROM settings WHERE key = ?`, key);
  return row ? parseJson<T>(row.value, fallback) : fallback;
}

export function writeSetting(key: string, value: unknown): void {
  run(
    `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    key, JSON.stringify(value),
  );
}

export function readCache<T>(key: string, maxAgeMs: number): T | null {
  const row = get<{ value: string; updated_at: string }>(`SELECT value, updated_at FROM cache WHERE key = ?`, key);
  if (!row) return null;
  if (Date.now() - new Date(row.updated_at).getTime() > maxAgeMs) return null;
  return parseJson<T | null>(row.value, null);
}

export function writeCache(key: string, value: unknown): void {
  run(
    `INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    key, JSON.stringify(value), now(),
  );
}

const DEFAULT_SETTINGS: Settings = {
  defaults: { text: null, utility: null, image: null, video: null },
  backup: { intervalHours: 6, keep: 30, mirrorDir: '' },
  generation: { aspect: '4:5', count: 2, refsPerEntity: 3, enhance: true, autoMemory: true, videoDuration: 8 },
  customInstructions: '',
  budget: { monthlyLimit: null, prices: {} },
  onboarded: false,
};

export function getSettings(): Settings {
  const stored = readSetting<Partial<Settings>>('app', {});
  return {
    defaults: { ...DEFAULT_SETTINGS.defaults, ...stored.defaults },
    backup: { ...DEFAULT_SETTINGS.backup, ...stored.backup },
    generation: { ...DEFAULT_SETTINGS.generation, ...stored.generation },
    customInstructions: stored.customInstructions ?? '',
    budget: { monthlyLimit: stored.budget?.monthlyLimit ?? null, prices: stored.budget?.prices ?? {} },
    onboarded: stored.onboarded ?? false,
  };
}

function cleanPrice(price: ModelPrice | undefined): ModelPrice | null {
  const out: ModelPrice = {};
  for (const key of ['input', 'output', 'unit'] as const) {
    const value = Number(price?.[key]);
    if (price?.[key] !== undefined && String(price[key]) !== '' && Number.isFinite(value) && value >= 0) out[key] = value;
  }
  return Object.keys(out).length ? out : null;
}

function cleanBudget(budget: BudgetSettings): BudgetSettings {
  const limit = Number(budget.monthlyLimit);
  const prices: Record<string, ModelPrice> = {};
  for (const [ref, price] of Object.entries(budget.prices ?? {})) {
    const cleaned = cleanPrice(price);
    if (cleaned) prices[ref] = cleaned;
  }
  return { monthlyLimit: budget.monthlyLimit !== null && Number.isFinite(limit) && limit > 0 ? limit : null, prices };
}

export function updateSettings(patch: Partial<Settings>): Settings {
  const current = getSettings();
  const next: Settings = {
    defaults: { ...current.defaults, ...patch.defaults },
    backup: { ...current.backup, ...patch.backup },
    generation: { ...current.generation, ...patch.generation },
    customInstructions: patch.customInstructions ?? current.customInstructions,
    budget: cleanBudget({ ...current.budget, ...patch.budget }),
    onboarded: patch.onboarded ?? current.onboarded,
  };
  next.backup.intervalHours = clamp(Number(next.backup.intervalHours) || 6, 1, 168);
  next.backup.keep = clamp(Math.round(Number(next.backup.keep) || 30), 3, 365);
  next.generation.count = clamp(Math.round(Number(next.generation.count) || 1), 1, 4);
  next.generation.refsPerEntity = clamp(Math.round(Number(next.generation.refsPerEntity) || 3), 1, 6);
  writeSetting('app', next);
  return next;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// ───────────────────────── Sağlayıcı kaydı ─────────────────────────

interface StoredProvider {
  id: string;
  /** Yalnızca kullanıcının eklediği sağlayıcılarda dolu. */
  custom?: { name: string; kind: ProviderKind };
  baseUrl?: string;
  enabled?: boolean;
  modelState?: Record<string, { enabled: boolean }>;
  customModels?: ModelConfig[];
  removed?: string[];
}

function readStored(): StoredProvider[] {
  return readSetting<StoredProvider[]>('providers', []);
}

function writeStored(list: StoredProvider[]): void {
  writeSetting('providers', list);
}

function mutateStored(id: string, fn: (entry: StoredProvider) => void): void {
  const list = readStored();
  let entry = list.find((p) => p.id === id);
  if (!entry) {
    entry = { id };
    list.push(entry);
  }
  fn(entry);
  writeStored(list);
}

function mergeModels(base: ModelConfig[], stored: StoredProvider | undefined): ModelConfig[] {
  const removed = new Set(stored?.removed ?? []);
  const custom = stored?.customModels ?? [];
  const customIds = new Set(custom.map((m) => `${m.kind}:${m.id}`));
  const merged = [
    ...base.filter((m) => !removed.has(m.id) && !customIds.has(`${m.kind}:${m.id}`)),
    ...custom.map((m) => ({ ...m, custom: true })),
  ];
  return merged.map((m) => ({ ...m, enabled: stored?.modelState?.[m.id]?.enabled ?? m.enabled }));
}

export function listProviders(): ProviderInfo[] {
  const stored = readStored();
  const builtin: ProviderInfo[] = CATALOG.map((entry) => {
    const state = stored.find((p) => p.id === entry.id);
    return {
      id: entry.id,
      kind: entry.kind,
      name: entry.name,
      description: entry.description,
      baseUrl: state?.baseUrl ?? entry.baseUrl,
      enabled: state?.enabled ?? true,
      builtin: true,
      hasKey: hasSecret(entry.id),
      keyHint: secretHint(entry.id),
      needsKey: entry.needsKey,
      keyUrl: entry.keyUrl,
      models: mergeModels(entry.models, state),
    };
  });
  const custom: ProviderInfo[] = stored
    .filter((p) => p.custom)
    .map((p) => ({
      id: p.id,
      kind: p.custom!.kind,
      name: p.custom!.name,
      description: 'OpenAI uyumlu özel uç nokta.',
      baseUrl: p.baseUrl ?? '',
      enabled: p.enabled ?? true,
      builtin: false,
      hasKey: hasSecret(p.id),
      keyHint: secretHint(p.id),
      // Yerel sunucular (Ollama, LM Studio) anahtar istemez.
      needsKey: false,
      keyUrl: '',
      models: mergeModels([], p),
    }));
  return [...builtin, ...custom];
}

export function getProvider(id: string): ProviderInfo | undefined {
  return listProviders().find((p) => p.id === id);
}

export function isReady(provider: ProviderInfo): boolean {
  return provider.enabled && (provider.hasKey || !provider.needsKey);
}

export function listModels(kind?: ModelKind): ModelRef[] {
  const refs: ModelRef[] = [];
  for (const provider of listProviders()) {
    if (!isReady(provider)) continue;
    for (const model of provider.models) {
      if (!model.enabled) continue;
      if (kind && model.kind !== kind) continue;
      refs.push({ ref: `${provider.id}:${model.id}`, providerId: provider.id, providerName: provider.name, model });
    }
  }
  return refs;
}

export interface Resolved {
  ref: string;
  provider: ProviderInfo;
  model: ModelConfig;
  apiKey: string;
}

export function splitRef(ref: string): { providerId: string; modelId: string } {
  const index = ref.indexOf(':');
  return index < 0 ? { providerId: ref, modelId: '' } : { providerId: ref.slice(0, index), modelId: ref.slice(index + 1) };
}

export function resolveModel(ref: string | null | undefined, kind: ModelKind): Resolved | null {
  if (!ref) return null;
  const { providerId, modelId } = splitRef(ref);
  const provider = getProvider(providerId);
  if (!provider || !isReady(provider)) return null;
  const model = provider.models.find((m) => m.id === modelId && m.kind === kind && m.enabled);
  if (!model) return null;
  return { ref, provider, model, apiKey: getSecret(provider.id) };
}

/** İstenen model kullanılamıyorsa varsayılana, o da yoksa ilk hazır modele düşer. */
export function pickModel(kind: ModelKind, preferred?: string | null): Resolved | null {
  const settings = getSettings();
  const slot: keyof Defaults = kind;
  return (
    resolveModel(preferred, kind) ??
    resolveModel(settings.defaults[slot], kind) ??
    resolveModel(listModels(kind)[0]?.ref, kind)
  );
}

/** Başlık, özet gibi küçük işler için: önce hızlı model, yoksa ana metin modeli. */
export function pickUtilityModel(): Resolved | null {
  const settings = getSettings();
  return resolveModel(settings.defaults.utility, 'text') ?? pickModel('text');
}

// ───────────────────────── Sağlayıcı düzenleme ─────────────────────────

export interface ProviderPatch {
  apiKey?: string;
  baseUrl?: string;
  enabled?: boolean;
  name?: string;
}

export function saveProvider(id: string, patch: ProviderPatch): ProviderInfo {
  const provider = getProvider(id);
  if (!provider) throw new Error('Sağlayıcı bulunamadı.');
  if (patch.apiKey !== undefined) setSecret(id, patch.apiKey);
  mutateStored(id, (entry) => {
    if (patch.baseUrl !== undefined) entry.baseUrl = patch.baseUrl.trim().replace(/\/+$/, '');
    if (patch.enabled !== undefined) entry.enabled = patch.enabled;
    if (patch.name !== undefined && entry.custom) entry.custom.name = patch.name.trim() || entry.custom.name;
  });
  return getProvider(id)!;
}

export function addCustomProvider(input: { name: string; baseUrl: string; apiKey?: string }): ProviderInfo {
  const name = input.name.trim();
  const baseUrl = input.baseUrl.trim().replace(/\/+$/, '');
  if (!name) throw new Error('Sağlayıcıya bir ad verin.');
  if (!/^https?:\/\//i.test(baseUrl)) throw new Error('Adres http:// ya da https:// ile başlamalı.');
  const id = newId('pv').replace('_', '-');
  const list = readStored();
  list.push({ id, custom: { name, kind: 'openai-compatible' }, baseUrl, enabled: true, customModels: [] });
  writeStored(list);
  if (input.apiKey) setSecret(id, input.apiKey);
  return getProvider(id)!;
}

export function removeProvider(id: string): void {
  const list = readStored();
  const entry = list.find((p) => p.id === id);
  if (!entry?.custom) throw new Error('Hazır gelen sağlayıcılar kaldırılamaz; yalnızca kapatılabilir.');
  writeStored(list.filter((p) => p.id !== id));
  setSecret(id, '');
}

export function setModelEnabled(providerId: string, modelId: string, enabled: boolean): void {
  mutateStored(providerId, (entry) => {
    entry.modelState = { ...entry.modelState, [modelId]: { enabled } };
  });
}

export function upsertModel(providerId: string, model: ModelConfig): void {
  if (!model.id.trim()) throw new Error('Model kimliği boş olamaz.');
  mutateStored(providerId, (entry) => {
    const list = (entry.customModels ?? []).filter((m) => !(m.id === model.id && m.kind === model.kind));
    list.push({ ...model, id: model.id.trim(), label: model.label.trim() || model.id.trim(), enabled: true, custom: true });
    entry.customModels = list;
    entry.removed = (entry.removed ?? []).filter((id) => id !== model.id);
    entry.modelState = { ...entry.modelState, [model.id]: { enabled: true } };
  });
}

export function removeModel(providerId: string, modelId: string): void {
  mutateStored(providerId, (entry) => {
    entry.customModels = (entry.customModels ?? []).filter((m) => m.id !== modelId);
    entry.removed = [...new Set([...(entry.removed ?? []), modelId])];
  });
}

// ───────────────────────── Kullanım günlüğü ─────────────────────────

export function logUsage(entry: {
  provider: string; model: string; kind: string; inputTokens?: number; outputTokens?: number; units?: number;
}): void {
  run(
    `INSERT INTO usage_log (ts, provider, model, kind, input_tokens, output_tokens, units) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    now(), entry.provider, entry.model, entry.kind, entry.inputTokens ?? 0, entry.outputTokens ?? 0, entry.units ?? 0,
  );
}

/** Geçerli fiyatlar: katalogdaki liste fiyatlarının üzerine kullanıcının girdikleri. */
export function effectivePrices(): Record<string, ModelPrice> {
  const prices: Record<string, ModelPrice> = {};
  for (const provider of listProviders()) {
    for (const model of provider.models) if (model.price) prices[`${provider.id}:${model.id}`] = model.price;
  }
  return { ...prices, ...getSettings().budget.prices };
}

function costOf(row: { kind: string; inputTokens: number; outputTokens: number; units: number }, price: ModelPrice | undefined): number | null {
  if (!price) return null;
  if (row.kind === 'text') {
    if (price.input === undefined && price.output === undefined) return null;
    return (row.inputTokens / 1e6) * (price.input ?? 0) + (row.outputTokens / 1e6) * (price.output ?? 0);
  }
  return price.unit === undefined ? null : row.units * price.unit;
}

interface UsageAggregate {
  provider: string;
  model: string;
  kind: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  units: number;
}

function monthStart(): string {
  const date = new Date();
  return new Date(date.getFullYear(), date.getMonth(), 1).toISOString();
}

/** Bu ayın tahmini harcaması ve fiyatı bilinmediği için sayılamayan modeller. */
export function monthSpend(): { spend: number; unpriced: string[] } {
  const prices = effectivePrices();
  const rows = all<UsageAggregate>(
    `SELECT provider, model, kind, COUNT(*) AS requests, SUM(input_tokens) AS inputTokens, SUM(output_tokens) AS outputTokens,
            SUM(units) AS units FROM usage_log WHERE ts >= ? GROUP BY provider, model, kind`,
    monthStart(),
  );
  let spend = 0;
  const unpriced = new Set<string>();
  for (const row of rows) {
    const cost = costOf(row, prices[`${row.provider}:${row.model}`]);
    if (cost === null) unpriced.add(`${row.provider}:${row.model}`);
    else spend += cost;
  }
  return { spend, unpriced: [...unpriced] };
}

export function usageReport(days: number): UsageReport {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const prices = effectivePrices();
  const rows = all<Omit<UsageRow, 'cost'>>(
    `SELECT substr(ts, 1, 10) AS day, provider, model, kind, COUNT(*) AS requests,
            SUM(input_tokens) AS inputTokens, SUM(output_tokens) AS outputTokens, SUM(units) AS units
       FROM usage_log WHERE ts >= ? GROUP BY day, provider, model, kind ORDER BY day DESC, requests DESC`,
    since,
  ).map((row) => ({ ...row, cost: costOf(row, prices[`${row.provider}:${row.model}`]) }));
  const month = monthSpend();
  return { rows, monthSpend: month.spend, unpriced: month.unpriced, budget: getSettings().budget, prices };
}

export class BudgetError extends ProviderError {}

/** Aylık sınır aşıldıysa yeni üretimi durdurur. Sınır yoksa hiçbir şey yapmaz. */
export function assertBudget(): void {
  const limit = getSettings().budget.monthlyLimit;
  if (limit === null) return;
  const { spend } = monthSpend();
  if (spend >= limit) {
    throw new BudgetError(
      `Bu ayki tahmini harcama ${spend.toFixed(2)} $ ile ${limit.toFixed(2)} $ sınırına ulaştı. ` +
        'Ayarlar → Kullanım bölümünden sınırı yükseltebilir ya da kaldırabilirsiniz.',
    );
  }
}
