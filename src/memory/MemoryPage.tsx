import { Brain, Plus, Upload, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { handleCandidates, normalizeHandle } from '../../shared/handles.ts';
import { ENTITY_TYPES } from '../../shared/platforms.ts';
import type { Entity, EntityType } from '../../shared/types.ts';
import { api } from '../lib/api.ts';
import { cx } from '../lib/format.ts';
import { refreshApp, useApp } from '../lib/queries.ts';
import { attempt } from '../lib/store.ts';
import { ACCEPT_ATTR, filesFromDrop, hasFiles, mediaFiles, uploadFiles } from '../library/upload.ts';
import { Dialog } from '../ui/Dialog.tsx';
import { Avatar, Empty, Field, PageHeader, Segmented, Spinner, TabBar } from '../ui/kit.tsx';
import { NotesPanel } from './NotesPanel.tsx';

type Tab = EntityType | 'notes';

const EMPTY_COPY: Record<EntityType, { title: string; body: string; cta: string }> = {
  person: {
    title: 'Henüz kimse yok',
    body: 'Bir kişinin birkaç fotoğrafını yükleyin; yüzü ve görünümü her üretimde aynı kalsın. Sohbette @ad yazmanız yeter.',
    cta: 'İlk kişiyi ekle',
  },
  brand: {
    title: 'Henüz marka yok',
    body: 'Logoyu, renkleri, yazı tiplerini ve ses tonunu bir kez girin. Her gönderi ve görsel markanın kimliğiyle gelsin.',
    cta: 'İlk markayı ekle',
  },
  product: {
    title: 'Henüz ürün yok',
    body: 'Ürün fotoğraflarını yükleyin; ambalajı, etiketi ve biçimi görsellerde aynen korunsun.',
    cta: 'İlk ürünü ekle',
  },
  style: {
    title: 'Henüz stil yok',
    body: 'Beğendiğiniz görselleri bir stil olarak kaydedin; aynı ışığı ve atmosferi başka konulara uygulayın.',
    cta: 'İlk stili ekle',
  },
  place: {
    title: 'Henüz mekân yok',
    body: 'Ofisinizi, mağazanızı ya da sık kullandığınız bir sahneyi kaydedin; çekimler orada geçsin.',
    cta: 'İlk mekânı ekle',
  },
};

function EntityCard({ entity }: { entity: Entity }) {
  const [first, ...rest] = entity.previewUrls;
  return (
    <Link
      to={`/hafiza/${entity.id}`}
      className="group flex flex-col overflow-hidden rounded-[14px] border border-line bg-surface transition-[border-color,transform] duration-200 hover:border-line-strong active:scale-[0.99]"
    >
      <div className="flex aspect-[5/3] gap-px overflow-hidden bg-line">
        {first ? (
          <>
            <img src={first} alt="" loading="lazy" className={cx('h-full object-cover', rest.length ? 'w-2/3' : 'w-full', entity.type === 'brand' && '!object-contain bg-sunken p-4')} />
            {rest.length > 0 && (
              <div className="flex w-1/3 flex-col gap-px">
                {rest.slice(0, 2).map((url) => (
                  <img key={url} src={url} alt="" loading="lazy" className="min-h-0 w-full flex-1 object-cover" />
                ))}
              </div>
            )}
          </>
        ) : (
          <div className="grid h-full w-full place-items-center bg-sunken">
            <Avatar entity={entity} size={52} />
          </div>
        )}
      </div>
      <div className="flex items-center gap-3 px-3.5 py-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[0.98rem] font-semibold">{entity.name}</div>
          <div className="meta truncate">@{entity.handle}</div>
        </div>
        <span className="flex-none text-[0.8rem] text-ink-3">
          {entity.assetCount ? `${entity.assetCount} görsel` : 'görsel yok'}
        </span>
      </div>
    </Link>
  );
}

export function EntityCreateDialog({ type: initialType, initialName, open, onClose }: { type: EntityType; initialName?: string; open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const app = useApp();
  const [type, setType] = useState<EntityType>(initialType);
  const [name, setName] = useState('');
  const [handle, setHandle] = useState('');
  const [handleTouched, setHandleTouched] = useState(false);
  const [assetIds, setAssetIds] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setType(initialType);
      setName(initialName ?? '');
      setHandle('');
      setHandleTouched(false);
      setAssetIds([]);
    }
  }, [open, initialType, initialName]);

  const taken = new Set(app.entities.map((e) => e.handle));
  const suggested = handleCandidates(name || 'x').find((h) => !taken.has(h)) ?? `${handleCandidates(name || 'x')[0]}2`;
  const effective = handleTouched ? normalizeHandle(handle) : name.trim() ? suggested : '';
  const clash = handleTouched && taken.has(effective);

  const add = async (files: File[]) => {
    if (!files.length) return;
    setUploading(true);
    const uploaded = await uploadFiles(files);
    setUploading(false);
    setAssetIds((current) => [...new Set([...current, ...uploaded.filter((a) => a.kind === 'image').map((a) => a.id)])]);
  };

  const create = async () => {
    setBusy(true);
    const entity = await attempt(() =>
      api.post<Entity>('/api/entities', {
        type, name, handle: handleTouched ? effective : undefined, assetIds, role: type === 'brand' ? 'logo' : 'reference',
      }),
    );
    setBusy(false);
    if (!entity) return;
    void refreshApp();
    onClose();
    navigate(`/hafiza/${entity.id}`);
  };

  const info = ENTITY_TYPES.find((t) => t.id === type)!;
  const photoLabel = type === 'brand' ? 'Logo' : type === 'person' ? 'Fotoğraflar' : 'Görseller';

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="md"
      title="Hafızaya ekle"
      description={`${info.hint}.`}
      footer={
        <>
          <button type="button" className="btn btn-outline" onClick={onClose}>Vazgeç</button>
          <button type="button" className="btn btn-primary" disabled={!name.trim() || clash || busy || uploading} onClick={create}>
            {busy && <Spinner />} Kaydet
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Segmented size="sm" className="self-start" value={type} onChange={setType} options={ENTITY_TYPES.map((t) => ({ value: t.id, label: t.label }))} />

        <div className="grid gap-3 sm:grid-cols-[1fr_11rem]">
          <Field label="Ad">
            <input
              autoFocus
              className="input"
              placeholder={type === 'person' ? 'Örn. Yasin Özdemir' : type === 'brand' ? 'Örn. Acme Kahve' : 'Ad'}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Field label="Çağırma kimliği" error={clash ? 'Bu kimlik kullanılıyor.' : null}>
            <div className="relative">
              <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 font-mono text-[0.9rem] text-ink-3">@</span>
              <input
                className="input !pl-7 font-mono !text-[0.88rem]"
                placeholder="kimlik"
                aria-invalid={clash}
                value={handleTouched ? handle : effective}
                onChange={(event) => {
                  setHandleTouched(true);
                  setHandle(normalizeHandle(event.target.value));
                }}
              />
            </div>
          </Field>
        </div>

        <div>
          <span className="label">{photoLabel}</span>
          <div
            onDragOver={(event) => {
              if (hasFiles(event)) {
                event.preventDefault();
                setOver(true);
              }
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(event) => {
              if (!hasFiles(event)) return;
              event.preventDefault();
              setOver(false);
              void add(filesFromDrop(event));
            }}
            className={cx(
              'rounded-xl border border-dashed p-3 transition-colors',
              over ? 'border-accent-text bg-accent-soft' : 'border-line-strong',
            )}
          >
            <div className="flex flex-wrap gap-2">
              {assetIds.map((id) => (
                <span key={id} className="group/p relative h-16 w-16 overflow-hidden rounded-lg bg-sunken">
                  <img src={`/media/${id}/thumb`} alt="" className="h-full w-full object-cover" />
                  <button
                    type="button"
                    aria-label="Kaldır"
                    onClick={() => setAssetIds((current) => current.filter((x) => x !== id))}
                    className="absolute top-0.5 right-0.5 grid h-5 w-5 place-items-center rounded-full bg-black/70 text-white opacity-0 group-hover/p:opacity-100 focus-visible:opacity-100"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
              <button
                type="button"
                onClick={() => fileInput.current?.click()}
                className={cx(
                  'flex items-center justify-center gap-2 rounded-lg text-[0.88rem] text-ink-2 transition-colors hover:bg-sunken hover:text-ink',
                  assetIds.length ? 'h-16 w-16 flex-col !gap-0.5 border border-line text-[0.74rem]' : 'h-16 flex-1',
                )}
              >
                {uploading ? <Spinner /> : <Upload className="h-4 w-4" />}
                {assetIds.length ? 'Ekle' : 'Sürükleyip bırakın ya da seçin'}
              </button>
            </div>
            <input
              ref={fileInput}
              type="file"
              hidden
              multiple
              accept={ACCEPT_ATTR}
              onChange={(event) => {
                void add(mediaFiles(event.target.files));
                event.target.value = '';
              }}
            />
          </div>
          <p className="hint mt-1.5">
            {type === 'person'
              ? 'Farklı açılardan 3–5 net fotoğraf en iyi sonucu verir. Yalnızca görüntüsünü kullanma izniniz olan kişileri ekleyin.'
              : type === 'brand'
                ? 'Saydam arka planlı PNG logo en temiz sonucu verir. Renkleri ve ses tonunu sonraki adımda girersiniz.'
                : 'Görselleri şimdi ya da daha sonra ekleyebilirsiniz.'}
          </p>
        </div>
      </div>
    </Dialog>
  );
}

export function MemoryPage() {
  const app = useApp();
  const [params, setParams] = useSearchParams();
  const requested = params.get('yeni') as EntityType | null;
  const tabParam = params.get('sekme');
  const tab: Tab = tabParam === 'notes' || ENTITY_TYPES.some((t) => t.id === tabParam) ? (tabParam as Tab) : requested ?? 'person';
  const [creating, setCreating] = useState<EntityType | null>(null);
  const [prefillName, setPrefillName] = useState('');

  // Başka sayfalardan "?yeni=person&ad=…" ile gelindiğinde formu aç.
  useEffect(() => {
    if (requested && ENTITY_TYPES.some((t) => t.id === requested)) {
      setPrefillName(params.get('ad') ?? '');
      setCreating(requested);
      const next = new URLSearchParams(params);
      next.delete('yeni');
      next.delete('ad');
      next.set('sekme', requested);
      setParams(next, { replace: true });
    }
  }, [requested, params, setParams]);

  const setTab = (value: Tab) => setParams(value === 'person' ? {} : { sekme: value }, { replace: true });
  const entities = tab === 'notes' ? [] : app.entities.filter((e) => e.type === tab);
  const countOf = (type: EntityType) => app.entities.filter((e) => e.type === type).length;
  const activeType: EntityType = tab === 'notes' ? 'person' : tab;

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Hafıza"
        subtitle="Bellek'in tanıdığı herkes ve her şey. Burada ne varsa sohbette @ ile çağrılır."
        actions={
          tab !== 'notes' && (
            <button type="button" className="btn btn-primary" onClick={() => { setPrefillName(''); setCreating(activeType); }}>
              <Plus /> {ENTITY_TYPES.find((t) => t.id === activeType)!.label} ekle
            </button>
          )
        }
      >
        <TabBar
          value={tab}
          onChange={setTab}
          tabs={[
            ...ENTITY_TYPES.map((t) => ({ value: t.id as Tab, label: t.plural, count: countOf(t.id) })),
            { value: 'notes' as Tab, label: 'Notlar', count: app.counts.memories },
          ]}
        />
      </PageHeader>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6 max-md:px-4">
        {tab === 'notes' ? (
          <div className="mx-auto max-w-[46rem]">
            <NotesPanel />
          </div>
        ) : entities.length ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(15.5rem,1fr))] gap-4">
            {entities.map((entity) => (
              <EntityCard key={entity.id} entity={entity} />
            ))}
          </div>
        ) : (
          <Empty
            icon={<Brain />}
            title={EMPTY_COPY[activeType].title}
            body={EMPTY_COPY[activeType].body}
            action={
              <button type="button" className="btn btn-primary" onClick={() => setCreating(activeType)}>
                <Plus /> {EMPTY_COPY[activeType].cta}
              </button>
            }
          />
        )}
      </div>

      <EntityCreateDialog type={creating ?? activeType} initialName={prefillName} open={!!creating} onClose={() => setCreating(null)} />
    </div>
  );
}
