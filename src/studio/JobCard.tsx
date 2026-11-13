import { Copy, Download, Expand, Heart, RotateCw, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { aspectToNumber } from '../../shared/platforms.ts';
import type { Asset, Job } from '../../shared/types.ts';
import { api } from '../lib/api.ts';
import { copyText, cx } from '../lib/format.ts';
import { useEntities, useJob } from '../lib/queries.ts';
import { attempt, toast, useUI } from '../lib/store.ts';
import { downloadAsset, toggleFavorite } from '../library/actions.ts';
import { AssetTile } from '../library/AssetTile.tsx';
import { Avatar, Notice } from '../ui/kit.tsx';

function useElapsed(job: Job, active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return Math.max(0, Math.round((now - new Date(job.startedAt ?? job.createdAt).getTime()) / 1000));
}

function tileWidth(ratio: number): number {
  if (ratio >= 1.3) return 21;
  if (ratio >= 0.9) return 16;
  return 12.5;
}

function VideoResult({ asset, develop }: { asset: Asset; develop: boolean }) {
  const openLightbox = useUI((s) => s.openLightbox);
  return (
    <figure className={cx('overflow-hidden rounded-xl bg-stage', develop && 'developed')}>
      <video
        src={asset.url}
        poster={asset.thumbUrl || undefined}
        controls
        playsInline
        preload="metadata"
        className="block w-full"
        style={{ aspectRatio: asset.width && asset.height ? `${asset.width} / ${asset.height}` : undefined }}
      />
      <figcaption className="flex items-center gap-0.5 bg-surface px-1.5 py-1">
        <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label="Favori" onClick={() => void toggleFavorite(asset)}>
          <Heart className={cx(asset.favorite && 'fill-accent text-accent')} />
        </button>
        <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label="İndir" onClick={() => downloadAsset(asset)}>
          <Download />
        </button>
        <span className="flex-1" />
        <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label="Büyüt" onClick={() => openLightbox([asset.id], 0)}>
          <Expand />
        </button>
      </figcaption>
    </figure>
  );
}

interface JobCardProps {
  jobId: string;
  /** Karşılaştırma düzeninde her model tek sütunda gösterilir. */
  compare?: boolean;
}

export function JobCard({ jobId, compare }: JobCardProps) {
  const job = useJob(jobId);
  const entities = useEntities();
  const openLightbox = useUI((s) => s.openLightbox);
  const [seenRunning, setSeenRunning] = useState(false);
  const running = job?.status === 'queued' || job?.status === 'running';
  const elapsed = useElapsed(job ?? ({ createdAt: new Date().toISOString() } as Job), !!running);

  // Yalnızca bu oturumda üretilirken görülen sonuçlar "banyo" animasyonuyla belirir.
  useEffect(() => {
    if (running) setSeenRunning(true);
  }, [running]);

  if (!job) return <div className="exposing h-40 w-64 rounded-xl" />;

  const ratio = aspectToNumber(job.input.aspect);
  const isVideo = job.type === 'video';
  const count = isVideo ? 1 : Math.max(job.input.count, job.assets.length);
  const columns = compare ? Math.min(count, 2) : count <= 3 ? count : ratio < 1 ? 4 : 2;
  const maxWidth = isVideo ? (ratio >= 1 ? 34 : 17) : columns * tileWidth(ratio) + (columns - 1) * 0.6;
  const used = entities.filter((e) => job.input.entityIds.includes(e.id));
  const assets = job.assets.filter((a) => !a.deletedAt);

  return (
    <div className="flex min-w-0 flex-col gap-2" style={{ maxWidth: `${maxWidth}rem`, width: '100%' }}>
      <div className="flex items-center gap-2 text-[0.8rem] text-ink-3">
        <span className={cx('truncate', compare && 'font-medium text-ink')}>{job.modelLabel}</span>
        {used.length > 0 && (
          <span className="flex flex-none -space-x-1.5" title={`Referans: ${used.map((e) => e.name).join(', ')}`}>
            {used.slice(0, 4).map((entity) => (
              <Avatar key={entity.id} entity={entity} size={18} className="ring-2 ring-bg" />
            ))}
          </span>
        )}
        {job.input.refs.length > 0 && <span className="flex-none">{job.input.refs.length} referans</span>}
        <span className="flex-1" />
        {running && (
          <button type="button" className="flex flex-none items-center gap-1 hover:text-ink" onClick={() => void attempt(() => api.post(`/api/jobs/${job.id}/cancel`))}>
            <X className="h-3.5 w-3.5" /> İptal
          </button>
        )}
      </div>

      {running && (
        <div className="grid gap-2.5" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
          {Array.from({ length: count }, (_, index) => (
            <div key={index} className="exposing relative overflow-hidden rounded-xl" style={{ aspectRatio: String(ratio) }}>
              {index === 0 && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 px-3 text-center">
                  <span className="text-[0.86rem] font-medium text-ink-2">{job.stage ?? 'Üretiliyor'}</span>
                  <span className="meta">
                    {job.progress ? `%${Math.round(job.progress * 100)} · ` : ''}
                    {elapsed} sn
                  </span>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {!running && assets.length > 0 && (
        isVideo ? (
          <VideoResult asset={assets[0]} develop={seenRunning} />
        ) : (
          <div className="grid gap-2.5" style={{ gridTemplateColumns: `repeat(${Math.min(columns, assets.length)}, minmax(0, 1fr))` }}>
            {assets.map((asset, index) => (
              <AssetTile
                key={asset.id}
                asset={asset}
                natural
                develop={seenRunning}
                className="!rounded-xl"
                onOpen={() => openLightbox(assets.map((a) => a.id), index)}
              />
            ))}
          </div>
        )
      )}

      {job.status === 'succeeded' && assets.length === 0 && (
        <p className="rounded-xl bg-sunken px-3.5 py-3 text-[0.88rem] text-ink-3">Bu üretimin sonuçları çöp kutusuna taşınmış.</p>
      )}

      {(job.status === 'failed' || job.status === 'canceled') && (
        <Notice
          level={job.status === 'failed' ? 'error' : 'info'}
          action={
            <button type="button" className="btn btn-outline btn-sm flex-none" onClick={() => void attempt(() => api.post(`/api/jobs/${job.id}/retry`))}>
              <RotateCw /> Yeniden dene
            </button>
          }
        >
          {job.status === 'failed' ? job.error ?? 'Üretim başarısız oldu.' : 'Üretim durduruldu.'}
        </Notice>
      )}

      {!compare && (
        <details className="group/prompt text-[0.82rem] text-ink-3">
          <summary className="inline-flex cursor-pointer list-none items-center gap-1 hover:text-ink [&::-webkit-details-marker]:hidden">
            <span className="group-open/prompt:hidden">İstemi göster</span>
            <span className="hidden group-open/prompt:inline">İstemi gizle</span>
          </summary>
          <div className="mt-1.5 rounded-lg bg-sunken p-3 leading-relaxed text-ink-2">
            <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{job.input.prompt}</p>
            <button
              type="button"
              className="btn btn-ghost btn-sm mt-1.5 -ml-2 !h-7"
              onClick={async () => (await copyText(job.input.prompt)) && toast('İstem kopyalandı.', 'ok')}
            >
              <Copy /> Kopyala
            </button>
          </div>
        </details>
      )}
    </div>
  );
}
