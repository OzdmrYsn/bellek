import { useQuery } from '@tanstack/react-query';
import { Check, ChevronDown, ExternalLink, Plus, RefreshCw, Search, Trash2, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { FalCatalogItem, ModelConfig, ModelKind, ModelRef, ProviderInfo } from '../../shared/types.ts';
import { api, qs } from '../lib/api.ts';
import { cx } from '../lib/format.ts';
import { keys, queryClient, useApp } from '../lib/queries.ts';
import { attempt, confirmDialog, toast } from '../lib/store.ts';
import { Dialog } from '../ui/Dialog.tsx';
import { Empty, Field, IconButton, Notice, Segmented, Spinner, Switch } from '../ui/kit.tsx';

interface ProvidersPayload {
  providers: ProviderInfo[];
  models: ModelRef[];
}

const KIND_LABEL: Record<ModelKind, string> = { text: 'Metin', image: 'Görsel', video: 'Video' };

function applyProviders(payload: ProvidersPayload): void {
  queryClient.setQueryData(keys.bootstrap, (app: object | undefined) => (app ? { ...app, providers: payload.providers, models: payload.models } : app));
}

async function mutate(run: () => Promise<ProvidersPayload>, success?: string): Promise<boolean> {
  const payload = await attempt(run, success);
  if (payload) applyProviders(payload);
  return !!payload;
}

function isReady(provider: ProviderInfo): boolean {
  return provider.enabled && (provider.hasKey || !provider.needsKey);
}

function summary(provider: ProviderInfo): string {
  const active = provider.models.filter((m) => m.enabled);
  const parts = (['text', 'image', 'video'] as ModelKind[])
    .map((kind) => [active.filter((m) => m.kind === kind).length, KIND_LABEL[kind].toLowerCase()] as const)
    .filter(([count]) => count > 0)
    .map(([count, label]) => `${count} ${label}`);
  return parts.length ? parts.join(' · ') : 'model eklenmedi';
}

interface RemoteModel {
  id: string;
  label: string;
  kind: ModelKind;
  added: boolean;
}

function RemoteModelsDialog({ provider, open, onClose }: { provider: ProviderInfo; open: boolean; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const remote = useQuery({
    queryKey: ['remote-models', provider.id],
    enabled: open,
    queryFn: () => api.get<RemoteModel[]>(`/api/providers/${provider.id}/remote-models`),
    staleTime: 60_000,
    retry: false,
  });
  const added = new Set(provider.models.map((m) => `${m.kind}:${m.id}`));
  const list = (remote.data ?? []).filter((m) => !query.trim() || `${m.id} ${m.label}`.toLowerCase().includes(query.trim().toLowerCase()));

  return (
    <Dialog open={open} onClose={onClose} size="lg" title={`${provider.name} modelleri`} description="Hesabınızın erişebildiği modeller. Eklediğiniz model, stüdyodaki model listelerinde görünür.">
      <div className="relative mb-3">
        <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-ink-3" />
        <input autoFocus className="input !pl-9" placeholder="Model ara" aria-label="Model ara" value={query} onChange={(event) => setQuery(event.target.value)} />
      </div>
      {remote.isLoading ? (
        <div className="grid h-40 place-items-center text-ink-3"><Spinner /></div>
      ) : remote.isError ? (
        <Notice level="error">{remote.error instanceof Error ? remote.error.message : 'Model listesi alınamadı.'}</Notice>
      ) : list.length === 0 ? (
        <Empty className="!py-10" title="Eşleşen model yok" />
      ) : (
        <ul className="-mx-1.5 max-h-[22rem] overflow-y-auto">
          {list.map((model) => {
            const has = added.has(`${model.kind}:${model.id}`);
            return (
              <li key={`${model.kind}:${model.id}`} className="menu-item !cursor-default">
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{model.label}</span>
                  {model.label !== model.id && <span className="meta block truncate">{model.id}</span>}
                </span>
                <span className="chip !h-6">{KIND_LABEL[model.kind]}</span>
                <button
                  type="button"
                  className="btn btn-outline btn-sm w-[5.2rem]"
                  disabled={has}
                  onClick={() => void mutate(() => api.post<ProvidersPayload>(`/api/providers/${provider.id}/models`, { id: model.id, label: model.label, kind: model.kind }))}
                >
                  {has ? <><Check /> Ekli</> : <><Plus /> Ekle</>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Dialog>
  );
}

const FAL_CATEGORIES = [
  { value: 'image-to-image', label: 'Görsel (referanslı)' },
  { value: 'text-to-image', label: 'Görsel' },
  { value: 'image-to-video', label: 'Video (görselden)' },
  { value: 'text-to-video', label: 'Video' },
];

function FalCatalogDialog({ provider, open, onClose }: { provider: ProviderInfo; open: boolean; onClose: () => void }) {
  const [category, setCategory] = useState('image-to-image');
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [adding, setAdding] = useState<string | null>(null);
  const [manual, setManual] = useState('');

  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(query.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [query]);

  const catalog = useQuery({
    queryKey: ['fal-catalog', category, search],
    enabled: open,
    queryFn: () => api.get<FalCatalogItem[]>(`/api/fal/catalog${qs({ q: search, category: search ? '' : category })}`),
    staleTime: 5 * 60_000,
    retry: false,
  });

  const known = useMemo(() => {
    const set = new Set<string>();
    for (const model of provider.models) {
      set.add(model.id);
      for (const endpoint of [model.options?.editEndpoint, model.options?.imageEndpoint, model.options?.refEndpoint]) if (endpoint) set.add(endpoint);
    }
    return set;
  }, [provider.models]);

  const add = async (endpointId: string) => {
    setAdding(endpointId);
    const payload = await attempt(() => api.post<ProvidersPayload & { added: ModelConfig }>('/api/fal/models', { endpointId }));
    setAdding(null);
    if (!payload) return;
    applyProviders(payload);
    toast(`${payload.added.label} eklendi. Kardeş uç noktaları ve girdi şeması otomatik eşlendi.`, 'ok');
    setManual('');
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="xl"
      title="fal.ai model kataloğu"
      description="Canlı katalogdan istediğiniz modeli ekleyin. Bellek modelin girdi şemasını okur; referans, oran ve süre alanlarını kendisi eşler."
    >
      <div className="mb-4 flex flex-wrap items-center gap-2.5">
        <Segmented size="sm" value={category} onChange={setCategory} options={FAL_CATEGORIES} />
        <div className="relative min-w-48 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-ink-3" />
          <input className="input !h-8 !pl-9" placeholder="Tüm katalogda ara: kling, flux, seedream…" aria-label="Katalogda ara" value={query} onChange={(event) => setQuery(event.target.value)} />
        </div>
      </div>

      {catalog.isLoading ? (
        <div className="grid h-56 place-items-center text-ink-3"><Spinner /></div>
      ) : catalog.isError ? (
        <Notice level="error">{catalog.error instanceof Error ? catalog.error.message : 'Katalog okunamadı.'}</Notice>
      ) : !catalog.data?.length ? (
        <Empty className="!py-10" title="Sonuç yok" body="Aramayı değiştirin ya da uç nokta kimliğini aşağıya yapıştırın." />
      ) : (
        <ul className="grid max-h-[24rem] gap-px overflow-y-auto sm:grid-cols-2">
          {catalog.data.map((item) => {
            const has = known.has(item.endpointId);
            return (
              <li key={item.endpointId} className="flex items-center gap-3 rounded-lg p-2 hover:bg-sunken">
                {item.thumbnailUrl ? (
                  <img src={item.thumbnailUrl} alt="" loading="lazy" className="h-12 w-12 flex-none rounded-md bg-sunken object-cover" />
                ) : (
                  <span className="h-12 w-12 flex-none rounded-md bg-sunken" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[0.92rem] font-medium">{item.name}</span>
                  <span className="meta block truncate" title={item.endpointId}>{item.endpointId}</span>
                </span>
                <button type="button" className="btn btn-outline btn-sm flex-none" disabled={has || adding === item.endpointId} onClick={() => void add(item.endpointId)}>
                  {adding === item.endpointId ? <Spinner /> : has ? <Check /> : <Plus />}
                  {has ? 'Ekli' : 'Ekle'}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <form
        className="mt-4 flex flex-wrap items-end gap-2 border-t border-line pt-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (manual.trim()) void add(manual.trim());
        }}
      >
        <Field label="Ya da uç nokta kimliğini yapıştırın" className="min-w-56 flex-1">
          <input className="input font-mono !text-[0.86rem]" placeholder="ör. kling/v4/image-to-video" value={manual} onChange={(event) => setManual(event.target.value)} />
        </Field>
        <button type="submit" className="btn btn-primary" disabled={!manual.trim() || !!adding}>
          {adding === manual.trim() ? <Spinner /> : <Plus />} Ekle
        </button>
      </form>
    </Dialog>
  );
}

function ManualModelForm({ provider }: { provider: ProviderInfo }) {
  const [id, setId] = useState('');
  const [kind, setKind] = useState<ModelKind>('text');
  const kinds: ModelKind[] = provider.kind === 'anthropic' || provider.kind === 'openai-compatible' ? ['text'] : provider.kind === 'openai' ? ['text', 'image'] : ['text', 'image', 'video'];
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!id.trim()) return;
        const ok = await mutate(() => api.post<ProvidersPayload>(`/api/providers/${provider.id}/models`, { id: id.trim(), label: id.trim(), kind }));
        if (ok) setId('');
      }}
    >
      <input className="input !h-8 min-w-44 flex-1 font-mono !text-[0.84rem]" placeholder="Model kimliğini elle yazın" aria-label="Model kimliği" value={id} onChange={(event) => setId(event.target.value)} />
      {kinds.length > 1 && (
        <select className="input !h-8 !w-auto !text-[0.86rem]" value={kind} onChange={(event) => setKind(event.target.value as ModelKind)} aria-label="Model türü">
          {kinds.map((k) => (
            <option key={k} value={k}>{KIND_LABEL[k]}</option>
          ))}
        </select>
      )}
      <button type="submit" className="btn btn-outline btn-sm" disabled={!id.trim()}>
        <Plus /> Ekle
      </button>
    </form>
  );
}

function ProviderPanel({ provider }: { provider: ProviderInfo }) {
  const [key, setKey] = useState('');
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [remoteOpen, setRemoteOpen] = useState(false);
  const [falOpen, setFalOpen] = useState(false);

  useEffect(() => setBaseUrl(provider.baseUrl), [provider.baseUrl]);

  const test = async () => {
    setTesting(true);
    setResult(null);
    const response = await attempt(() => api.post<{ ok: boolean; message: string }>(`/api/providers/${provider.id}/test`));
    setTesting(false);
    if (response) setResult(response);
    return response;
  };

  const saveKey = async () => {
    const ok = await mutate(() => api.patch<ProvidersPayload>(`/api/providers/${provider.id}`, { apiKey: key, baseUrl: provider.builtin ? undefined : baseUrl }));
    if (!ok) return;
    setKey('');
    const response = await test();
    // Model listesi boş olan sağlayıcıda (OpenRouter, Ollama, özel sunucu) anahtar çalışıyorsa sıradaki adım modelleri seçmektir.
    if (response?.ok && provider.models.length === 0 && provider.kind !== 'fal' && provider.kind !== 'mock') setRemoteOpen(true);
  };

  const removeKey = async () => {
    const yes = await confirmDialog({ title: 'Anahtar kaldırılsın mı?', body: `${provider.name} modelleri, yeni bir anahtar girilene kadar kullanılamaz.`, confirm: 'Anahtarı kaldır', danger: true });
    if (yes) {
      await mutate(() => api.patch<ProvidersPayload>(`/api/providers/${provider.id}`, { apiKey: '' }));
      setResult(null);
    }
  };

  const groups = (['text', 'image', 'video'] as ModelKind[]).map((kind) => ({ kind, models: provider.models.filter((m) => m.kind === kind) })).filter((g) => g.models.length);
  const canFetch = provider.kind !== 'fal' && provider.kind !== 'mock';
  const editableUrl = !provider.builtin;

  return (
    <div className="flex flex-col gap-5 border-t border-line bg-bg px-5 py-5 max-sm:px-4">
      {provider.kind !== 'mock' && (
        <div>
          <div className="flex flex-wrap items-end gap-2">
            <Field label="API anahtarı" className="min-w-60 flex-1">
              <input
                type="password"
                autoComplete="off"
                className="input font-mono !text-[0.86rem]"
                placeholder={provider.hasKey ? `${provider.keyHint} kayıtlı — değiştirmek için yenisini yapıştırın` : provider.needsKey ? 'Anahtarı yapıştırın' : 'Gerekmiyorsa boş bırakın'}
                value={key}
                onChange={(event) => setKey(event.target.value)}
                onKeyDown={(event) => event.key === 'Enter' && key.trim() && void saveKey()}
              />
            </Field>
            <button type="button" className="btn btn-primary" disabled={!key.trim() && !(editableUrl && baseUrl !== provider.baseUrl)} onClick={saveKey}>
              Kaydet
            </button>
            <button type="button" className="btn btn-outline" disabled={testing || (provider.needsKey && !provider.hasKey)} onClick={test}>
              {testing ? <Spinner /> : <RefreshCw />} Bağlantıyı sına
            </button>
            {provider.hasKey && (
              <IconButton label="Anahtarı kaldır" variant="outline" onClick={removeKey}>
                <Trash2 />
              </IconButton>
            )}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1">
            <p className="hint">Anahtar yalnızca bu bilgisayarda, veritabanından ayrı bir dosyada saklanır; yedeklere ve dışa aktarımlara girmez.</p>
            {provider.keyUrl && (
              <a href={provider.keyUrl} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-[0.82rem] text-accent-text underline underline-offset-2">
                Anahtar al <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </div>
          {result && <div className="mt-3"><Notice level={result.ok ? 'ok' : 'error'}>{result.message}</Notice></div>}
        </div>
      )}

      {editableUrl && (
        <Field label="Sunucu adresi" hint="OpenAI uyumlu uç nokta, ör. http://localhost:11434/v1">
          <input className="input font-mono !text-[0.86rem]" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} onBlur={() => baseUrl !== provider.baseUrl && void mutate(() => api.patch<ProvidersPayload>(`/api/providers/${provider.id}`, { baseUrl }))} />
        </Field>
      )}

      <div>
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <h4 className="flex-1 text-[0.9rem] font-semibold">Modeller</h4>
          {provider.kind === 'fal' && (
            <button type="button" className="btn btn-outline btn-sm" onClick={() => setFalOpen(true)}>
              <Plus /> Katalogdan ekle
            </button>
          )}
          {canFetch && (
            <button type="button" className="btn btn-outline btn-sm" disabled={provider.needsKey && !provider.hasKey} onClick={() => setRemoteOpen(true)} title={provider.needsKey && !provider.hasKey ? 'Önce anahtarı kaydedin' : undefined}>
              <RefreshCw /> Modelleri getir
            </button>
          )}
        </div>

        {groups.length === 0 && <p className="mb-3 text-[0.88rem] text-ink-3">Henüz model eklenmedi. Anahtarı kaydedip modelleri getirin ya da kimliğini elle yazın.</p>}
        <div className="flex flex-col gap-3">
          {groups.map((group) => (
            <div key={group.kind}>
              <div className="mb-0.5 text-[0.76rem] font-medium text-ink-3">{KIND_LABEL[group.kind]}</div>
              <ul>
                {group.models.map((model) => (
                  <li key={model.id} className="flex items-center gap-3 border-b border-line py-2 last:border-0">
                    <span className="min-w-0 flex-1">
                      <span className={cx('block truncate text-[0.92rem]', !model.enabled && 'text-ink-3')}>
                        {model.label}
                        {model.note && <span className="ml-2 text-[0.8rem] text-ink-3">{model.note}</span>}
                      </span>
                      <span className="meta block truncate" title={model.id}>
                        {model.id}
                        {model.kind !== 'text' && model.maxRefs ? ` · ${model.maxRefs} referansa kadar` : model.kind !== 'text' ? ' · referans almaz' : ''}
                      </span>
                    </span>
                    {model.custom && (
                      <IconButton label="Modeli kaldır" size="sm" onClick={() => void mutate(() => api.del<ProvidersPayload>(`/api/providers/${provider.id}/models${qs({ modelId: model.id })}`))}>
                        <X />
                      </IconButton>
                    )}
                    <Switch
                      checked={model.enabled}
                      label={`${model.label} ${model.enabled ? 'açık' : 'kapalı'}`}
                      onChange={(enabled) => void mutate(() => api.patch<ProvidersPayload>(`/api/providers/${provider.id}/models`, { modelId: model.id, enabled }))}
                    />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        {provider.kind !== 'fal' && provider.kind !== 'mock' && (
          <div className="mt-3">
            <ManualModelForm provider={provider} />
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
        <label className="flex items-center gap-3 text-[0.9rem]">
          <Switch checked={provider.enabled} label="Sağlayıcı açık" onChange={(enabled) => void mutate(() => api.patch<ProvidersPayload>(`/api/providers/${provider.id}`, { enabled }))} />
          Bu sağlayıcıyı kullan
        </label>
        {!provider.builtin && (
          <button
            type="button"
            className="btn btn-danger btn-sm"
            onClick={async () => {
              const yes = await confirmDialog({ title: `${provider.name} kaldırılsın mı?`, body: 'Sağlayıcı, modelleri ve anahtarı silinir.', confirm: 'Kaldır', danger: true });
              if (yes) await mutate(() => api.del<ProvidersPayload>(`/api/providers/${provider.id}`));
            }}
          >
            <Trash2 /> Sağlayıcıyı kaldır
          </button>
        )}
      </div>

      {remoteOpen && <RemoteModelsDialog provider={provider} open onClose={() => setRemoteOpen(false)} />}
      {falOpen && <FalCatalogDialog provider={provider} open onClose={() => setFalOpen(false)} />}
    </div>
  );
}

function CustomProviderDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  useEffect(() => {
    if (open) {
      setName('');
      setBaseUrl('');
      setApiKey('');
    }
  }, [open]);
  const save = async () => {
    const ok = await mutate(() => api.post<ProvidersPayload>('/api/providers', { name, baseUrl, apiKey }), 'Sağlayıcı eklendi. Şimdi modellerini getirin.');
    if (ok) onClose();
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="md"
      title="Özel sağlayıcı ekle"
      description="OpenAI uyumlu herhangi bir uç nokta: Ollama, LM Studio, Groq, xAI, DeepSeek, Mistral, Together…"
      footer={
        <>
          <button type="button" className="btn btn-outline" onClick={onClose}>Vazgeç</button>
          <button type="button" className="btn btn-primary" disabled={!name.trim() || !baseUrl.trim()} onClick={save}>Ekle</button>
        </>
      }
    >
      <div className="flex flex-col gap-3.5">
        <Field label="Ad">
          <input autoFocus className="input" placeholder="Örn. Yerel Ollama" value={name} onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field label="Sunucu adresi" hint="/v1 ile biten temel adres.">
          <input className="input font-mono !text-[0.86rem]" placeholder="http://localhost:11434/v1" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} />
        </Field>
        <Field label="API anahtarı" hint="Yerel sunucular için boş bırakabilirsiniz.">
          <input type="password" autoComplete="off" className="input font-mono !text-[0.86rem]" value={apiKey} onChange={(event) => setApiKey(event.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}

export function ProvidersSection() {
  const app = useApp();
  const [open, setOpen] = useState<string | null>(() => (app.providers.some(isReady) ? null : 'anthropic'));
  const [adding, setAdding] = useState(false);

  return (
    <div>
      <p className="mb-5 max-w-[44rem] text-[0.95rem] leading-relaxed text-ink-2">
        Bellek kendi başına model çalıştırmaz; sizin anahtarlarınızla, sizin seçtiğiniz yapay zekâlara bağlanır. İstediğiniz kadarını bağlayın,
        stüdyoda her istek için ayrı model seçebilirsiniz.
      </p>
      <ul className="overflow-hidden rounded-[14px] border border-line bg-surface">
        {app.providers.map((provider) => {
          const ready = isReady(provider);
          const expanded = open === provider.id;
          return (
            <li key={provider.id} className="border-b border-line last:border-0">
              <button
                type="button"
                aria-expanded={expanded}
                onClick={() => setOpen(expanded ? null : provider.id)}
                className="flex w-full items-center gap-3.5 px-5 py-4 text-left transition-colors hover:bg-sunken/60 max-sm:px-4"
              >
                <span
                  className={cx('h-2.5 w-2.5 flex-none rounded-full', ready ? 'bg-ok' : provider.hasKey ? 'bg-warn' : 'bg-line-strong')}
                  title={ready ? 'Bağlı' : provider.hasKey ? 'Kapalı' : 'Anahtar bekliyor'}
                />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-baseline gap-x-2.5">
                    <span className="text-[1rem] font-semibold">{provider.name}</span>
                    <span className="text-[0.82rem] text-ink-3">{ready ? summary(provider) : provider.hasKey ? 'kapalı' : provider.needsKey ? 'anahtar bekliyor' : summary(provider)}</span>
                  </span>
                  <span className="mt-0.5 block text-[0.88rem] text-ink-2">{provider.description}</span>
                </span>
                <ChevronDown className={cx('h-4 w-4 flex-none text-ink-3 transition-transform duration-200', expanded && 'rotate-180')} />
              </button>
              {expanded && <ProviderPanel provider={provider} />}
            </li>
          );
        })}
      </ul>
      <button type="button" className="btn btn-outline mt-4" onClick={() => setAdding(true)}>
        <Plus /> Özel sağlayıcı ekle
      </button>
      <CustomProviderDialog open={adding} onClose={() => setAdding(false)} />
    </div>
  );
}
