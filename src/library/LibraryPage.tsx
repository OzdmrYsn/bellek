import { Clapperboard, Heart, Images, Search, Trash2, Upload, UserPlus, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { api } from '../lib/api.ts';
import { cx } from '../lib/format.ts';
import { invalidateAssets, useApp, useAssets, type AssetFilter } from '../lib/queries.ts';
import { attempt, toast, useUI } from '../lib/store.ts';
import { Empty, PageHeader, PageLoader, Segmented, Spinner } from '../ui/kit.tsx';
import { trashAssets } from './actions.ts';
import { AssetTile } from './AssetTile.tsx';
import { EntityPickerDialog } from './EntityPicker.tsx';
import { MontageDialog } from './MontageDialog.tsx';
import { ACCEPT_ATTR, filesFromDrop, hasFiles, mediaFiles, uploadFiles } from './upload.ts';

type Tab = 'all' | 'uploaded' | 'generated' | 'video' | 'favorite';

const TABS: { value: Tab; label: string }[] = [
  { value: 'all', label: 'Tümü' },
  { value: 'uploaded', label: 'Yüklenenler' },
  { value: 'generated', label: 'Üretilenler' },
  { value: 'video', label: 'Videolar' },
  { value: 'favorite', label: 'Favoriler' },
];

/** Süren montajın durumunu başlıkta gösterir; bitince haber verir. */
function MontageStatus({ jobId, onDone }: { jobId: string; onDone: () => void }) {
  const job = useUI((state) => state.jobs[jobId]);
  const status = job?.status;

  useEffect(() => {
    if (!job || status === 'queued' || status === 'running') return;
    if (status === 'succeeded') {
      const assetId = job.assetIds[0];
      toast('Montaj hazır; kütüphaneye eklendi.', 'ok', assetId ? { label: 'Aç', run: () => useUI.getState().openLightbox([assetId], 0) } : undefined);
      invalidateAssets();
    } else if (status === 'failed') {
      toast(job.error ?? 'Montaj tamamlanamadı.', 'error');
    }
    onDone();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  if (!job || (status !== 'queued' && status !== 'running')) return null;
  return (
    <span className="inline-flex h-9 items-center gap-2 rounded-full bg-sunken pr-1 pl-3 text-[0.86rem] text-ink-2" aria-live="polite">
      <Spinner className="!h-3.5 !w-3.5" />
      <span className="max-w-56 truncate">{job.stage ?? (status === 'queued' ? 'Montaj sırada' : 'Montaj hazırlanıyor')}</span>
      <button type="button" className="btn btn-ghost btn-sm !h-7" onClick={() => void attempt(() => api.post(`/api/jobs/${jobId}/cancel`))}>
        Vazgeç
      </button>
    </span>
  );
}

export function LibraryPage() {
  const app = useApp();
  const openLightbox = useUI((state) => state.openLightbox);
  const [params, setParams] = useSearchParams();
  const tab = (TABS.find((t) => t.value === params.get('tur'))?.value ?? 'all') as Tab;
  const entity = params.get('varlik') ?? '';
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [anchor, setAnchor] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [picker, setPicker] = useState<'link' | 'new' | null>(null);
  const [montage, setMontage] = useState(false);
  const [montageJob, setMontageJob] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const dragDepth = useRef(0);

  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(query.trim()), 220);
    return () => window.clearTimeout(timer);
  }, [query]);

  const filter = useMemo<AssetFilter>(
    () => ({
      kind: tab === 'video' ? 'video' : undefined,
      source: tab === 'uploaded' || tab === 'generated' ? tab : undefined,
      favorite: tab === 'favorite',
      entity: entity || undefined,
      q: search || undefined,
    }),
    [tab, entity, search],
  );
  const assets = useAssets(filter);
  const items = useMemo(() => assets.data?.pages.flatMap((page) => page.items) ?? [], [assets.data]);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = assets;

  useEffect(() => {
    const node = sentinel.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && hasNextPage && !isFetchingNextPage) void fetchNextPage();
      },
      { rootMargin: '600px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage, items.length]);

  // Süzgeç değişince seçim sıfırlanır; görünmeyen öğeler üzerinde toplu işlem yapılmasın.
  useEffect(() => {
    setSelected([]);
    setAnchor(null);
  }, [filter]);

  useEffect(() => {
    if (!selected.length) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !document.querySelector('dialog[open]')) setSelected([]);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected.length]);

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  const select = (index: number, shiftKey: boolean) => {
    const id = items[index].id;
    if (shiftKey && anchor !== null) {
      const [from, to] = [Math.min(anchor, index), Math.max(anchor, index)];
      const range = items.slice(from, to + 1).map((a) => a.id);
      setSelected((current) => [...new Set([...current, ...range])]);
    } else {
      setSelected((current) => (current.includes(id) ? current.filter((x) => x !== id) : [...current, id]));
      setAnchor(index);
    }
  };

  const upload = async (files: File[]) => {
    if (!files.length) return;
    setProgress(0);
    const added = await uploadFiles(files, {}, setProgress);
    setProgress(null);
    // Tek bir fotoğraf yüklendiyse sıradaki doğal adım içindeki kişileri seçmektir.
    const [only] = added;
    if (added.length === 1 && only.kind === 'image') {
      toast('Görsel kütüphaneye eklendi.', 'ok', { label: 'Kişileri seç', run: () => useUI.getState().openPeople(only) });
    }
  };

  const bulk = async (action: 'favorite') => {
    await attempt(() => api.post('/api/assets/bulk', { ids: selected, action }));
    invalidateAssets();
    setSelected([]);
  };

  const filtered = tab !== 'all' || !!entity || !!search;

  return (
    <div
      className="relative flex h-full flex-col"
      onDragEnter={(event) => {
        if (!hasFiles(event)) return;
        dragDepth.current++;
        setDragging(true);
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (!dragDepth.current) setDragging(false);
      }}
      onDragOver={(event) => hasFiles(event) && event.preventDefault()}
      onDrop={(event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        void upload(filesFromDrop(event));
      }}
    >
      <PageHeader
        title="Kütüphane"
        subtitle={`${app.counts.assets} görsel ve video · yüklediğiniz ve ürettiğiniz her şey burada durur`}
        actions={
          <>
            {montageJob && <MontageStatus key={montageJob} jobId={montageJob} onDone={() => setMontageJob(null)} />}
            <button type="button" className="btn btn-primary" disabled={progress !== null} onClick={() => fileInput.current?.click()}>
              {progress !== null ? <Spinner /> : <Upload />}
              {progress !== null ? `Yükleniyor %${Math.round(progress * 100)}` : 'Yükle'}
            </button>
            <input
              ref={fileInput}
              type="file"
              hidden
              multiple
              accept={ACCEPT_ATTR}
              onChange={(event) => {
                void upload(mediaFiles(event.target.files));
                event.target.value = '';
              }}
            />
          </>
        }
      >
        <div className="flex flex-wrap items-center gap-2.5 pb-3.5">
          <Segmented size="sm" value={tab} onChange={(value) => setParam('tur', value === 'all' ? '' : value)} options={TABS} />
          <select
            className="input !h-8 !w-auto max-w-52 !text-[0.86rem]"
            value={entity}
            onChange={(event) => setParam('varlik', event.target.value)}
            aria-label="Varlığa göre süz"
          >
            <option value="">Tüm kişiler ve markalar</option>
            {app.entities.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
          <div className="relative min-w-44 flex-1 sm:max-w-72">
            <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-ink-3" />
            <input
              className="input !h-8 !pl-9"
              placeholder="İstem, ad ya da model ara"
              aria-label="Kütüphanede ara"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
        </div>
      </PageHeader>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5 max-md:px-4">
        {assets.isLoading ? (
          <PageLoader />
        ) : items.length === 0 ? (
          filtered ? (
            <Empty icon={<Search />} title="Bu süzgece uyan bir şey yok" body="Süzgeçleri değiştirin ya da aramayı temizleyin." />
          ) : (
            <Empty
              icon={<Images />}
              title="Kütüphaneniz boş"
              body="Kişilerin, ürünlerin ve logoların fotoğraflarını yükleyin. Sonra birkaçını seçip bir kişiye ya da markaya dönüştürerek sohbette @ ile çağırabilirsiniz."
              action={
                <button type="button" className="btn btn-primary" onClick={() => fileInput.current?.click()}>
                  <Upload /> Görsel yükle
                </button>
              }
            />
          )
        ) : (
          <>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(10.5rem,1fr))] gap-3 max-sm:grid-cols-[repeat(auto-fill,minmax(7rem,1fr))] max-sm:gap-2">
              {items.map((asset, index) => (
                <AssetTile
                  key={asset.id}
                  asset={asset}
                  selectable
                  selected={selected.includes(asset.id)}
                  onSelect={(shiftKey) => select(index, shiftKey)}
                  onOpen={() => openLightbox(items.map((a) => a.id), index)}
                />
              ))}
            </div>
            <div ref={sentinel} className="grid h-16 place-items-center text-ink-3">
              {isFetchingNextPage && <Spinner />}
            </div>
          </>
        )}
      </div>

      {selected.length > 0 && (
        <div className="pointer-events-none absolute inset-x-0 bottom-5 flex justify-center px-4" style={{ zIndex: 'var(--z-sticky)' }}>
          <div className="pop pointer-events-auto flex animate-rise flex-wrap items-center gap-1 !rounded-2xl py-1.5 pr-1.5 pl-4">
            <span className="mr-2 text-[0.9rem] font-medium">{selected.length} seçili</span>
            <button type="button" className="btn btn-accent btn-sm" onClick={() => setPicker('new')}>
              <UserPlus /> Kişiye dönüştür
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPicker('link')}>
              Referansa ekle
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setMontage(true)} title="Seçilenleri tek videoda birleştir">
              <Clapperboard /> Montajla
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => void bulk('favorite')}>
              <Heart /> Favorile
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm !text-danger"
              onClick={() => {
                void trashAssets(selected);
                setSelected([]);
              }}
            >
              <Trash2 /> Sil
            </button>
            <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label="Seçimi temizle" onClick={() => setSelected([])}>
              <X />
            </button>
          </div>
        </div>
      )}

      <div
        aria-hidden={!dragging}
        className={cx(
          'pointer-events-none absolute inset-3 grid place-items-center rounded-2xl border-2 border-dashed border-accent-text bg-accent-soft/90 transition-opacity duration-150',
          dragging ? 'opacity-100' : 'opacity-0',
        )}
        style={{ zIndex: 'var(--z-sticky)' }}
      >
        <div className="text-center text-accent-text">
          <Upload className="mx-auto h-8 w-8" />
          <p className="mt-2 text-lg font-semibold">Kütüphaneye eklemek için bırakın</p>
        </div>
      </div>

      <MontageDialog
        open={montage}
        onClose={() => setMontage(false)}
        assets={selected.map((id) => items.find((asset) => asset.id === id)).filter((asset) => !!asset)}
        onStarted={(job) => {
          setMontageJob(job.id);
          setSelected([]);
        }}
      />

      <EntityPickerDialog
        open={!!picker}
        startNew={picker === 'new'}
        onClose={() => setPicker(null)}
        assetIds={selected}
        onDone={() => setSelected([])}
      />
    </div>
  );
}
