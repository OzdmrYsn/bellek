import { Search, Upload } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useAssets } from '../lib/queries.ts';
import { useUI } from '../lib/store.ts';
import { Dialog } from '../ui/Dialog.tsx';
import { Empty, Segmented, Spinner } from '../ui/kit.tsx';
import { AssetTile } from './AssetTile.tsx';
import { ACCEPT_ATTR, mediaFiles, uploadFiles } from './upload.ts';

type Tab = 'all' | 'uploaded' | 'generated' | 'favorite';

/** `pickAssets()` ile açılan, kütüphaneden görsel seçme penceresi. */
export function AssetPickerHost() {
  const request = useUI((state) => state.pickerRequest);
  const settle = useUI((state) => state.settlePicker);
  const [tab, setTab] = useState<Tab>('all');
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (request) {
      setSelected([]);
      setQuery('');
      setSearch('');
      setTab('all');
    }
  }, [request]);

  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(query.trim()), 200);
    return () => window.clearTimeout(timer);
  }, [query]);

  const filter = useMemo(
    () => ({
      kind: request?.kind,
      source: tab === 'uploaded' || tab === 'generated' ? tab : undefined,
      favorite: tab === 'favorite',
      q: search,
    }),
    [request?.kind, tab, search],
  );
  const assets = useAssets(filter, 48);
  const items = assets.data?.pages.flatMap((page) => page.items) ?? [];

  const toggle = (id: string) => {
    if (!request?.multiple) return settle([id]);
    setSelected((current) => (current.includes(id) ? current.filter((x) => x !== id) : [...current, id]));
  };

  const onFiles = async (files: File[]) => {
    if (!files.length) return;
    setUploading(true);
    const uploaded = await uploadFiles(files);
    setUploading(false);
    if (!uploaded.length) return;
    if (!request?.multiple) settle([uploaded[0].id]);
    else setSelected((current) => [...new Set([...current, ...uploaded.map((a) => a.id)])]);
  };

  return (
    <Dialog
      open={!!request}
      onClose={() => settle([])}
      size="xl"
      title={request?.title}
      footer={
        request?.multiple ? (
          <>
            <span className="mr-auto text-[0.88rem] text-ink-2">{selected.length ? `${selected.length} görsel seçildi` : 'Görsellere tıklayarak seçin'}</span>
            <button type="button" className="btn btn-outline" onClick={() => settle([])}>Vazgeç</button>
            <button type="button" className="btn btn-primary" disabled={!selected.length} onClick={() => settle(selected)}>
              Seçilenleri ekle
            </button>
          </>
        ) : undefined
      }
    >
      <div className="mb-4 flex flex-wrap items-center gap-2.5">
        <Segmented
          size="sm"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'all', label: 'Tümü' },
            { value: 'uploaded', label: 'Yüklenenler' },
            { value: 'generated', label: 'Üretilenler' },
            { value: 'favorite', label: 'Favoriler' },
          ]}
        />
        <div className="relative min-w-40 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-ink-3" />
          <input className="input !h-8 !pl-9" placeholder="Ara" aria-label="Kütüphanede ara" value={query} onChange={(event) => setQuery(event.target.value)} />
        </div>
        <button type="button" className="btn btn-outline btn-sm" disabled={uploading} onClick={() => fileInput.current?.click()}>
          {uploading ? <Spinner /> : <Upload />} Bilgisayardan yükle
        </button>
        <input
          ref={fileInput}
          type="file"
          hidden
          multiple={request?.multiple}
          accept={request?.kind === 'image' ? 'image/*,.heic,.heif' : ACCEPT_ATTR}
          onChange={(event) => {
            void onFiles(mediaFiles(event.target.files));
            event.target.value = '';
          }}
        />
      </div>

      {assets.isLoading ? (
        <div className="grid h-48 place-items-center text-ink-3"><Spinner /></div>
      ) : items.length === 0 ? (
        <Empty
          title={search ? 'Eşleşen görsel yok' : 'Burada henüz görsel yok'}
          body={search ? 'Aramayı değiştirin ya da bilgisayarınızdan yükleyin.' : 'Bilgisayarınızdan yükleyerek başlayın.'}
        />
      ) : (
        <>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-2.5">
            {items.map((asset) => (
              <AssetTile
                key={asset.id}
                asset={asset}
                actions={false}
                selectable={request?.multiple}
                selected={selected.includes(asset.id)}
                onSelect={() => toggle(asset.id)}
                onOpen={() => toggle(asset.id)}
                className="[&>button:first-child]:!cursor-pointer"
              />
            ))}
          </div>
          {assets.hasNextPage && (
            <div className="mt-4 text-center">
              <button type="button" className="btn btn-outline btn-sm" disabled={assets.isFetchingNextPage} onClick={() => void assets.fetchNextPage()}>
                {assets.isFetchingNextPage && <Spinner />} Daha fazla göster
              </button>
            </div>
          )}
        </>
      )}
    </Dialog>
  );
}
