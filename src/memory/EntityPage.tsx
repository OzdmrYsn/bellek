import {
  ArrowLeft, Check, FolderOpen, MoreHorizontal, Pin, PinOff, Sparkles, Star, Trash2, Upload, X,
} from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { normalizeHandle } from '../../shared/handles.ts';
import { entityTypeLabel } from '../../shared/platforms.ts';
import type { EntityAsset, EntityAssetRole, EntityDetail } from '../../shared/types.ts';
import { api } from '../lib/api.ts';
import { cx } from '../lib/format.ts';
import { keys, queryClient, refreshApp, useEntity } from '../lib/queries.ts';
import { attempt, pickAssets, toast, useUI } from '../lib/store.ts';
import { AssetTile } from '../library/AssetTile.tsx';
import { ACCEPT_ATTR, filesFromDrop, hasFiles, mediaFiles, uploadFiles } from '../library/upload.ts';
import { Avatar, Empty, IconButton, Notice, PageLoader, Spinner } from '../ui/kit.tsx';
import { Menu, Popover } from '../ui/Popover.tsx';
import { BrandKit } from './BrandKit.tsx';
import { NotesPanel } from './NotesPanel.tsx';

const ROLE_LABEL: Record<EntityAssetRole, string> = { reference: 'Referans', logo: 'Logo', example: 'Örnek' };

function Section({ title, hint, actions, children }: { title: string; hint?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="border-t border-line py-7 first:border-0 first:pt-0">
      <div className="mb-3.5 flex flex-wrap items-end gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <h2 className="text-[1.08rem] font-semibold">{title}</h2>
          {hint && <p className="hint mt-0.5 max-w-[40rem]">{hint}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-1.5">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

function AutosaveArea({ value, onSave, placeholder, rows = 4, label }: { value: string; onSave: (value: string) => Promise<unknown>; placeholder: string; rows?: number; label: string }) {
  const [text, setText] = useState(value);
  const [state, setState] = useState<'idle' | 'saving' | 'saved'>('idle');
  useEffect(() => setText(value), [value]);
  return (
    <div className="relative">
      <textarea
        className="input"
        rows={rows}
        aria-label={label}
        placeholder={placeholder}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          setState('idle');
        }}
        onBlur={async () => {
          if (text === value) return;
          setState('saving');
          await onSave(text);
          setState('saved');
        }}
      />
      {state !== 'idle' && (
        <span className="pointer-events-none absolute right-2.5 bottom-2 flex items-center gap-1 text-[0.76rem] text-ink-3">
          {state === 'saving' ? <Spinner className="!h-3 !w-3" /> : <Check className="h-3 w-3 text-ok" />}
          {state === 'saving' ? 'Kaydediliyor' : 'Kaydedildi'}
        </span>
      )}
    </div>
  );
}

function HandleEditor({ entity, onSaved }: { entity: EntityDetail; onSaved: (detail: EntityDetail) => void }) {
  const [value, setValue] = useState(entity.handle);
  return (
    <Popover
      placement="bottom-start"
      className="w-72 !p-3.5"
      onOpenChange={(open) => open && setValue(entity.handle)}
      trigger={(props) => (
        <button type="button" {...props} className="mention cursor-pointer transition-opacity hover:opacity-75" title="Çağırma kimliğini değiştir">
          @{entity.handle}
        </button>
      )}
    >
      {(close) => (
        <form
          className="flex flex-col gap-2.5"
          onSubmit={async (event) => {
            event.preventDefault();
            const detail = await attempt(() => api.patch<EntityDetail>(`/api/entities/${entity.id}`, { handle: value }));
            if (detail) {
              onSaved(detail);
              close();
            }
          }}
        >
          <label className="block">
            <span className="label">Çağırma kimliği</span>
            <div className="relative">
              <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 font-mono text-ink-3">@</span>
              <input autoFocus className="input !pl-7 font-mono !text-[0.88rem]" value={value} onChange={(event) => setValue(normalizeHandle(event.target.value))} />
            </div>
          </label>
          <p className="hint">Eski sohbetlerdeki @{entity.handle} anmaları artık bu varlığı bulmaz.</p>
          <button type="submit" className="btn btn-primary btn-sm self-end" disabled={!value || value === entity.handle}>Değiştir</button>
        </form>
      )}
    </Popover>
  );
}

function ReferenceGrid({ entity, onChange }: { entity: EntityDetail; onChange: (detail: EntityDetail) => void }) {
  const openLightbox = useUI((s) => s.openLightbox);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const isBrand = entity.type === 'brand';

  const call = async (run: () => Promise<EntityDetail>) => {
    const detail = await attempt(run);
    if (detail) onChange(detail);
  };

  const reorder = (targetId: string) => {
    if (!dragId || dragId === targetId) return;
    const ids = entity.assets.map((a) => a.id);
    const from = ids.indexOf(dragId);
    const to = ids.indexOf(targetId);
    ids.splice(to, 0, ...ids.splice(from, 1));
    // İyimser: sırayı hemen göster.
    onChange({ ...entity, assets: ids.map((id) => entity.assets.find((a) => a.id === id)!) });
    void call(() => api.post<EntityDetail>(`/api/entities/${entity.id}/reorder`, { assetIds: ids }));
  };

  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))] gap-3">
      {entity.assets.map((asset: EntityAsset, index) => {
        const cover = entity.avatarAssetId === asset.id;
        return (
          <div
            key={asset.id}
            draggable
            onDragStart={(event) => {
              setDragId(asset.id);
              event.dataTransfer.effectAllowed = 'move';
              event.dataTransfer.setData('text/x-bellek-ref', asset.id);
            }}
            onDragEnd={() => {
              setDragId(null);
              setOverId(null);
            }}
            onDragOver={(event) => {
              if (!dragId) return;
              event.preventDefault();
              setOverId(asset.id);
            }}
            onDrop={(event) => {
              if (!dragId) return;
              event.preventDefault();
              event.stopPropagation();
              reorder(asset.id);
              setOverId(null);
            }}
            className={cx('group/ref relative transition-opacity', dragId === asset.id && 'opacity-40', overId === asset.id && dragId !== asset.id && 'rounded-[12px] ring-2 ring-accent')}
          >
            <AssetTile asset={asset} actions={false} onOpen={() => openLightbox(entity.assets.map((a) => a.id), index)} className={cx(asset.role === 'logo' && '[&_img]:!object-contain [&_img]:p-3')} />
            {cover && (
              <span className="pointer-events-none absolute top-2 left-2 flex items-center gap-1 rounded-md bg-accent px-1.5 py-0.5 text-[0.7rem] font-semibold text-on-accent">
                <Star className="h-3 w-3 fill-current" /> Kapak
              </span>
            )}
            {isBrand && !cover && (
              <span className="pointer-events-none absolute top-2 left-2 rounded-md bg-black/65 px-1.5 py-0.5 text-[0.7rem] font-medium text-white">{ROLE_LABEL[asset.role]}</span>
            )}
            <div className="absolute top-1.5 right-1.5 opacity-0 transition-opacity group-focus-within/ref:opacity-100 group-hover/ref:opacity-100">
              <Menu
                trigger={(props) => (
                  <button type="button" {...props} aria-label="Görsel seçenekleri" className="grid h-7 w-7 place-items-center rounded-md bg-black/65 text-white hover:bg-black/80">
                    <MoreHorizontal className="h-4 w-4" />
                  </button>
                )}
                items={[
                  {
                    label: cover ? 'Kapak olmaktan çıkar' : 'Kapak yap (en güçlü referans)',
                    icon: <Star />,
                    onSelect: () => void call(() => api.patch<EntityDetail>(`/api/entities/${entity.id}`, { avatarAssetId: cover ? null : asset.id })),
                  },
                  ...(['logo', 'example', 'reference'] as EntityAssetRole[])
                    .filter((role) => isBrand && role !== asset.role)
                    .map((role) => ({
                      label: `${ROLE_LABEL[role]} olarak işaretle`,
                      onSelect: () => void call(() => api.patch<EntityDetail>(`/api/entities/${entity.id}/assets/${asset.id}`, { role })),
                    })),
                  'divider' as const,
                  {
                    label: 'Referanslardan çıkar',
                    icon: <X />,
                    danger: true,
                    onSelect: () => void call(() => api.del<EntityDetail>(`/api/entities/${entity.id}/assets/${asset.id}`)),
                  },
                ]}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function EntityPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const query = useEntity(id);
  const entity = query.data;
  const setPrefill = useUI((s) => s.setPrefill);
  const openLightbox = useUI((s) => s.openLightbox);
  const fileInput = useRef<HTMLInputElement>(null);
  const [name, setName] = useState('');
  const [uploading, setUploading] = useState(false);
  const [profiling, setProfiling] = useState(false);
  const [dropping, setDropping] = useState(false);

  useEffect(() => setName(entity?.name ?? ''), [entity?.name]);

  if (query.isLoading) return <PageLoader />;
  if (!entity || entity.deletedAt) {
    return (
      <Empty
        className="pt-28"
        title="Bu kayıt bulunamadı"
        body="Silinmiş olabilir. Çöp kutusuna Ayarlar → Veri bölümünden ulaşabilirsiniz."
        action={<Link to="/hafiza" className="btn btn-primary">Hafızaya dön</Link>}
      />
    );
  }

  const apply = (detail: EntityDetail) => {
    queryClient.setQueryData(keys.entity(entity.id), detail);
    void refreshApp();
  };
  const patch = async (body: object) => {
    const detail = await attempt(() => api.patch<EntityDetail>(`/api/entities/${entity.id}`, body));
    if (detail) apply(detail);
    return detail;
  };

  const role: EntityAssetRole = entity.type === 'brand' && !entity.assets.some((a) => a.role === 'logo') ? 'logo' : entity.type === 'brand' ? 'example' : 'reference';

  const addFiles = async (files: File[]) => {
    if (!files.length) return;
    setUploading(true);
    const uploaded = await uploadFiles(files, { entityId: entity.id, role });
    setUploading(false);
    if (uploaded.length) void queryClient.invalidateQueries({ queryKey: keys.entity(entity.id) });
  };

  const addFromLibrary = async () => {
    const ids = await pickAssets({ title: `${entity.name} için görsel seç`, multiple: true, kind: 'image' });
    if (!ids.length) return;
    const detail = await attempt(() => api.post<EntityDetail>(`/api/entities/${entity.id}/assets`, { assetIds: ids, role }));
    if (detail) apply(detail);
  };

  const buildProfile = async () => {
    setProfiling(true);
    const detail = await attempt(() => api.post<EntityDetail>(`/api/entities/${entity.id}/profile`), 'Profil çıkarıldı.');
    setProfiling(false);
    if (detail) apply(detail);
  };

  const remove = async () => {
    await attempt(() => api.del(`/api/entities/${entity.id}`));
    void refreshApp();
    navigate('/hafiza');
    toast(`${entity.name} çöp kutusuna taşındı.`, 'info', {
      label: 'Geri al',
      run: () => void api.post('/api/trash/restore', { kind: 'entity', id: entity.id }).then(refreshApp),
    });
  };

  const isPerson = entity.type === 'person';
  const isBrand = entity.type === 'brand';
  const imageCount = entity.assets.length;

  return (
    <div
      className="relative h-full overflow-y-auto"
      onDragOver={(event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        setDropping(true);
      }}
      onDragLeave={(event) => event.currentTarget === event.target && setDropping(false)}
      onDrop={(event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        setDropping(false);
        void addFiles(filesFromDrop(event));
      }}
    >
      <div className="mx-auto w-full max-w-[62rem] px-6 pt-5 pb-16 max-md:px-4">
        <Link to={`/hafiza${entity.type === 'person' ? '' : `?sekme=${entity.type}`}`} className="btn btn-ghost btn-sm -ml-2.5 mb-3">
          <ArrowLeft /> Hafıza
        </Link>

        <header className="flex flex-wrap items-center gap-x-5 gap-y-4 pb-7">
          <Avatar entity={entity} size={76} />
          <div className="min-w-0 flex-1">
            <input
              className="-mx-2 w-full max-w-[28rem] rounded-lg bg-transparent px-2 py-0.5 text-[1.75rem] leading-tight font-semibold tracking-[-0.02em] outline-none hover:bg-sunken focus:bg-sunken"
              aria-label="Ad"
              value={name}
              onChange={(event) => setName(event.target.value)}
              onBlur={() => name.trim() && name.trim() !== entity.name ? void patch({ name }) : setName(entity.name)}
              onKeyDown={(event) => event.key === 'Enter' && (event.target as HTMLInputElement).blur()}
            />
            <div className="mt-1 flex flex-wrap items-center gap-2 text-[0.88rem] text-ink-3">
              <HandleEditor entity={entity} onSaved={apply} />
              <span>{entityTypeLabel(entity.type)}</span>
              {entity.pinned && <span className="inline-flex items-center gap-1"><Pin className="h-3 w-3" /> sabit</span>}
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              className="btn btn-accent"
              onClick={() => {
                setPrefill({ text: `@${entity.handle} `, mode: isBrand ? 'post' : 'image' });
                navigate('/');
              }}
            >
              <Sparkles /> Bununla üret
            </button>
            <Menu
              trigger={(props) => (
                <IconButton label="Diğer" variant="outline" {...props}>
                  <MoreHorizontal />
                </IconButton>
              )}
              items={[
                { label: entity.pinned ? 'Sabitlemeyi kaldır' : 'Listenin başına sabitle', icon: entity.pinned ? <PinOff /> : <Pin />, onSelect: () => void patch({ pinned: !entity.pinned }) },
                'divider',
                { label: 'Çöp kutusuna taşı', icon: <Trash2 />, danger: true, onSelect: () => void remove() },
              ]}
            />
          </div>
        </header>

        <Section
          title={isBrand ? 'Logo ve örnek görseller' : 'Referans görseller'}
          hint={
            isPerson
              ? 'Üretimlere bu fotoğraflar eklenir. Kapak ilk sırada gider; sürükleyerek sıralayın. Farklı açı ve ışıkta 3–5 net fotoğraf idealdir.'
              : isBrand
                ? 'Logo aynen yerleştirilir; örnek görseller markanın görsel dilini taşır.'
                : 'Üretimlere bu görseller referans olarak eklenir. Sürükleyerek sıralayın.'
          }
          actions={
            <>
              <button type="button" className="btn btn-outline btn-sm" onClick={addFromLibrary}>
                <FolderOpen /> Kütüphaneden
              </button>
              <button type="button" className="btn btn-primary btn-sm" disabled={uploading} onClick={() => fileInput.current?.click()}>
                {uploading ? <Spinner /> : <Upload />} Yükle
              </button>
              <input
                ref={fileInput}
                type="file"
                hidden
                multiple
                accept={ACCEPT_ATTR}
                onChange={(event) => {
                  void addFiles(mediaFiles(event.target.files));
                  event.target.value = '';
                }}
              />
            </>
          }
        >
          {imageCount ? (
            <>
              {isPerson && imageCount < 3 && (
                <div className="mb-3">
                  <Notice level="info">
                    {imageCount} fotoğraf var. Yüz benzerliğinin tutarlı olması için en az 3 farklı açı ekleyin.
                  </Notice>
                </div>
              )}
              <ReferenceGrid entity={entity} onChange={apply} />
            </>
          ) : (
            <button
              type="button"
              onClick={() => fileInput.current?.click()}
              className="flex w-full flex-col items-center gap-2 rounded-2xl border border-dashed border-line-strong px-6 py-12 text-center transition-colors hover:bg-sunken"
            >
              <Upload className="h-6 w-6 text-ink-3" />
              <span className="font-medium">Görselleri buraya sürükleyin ya da seçin</span>
              <span className="hint max-w-sm">
                {isPerson ? 'Görsel olmadan da çağırabilirsiniz, ama yüzün tutarlı çıkması için fotoğraf gerekir.' : 'JPEG, PNG, WebP ve HEIC desteklenir.'}
              </span>
            </button>
          )}
        </Section>

        {isBrand && (
          <Section title="Marka kiti" hint="Burada yazan her şey, marka anıldığında ya da sohbete sabitlendiğinde modele iletilir.">
            <BrandKit entity={entity} />
          </Section>
        )}

        <Section
          title={isPerson ? 'Görünüm profili' : 'Görsel profil'}
          hint={
            isPerson
              ? 'Fotoğraflardan çıkarılan yazılı tarif. İstem yazılırken kullanılır ve fotoğrafların yanında tutarlılığı güçlendirir.'
              : 'Görsellerden çıkarılan yazılı tarif; istem yazılırken kullanılır.'
          }
          actions={
            <button type="button" className="btn btn-outline btn-sm" disabled={profiling || !imageCount} onClick={buildProfile}>
              {profiling ? <Spinner /> : <Sparkles />} {entity.profile ? 'Yeniden çıkar' : 'Görsellerden çıkar'}
            </button>
          }
        >
          <AutosaveArea
            label="Profil"
            value={entity.profile}
            rows={4}
            placeholder={isPerson ? 'Örn. Otuzlu yaşlarda, kısa koyu saçlı, hafif sakallı; genellikle koyu renk sade giyinir…' : 'Bu varlığın görsel özelliklerini anlatın ya da görsellerden otomatik çıkarın.'}
            onSave={(profile) => patch({ profile })}
          />
        </Section>

        <Section title="Notlar ve kurallar" hint="Serbest notlarınız ve Bellek'in sohbetlerden öğrendikleri. Bu varlık her anıldığında okunur.">
          <AutosaveArea
            label="Açıklama"
            value={entity.description}
            rows={3}
            placeholder={isPerson ? 'Örn. Kurucu ortak. LinkedIn görsellerinde takım elbise, Instagram’da gündelik.' : 'Bu varlık hakkında bilinmesi gerekenler.'}
            onSave={(description) => patch({ description })}
          />
          <div className="mt-5">
            <NotesPanel entityId={entity.id} placeholder={`${entity.name} hakkında hatırlanacak bir kural ya da tercih`} />
          </div>
        </Section>

        {entity.generations.length > 0 && (
          <Section
            title="Bununla üretilenler"
            actions={<Link to={`/kutuphane?varlik=${entity.id}`} className="btn btn-ghost btn-sm">Tümünü kütüphanede gör</Link>}
          >
            <div className="grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-2.5">
              {entity.generations.slice(0, 18).map((asset, index) => (
                <AssetTile key={asset.id} asset={asset} onOpen={() => openLightbox(entity.generations.map((a) => a.id), index)} />
              ))}
            </div>
          </Section>
        )}
      </div>

      {dropping && (
        <div className="pointer-events-none fixed inset-3 grid place-items-center rounded-2xl border-2 border-dashed border-accent-text bg-accent-soft/90 lg:left-[calc(264px+0.75rem)]" style={{ zIndex: 'var(--z-sticky)' }}>
          <p className="text-lg font-semibold text-accent-text">{entity.name} referanslarına eklemek için bırakın</p>
        </div>
      )}
    </div>
  );
}
