import {
  Brush, ChevronLeft, ChevronRight, Clapperboard, Copy, Download, Eraser, Heart, LayoutTemplate, Newspaper, Pencil,
  RotateCw, Scaling, ScanFace, Trash2, UserPlus, X,
} from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import type { Asset, Job, JobRef } from '../../shared/types.ts';
import { api } from '../lib/api.ts';
import { bytes, copyText, cx, dateTime, duration } from '../lib/format.ts';
import { useAsset, useEntities } from '../lib/queries.ts';
import { toast, useUI } from '../lib/store.ts';
import { Dialog } from '../ui/Dialog.tsx';
import { Avatar, IconButton, Spinner } from '../ui/kit.tsx';
import { downloadAsset, patchAsset, toggleFavorite, trashAssets, useAssetActions } from './actions.ts';
import { EntityPickerDialog } from './EntityPicker.tsx';
import { MaskEditor } from './MaskEditor.tsx';

const SOURCE_LABEL: Record<Asset['source'], string> = {
  upload: 'Yüklendi', generated: 'Üretildi', crop: 'Kırpım', design: 'Tasarım',
};

const TOOL_LABEL: Record<string, string> = {
  inpaint: 'Bölge düzenleniyor',
  'remove-bg': 'Arka plan siliniyor',
  upscale: 'Büyütülüyor',
};

function Action({ icon, label, onClick, danger, active, disabled, title }: { icon: ReactNode; label: string; onClick: () => void; danger?: boolean; active?: boolean; disabled?: boolean; title?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cx(
        'flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-left text-[0.9rem] transition-colors hover:bg-sunken disabled:pointer-events-none disabled:opacity-45 [&>svg]:h-4 [&>svg]:w-4 [&>svg]:flex-none',
        danger ? 'text-danger' : 'text-ink',
        active && '[&>svg]:fill-accent [&>svg]:text-accent',
      )}
    >
      {icon}
      {label}
    </button>
  );
}

function TitleField({ asset }: { asset: Asset }) {
  const [value, setValue] = useState(asset.title ?? '');
  useEffect(() => setValue(asset.title ?? ''), [asset.id, asset.title]);
  const save = async () => {
    if ((asset.title ?? '') === value.trim()) return;
    try {
      patchAsset(await api.patch<Asset>(`/api/assets/${asset.id}`, { title: value }));
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Ad kaydedilemedi.', 'error');
    }
  };
  return (
    <input
      className="-mx-2 w-[calc(100%+1rem)] rounded-md bg-transparent px-2 py-1 text-[1.02rem] font-semibold outline-none hover:bg-sunken focus:bg-sunken"
      placeholder="Adsız görsel"
      aria-label="Görsel adı"
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onBlur={save}
      onKeyDown={(event) => event.key === 'Enter' && (event.target as HTMLInputElement).blur()}
    />
  );
}

export function Lightbox() {
  const state = useUI((s) => s.lightbox);
  const setIndex = useUI((s) => s.setLightboxIndex);
  const close = useUI((s) => s.closeLightbox);
  const openLightbox = useUI((s) => s.openLightbox);
  const entities = useEntities();
  const act = useAssetActions();
  const [picking, setPicking] = useState(false);
  const cropping = useUI((s) => !!s.peopleAsset);
  const [masking, setMasking] = useState(false);
  /** Görsel başına süren araç işi: sonuç gelince pencere ona geçer. */
  const [tools, setTools] = useState<Record<string, string>>({});

  const id = state?.ids[state.index];
  const toolJob = useUI((s) => (id && tools[id] ? s.jobs[tools[id]] : undefined));
  const working = toolJob?.status === 'queued' || toolJob?.status === 'running';
  const { data: asset, isLoading } = useAsset(id);
  const count = state?.ids.length ?? 0;

  useEffect(() => {
    if (!state) return;
    const onKey = (event: KeyboardEvent) => {
      if (picking || cropping || masking) return;
      const tag = (event.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (event.key === 'ArrowRight' && state.index < count - 1) setIndex(state.index + 1);
      if (event.key === 'ArrowLeft' && state.index > 0) setIndex(state.index - 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state, count, setIndex, picking, cropping, masking]);

  const track = (sourceId: string, job: Job) => {
    useUI.getState().putJobs([job]);
    setTools((current) => ({ ...current, [sourceId]: job.id }));
  };

  const runTool = async (op: 'remove-bg' | 'upscale') => {
    if (!asset) return;
    try {
      track(asset.id, await api.post<Job>(`/api/assets/${asset.id}/tools`, { op }));
    } catch (error) {
      toast(error instanceof Error ? error.message : 'İşlem başlatılamadı.', 'error');
    }
  };

  // Araç işi bitince: sonuç, kaynağın hemen yanına eklenir ve gösterilir.
  useEffect(() => {
    if (!toolJob || !id || working) return;
    setTools((current) => {
      const { [id]: _done, ...rest } = current;
      return rest;
    });
    if (toolJob.status === 'failed') {
      toast(toolJob.error ?? 'İşlem tamamlanamadı.', 'error');
      return;
    }
    const resultId = toolJob.assetIds[0];
    const current = useUI.getState().lightbox;
    if (toolJob.status !== 'succeeded' || !resultId || !current) return;
    const at = current.ids.indexOf(id);
    if (at < 0) return;
    const ids = [...current.ids.slice(0, at + 1), resultId, ...current.ids.slice(at + 1).filter((x) => x !== resultId)];
    openLightbox(ids, at + 1);
    toast('Yeni görsel olarak kaydedildi; özgün dosya duruyor.', 'ok');
  }, [toolJob, working, id, openLightbox]);

  const refs = (asset?.params?.refs as JobRef[] | undefined) ?? [];
  const finalPrompt = asset?.params?.finalPrompt as string | undefined;
  const usedEntities = entities.filter((e) => ((asset?.params?.entityIds as string[] | undefined) ?? []).includes(e.id));
  const linked = entities.filter((e) => asset?.entityIds.includes(e.id));

  const remove = async () => {
    if (!asset || !state) return;
    await trashAssets([asset.id]);
    const ids = state.ids.filter((x) => x !== asset.id);
    if (!ids.length) close();
    else openLightbox(ids, Math.min(state.index, ids.length - 1));
  };

  return (
    <Dialog open={!!state} onClose={close} bare className="!m-0 !h-dvh !max-h-none !w-screen !rounded-none !border-0 !bg-stage">
      <div className="flex h-dvh w-screen max-md:flex-col">
        <div className="relative flex min-h-0 min-w-0 flex-1 items-center justify-center p-4 md:p-8">
          {isLoading || !asset ? (
            <Spinner className="!h-6 !w-6 text-white/60" />
          ) : asset.kind === 'video' ? (
            <video key={asset.id} src={asset.url} controls autoPlay loop playsInline className="max-h-full max-w-full rounded-lg" />
          ) : (
            <img
              key={asset.id}
              src={asset.url}
              alt={asset.title ?? asset.prompt ?? ''}
              className={cx('max-h-full max-w-full animate-fade rounded-lg object-contain transition-opacity duration-300', working && 'opacity-45')}
            />
          )}

          {working && toolJob && (
            <div role="status" className="absolute bottom-12 left-1/2 flex -translate-x-1/2 items-center gap-2.5 rounded-full bg-black/75 py-1.5 pr-1.5 pl-3.5 text-[0.86rem] text-white">
              <Spinner className="text-white/80" />
              <span>{toolJob.stage ?? TOOL_LABEL[toolJob.input.op ?? ''] ?? 'Çalışıyor'}…</span>
              <button
                type="button"
                className="rounded-full bg-white/15 px-2.5 py-1 text-[0.8rem] transition-colors hover:bg-white/25"
                onClick={() => void api.post(`/api/jobs/${toolJob.id}/cancel`).catch(() => undefined)}
              >
                Vazgeç
              </button>
            </div>
          )}

          <button
            type="button"
            onClick={close}
            aria-label="Kapat"
            className="absolute top-3 left-3 grid h-9 w-9 place-items-center rounded-full bg-white/10 text-stage-ink transition-colors hover:bg-white/20 md:hidden"
          >
            <X className="h-5 w-5" />
          </button>
          {count > 1 && state && (
            <>
              <button
                type="button"
                aria-label="Önceki"
                disabled={state.index === 0}
                onClick={() => setIndex(state.index - 1)}
                className="absolute top-1/2 left-3 grid h-10 w-10 -translate-y-1/2 place-items-center rounded-full bg-white/10 text-stage-ink transition-colors hover:bg-white/20 disabled:opacity-25"
              >
                <ChevronLeft className="h-5 w-5" />
              </button>
              <button
                type="button"
                aria-label="Sonraki"
                disabled={state.index === count - 1}
                onClick={() => setIndex(state.index + 1)}
                className="absolute top-1/2 right-3 grid h-10 w-10 -translate-y-1/2 place-items-center rounded-full bg-white/10 text-stage-ink transition-colors hover:bg-white/20 disabled:opacity-25"
              >
                <ChevronRight className="h-5 w-5" />
              </button>
              <span className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-black/50 px-2.5 py-1 font-mono text-[0.74rem] text-white/85">
                {state.index + 1} / {count}
              </span>
            </>
          )}
        </div>

        <aside className="flex w-full flex-none flex-col overflow-y-auto bg-surface text-ink md:w-[21.5rem] max-md:max-h-[46dvh]">
          {asset && (
            <>
              <div className="flex items-start gap-2 px-5 pt-4 pb-1">
                <div className="min-w-0 flex-1">
                  <TitleField asset={asset} />
                  <p className="note mt-0.5">
                    {SOURCE_LABEL[asset.source]} · {dateTime(asset.createdAt)}
                  </p>
                </div>
                <IconButton label="Kapat (Esc)" size="sm" className="max-md:hidden" onClick={close}>
                  <X />
                </IconButton>
              </div>

              <div className="grid grid-cols-2 gap-x-1 gap-y-0.5 px-2.5 py-2">
                <Action icon={<Heart />} label={asset.favorite ? 'Favoride' : 'Favorile'} active={asset.favorite} onClick={() => void toggleFavorite(asset)} />
                <Action icon={<Download />} label="İndir" onClick={() => downloadAsset(asset)} />
                {asset.kind === 'image' && (
                  <>
                    <Action icon={<Pencil />} label="Sohbette düzenle" onClick={() => act.edit(asset)} />
                    <Action icon={<Brush />} label="Bölge düzenle" disabled={working} title="Yalnızca boyadığınız alanı değiştirir" onClick={() => setMasking(true)} />
                    <Action icon={<Eraser />} label="Arka planı sil" disabled={working} onClick={() => void runTool('remove-bg')} />
                    <Action icon={<Scaling />} label="Büyüt (2×)" disabled={working} title="Çözünürlüğü iki katına çıkarır" onClick={() => void runTool('upscale')} />
                    <Action icon={<Clapperboard />} label="Videoya çevir" onClick={() => act.animate(asset)} />
                    <Action icon={<ScanFace />} label="Kişileri seç" title="Fotoğraftaki kişileri tıklayarak ya da çizerek seçip atayın" onClick={() => useUI.getState().openPeople(asset)} />
                    <Action icon={<UserPlus />} label="Referans yap" onClick={() => setPicking(true)} />
                    <Action icon={<LayoutTemplate />} label="Tasarıma aç" onClick={() => void act.toDesign(asset)} />
                  </>
                )}
                <Action icon={<Newspaper />} label="Gönderi yap" onClick={() => void act.toPost(asset)} />
                {asset.prompt && <Action icon={<RotateCw />} label="İstemi kullan" onClick={() => act.reuse(asset)} />}
                <Action icon={<Trash2 />} label="Çöpe taşı" danger onClick={() => void remove()} />
              </div>

              <div className="flex flex-col gap-5 border-t border-line px-5 py-4">
                {asset.prompt && (
                  <section>
                    <div className="mb-1 flex items-center justify-between">
                      <h3 className="text-[0.8rem] font-medium text-ink-3">İstek</h3>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm !h-6 !px-1.5"
                        onClick={async () => (await copyText(finalPrompt ?? asset.prompt ?? '')) && toast('İstem kopyalandı.', 'ok')}
                      >
                        <Copy /> Kopyala
                      </button>
                    </div>
                    <p className="text-[0.9rem] leading-relaxed whitespace-pre-wrap text-ink [overflow-wrap:anywhere]">{asset.prompt}</p>
                    {finalPrompt && finalPrompt !== asset.prompt && (
                      <details className="mt-2">
                        <summary className="text-[0.82rem] text-ink-3 hover:text-ink">Modele giden istem</summary>
                        <p className="mt-1.5 rounded-lg bg-sunken p-2.5 text-[0.82rem] leading-relaxed whitespace-pre-wrap text-ink-2 [overflow-wrap:anywhere]">
                          {finalPrompt}
                        </p>
                      </details>
                    )}
                  </section>
                )}

                {(usedEntities.length > 0 || refs.length > 0) && (
                  <section>
                    <h3 className="mb-1.5 text-[0.8rem] font-medium text-ink-3">Kullanılan referanslar</h3>
                    {usedEntities.length > 0 && (
                      <div className="mb-2 flex flex-wrap gap-1.5">
                        {usedEntities.map((entity) => (
                          <Link key={entity.id} to={`/hafiza/${entity.id}`} onClick={close} className="chip !h-7 !pl-1">
                            <Avatar entity={entity} size={20} /> {entity.name}
                          </Link>
                        ))}
                      </div>
                    )}
                    <div className="flex flex-wrap gap-1.5">
                      {refs.map((ref) => (
                        <button
                          key={ref.assetId}
                          type="button"
                          title={ref.label}
                          onClick={() => openLightbox([ref.assetId], 0)}
                          className="h-12 w-12 overflow-hidden rounded-md bg-sunken"
                        >
                          <img src={`/media/${ref.assetId}/thumb`} alt="" className="h-full w-full object-cover" loading="lazy" />
                        </button>
                      ))}
                    </div>
                  </section>
                )}

                {linked.length > 0 && (
                  <section>
                    <h3 className="mb-1.5 text-[0.8rem] font-medium text-ink-3">Şunların referansı</h3>
                    <div className="flex flex-wrap gap-1.5">
                      {linked.map((entity) => (
                        <Link key={entity.id} to={`/hafiza/${entity.id}`} onClick={close} className="chip !h-7 !pl-1">
                          <Avatar entity={entity} size={20} /> @{entity.handle}
                        </Link>
                      ))}
                    </div>
                  </section>
                )}

                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[0.86rem]">
                  {asset.model && (
                    <>
                      <dt className="text-ink-3">Model</dt>
                      <dd className="truncate">{asset.model}</dd>
                    </>
                  )}
                  {asset.width && (
                    <>
                      <dt className="text-ink-3">Boyut</dt>
                      <dd className="font-mono text-[0.8rem]">{asset.width} × {asset.height}</dd>
                    </>
                  )}
                  {asset.duration ? (
                    <>
                      <dt className="text-ink-3">Süre</dt>
                      <dd>{duration(asset.duration)}</dd>
                    </>
                  ) : null}
                  <dt className="text-ink-3">Dosya</dt>
                  <dd className="truncate" title={asset.filename}>
                    {asset.filename} · {bytes(asset.size)}
                  </dd>
                </dl>
              </div>
            </>
          )}
        </aside>
      </div>
      {asset && <EntityPickerDialog open={picking} onClose={() => setPicking(false)} assetIds={[asset.id]} />}
      <MaskEditor asset={asset ?? null} open={masking} onClose={() => setMasking(false)} onStarted={(job) => asset && track(asset.id, job)} />
    </Dialog>
  );
}
