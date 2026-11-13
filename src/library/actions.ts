import type { InfiniteData } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router';
import { aspectToNumber } from '../../shared/platforms.ts';
import type { Asset, ConversationDetail, Design, EntityDetail, ImageLayer, Post } from '../../shared/types.ts';
import { api } from '../lib/api.ts';
import { queryClient, refreshApp } from '../lib/queries.ts';
import { attempt, toast, useUI, type Prefill } from '../lib/store.ts';

/** Değişen bir görseli, göründüğü tüm önbelleklerde yerinde günceller. */
export function patchAsset(next: Asset): void {
  const swap = (asset: Asset) => (asset.id === next.id ? next : asset);
  queryClient.setQueryData(['asset', next.id], next);
  queryClient.setQueriesData<InfiniteData<{ items: Asset[]; nextCursor: string | null }>>({ queryKey: ['assets'] }, (data) =>
    data ? { ...data, pages: data.pages.map((page) => ({ ...page, items: page.items.map(swap) })) } : data,
  );
  queryClient.setQueriesData<ConversationDetail>({ queryKey: ['conversation'] }, (detail) =>
    detail
      ? { ...detail, assets: detail.assets.map(swap), jobs: detail.jobs.map((job) => ({ ...job, assets: job.assets.map(swap) })) }
      : detail,
  );
  queryClient.setQueriesData<EntityDetail>({ queryKey: ['entity'] }, (detail) =>
    detail
      ? {
          ...detail,
          assets: detail.assets.map((a) => (a.id === next.id ? { ...a, ...next } : a)),
          generations: detail.generations.map(swap),
        }
      : detail,
  );
  queryClient.setQueriesData<Post>({ queryKey: ['post'] }, (post) => (post ? { ...post, assets: post.assets.map(swap) } : post));
  const ui = useUI.getState();
  const touched = Object.values(ui.jobs).filter((job) => job.assets.some((a) => a.id === next.id));
  ui.putJobs(touched.map((job) => ({ ...job, assets: job.assets.map(swap) })));
}

export function downloadAsset(asset: Asset): void {
  const link = document.createElement('a');
  link.href = `/media/${asset.id}/download`;
  link.download = asset.filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

export async function toggleFavorite(asset: Asset): Promise<void> {
  // İyimser güncelleme: kalp anında dolar, hata olursa geri alınır.
  patchAsset({ ...asset, favorite: !asset.favorite });
  try {
    patchAsset(await api.patch<Asset>(`/api/assets/${asset.id}`, { favorite: !asset.favorite }));
  } catch (error) {
    patchAsset(asset);
    toast(error instanceof Error ? error.message : 'Favori değiştirilemedi.', 'error');
  }
}

export async function trashAssets(ids: string[]): Promise<void> {
  if (!ids.length) return;
  const done = await attempt(() => api.post('/api/assets/bulk', { ids, action: 'delete' }));
  if (!done) return;
  void queryClient.invalidateQueries({ queryKey: ['assets'] });
  void queryClient.invalidateQueries({ queryKey: ['entity'] });
  void refreshApp();
  toast(ids.length === 1 ? 'Çöp kutusuna taşındı.' : `${ids.length} öğe çöp kutusuna taşındı.`, 'info', {
    label: 'Geri al',
    run: () =>
      void api.post('/api/assets/bulk', { ids, action: 'restore' }).then(() => {
        void queryClient.invalidateQueries({ queryKey: ['assets'] });
        void queryClient.invalidateQueries({ queryKey: ['entity'] });
        void refreshApp();
      }),
  });
}

function fitCanvas(asset: Asset): { width: number; height: number } {
  const ratio = asset.width && asset.height ? asset.width / asset.height : 1;
  const presets: [number, number][] = [[1080, 1080], [1080, 1350], [1080, 1920], [1920, 1080], [1200, 628]];
  return presets
    .map(([width, height]) => ({ width, height, d: Math.abs(Math.log(width / height) - Math.log(ratio)) }))
    .sort((a, b) => a.d - b.d)[0];
}

export function imageLayer(assetId: string, width: number, height: number): ImageLayer {
  return {
    id: `l${Date.now().toString(36)}${Math.round(Math.random() * 1e4)}`,
    type: 'image', assetId, x: 0, y: 0, w: width, h: height, rotation: 0, opacity: 1,
    fit: 'cover', focusX: 0.5, focusY: 0.5, radius: 0,
  };
}

/** Görselle ilgili, başka sayfalara taşan eylemler. */
export function useAssetActions() {
  const navigate = useNavigate();
  const location = useLocation();

  const toStudio = (prefill: Prefill) => {
    const ui = useUI.getState();
    ui.setPrefill(prefill);
    ui.closeLightbox();
    const inStudio = location.pathname === '/' || location.pathname.startsWith('/c/');
    if (!inStudio) navigate('/');
  };

  return {
    edit: (asset: Asset) => toStudio({ attachments: [asset.id], mode: 'image' }),
    animate: (asset: Asset) => toStudio({ attachments: [asset.id], mode: 'video' }),
    reuse: (asset: Asset) => toStudio({ text: asset.prompt ?? '', mode: asset.kind === 'video' ? 'video' : 'image' }),
    toPost: async (asset: Asset) => {
      const post = await attempt(() =>
        api.post<Post>('/api/posts', { assetIds: [asset.id], title: asset.title ?? '', imagePrompt: asset.prompt ?? '' }),
      );
      if (!post) return;
      useUI.getState().closeLightbox();
      navigate(`/icerik/${post.id}`);
    },
    toDesign: async (asset: Asset) => {
      const size = fitCanvas(asset);
      const design = await attempt(() =>
        api.post<Design>('/api/designs', {
          name: asset.title ?? 'Adsız tasarım',
          ...size,
          doc: { background: '#111111', layers: [imageLayer(asset.id, size.width, size.height)] },
        }),
      );
      if (!design) return;
      useUI.getState().closeLightbox();
      navigate(`/tasarim/${design.id}`);
    },
  };
}

export function ratioStyle(asset: Pick<Asset, 'width' | 'height'>, fallback = '1:1'): React.CSSProperties {
  const ratio = asset.width && asset.height ? asset.width / asset.height : aspectToNumber(fallback);
  return { aspectRatio: String(ratio) };
}
