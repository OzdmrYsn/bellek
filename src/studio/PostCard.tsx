import { CalendarDays, Copy, ImagePlus, Pencil } from 'lucide-react';
import { Link } from 'react-router';
import { getFormat, getPlatform } from '../../shared/platforms.ts';
import type { Post } from '../../shared/types.ts';
import { api } from '../lib/api.ts';
import { copyText, cx, dateTime, shortDate } from '../lib/format.ts';
import { attempt, toast, useUI } from '../lib/store.ts';
import { PlatformBadge } from '../ui/kit.tsx';

export const STATUS_LABEL: Record<Post['status'], string> = {
  idea: 'Fikir', draft: 'Taslak', scheduled: 'Planlandı', published: 'Yayınlandı',
};

export function fullCaption(post: Pick<Post, 'caption' | 'hashtags'>): string {
  return [post.caption.trim(), post.hashtags.join(' ')].filter(Boolean).join('\n\n');
}

export function usePostJobActive(postId: string): boolean {
  return useUI((s) => Object.values(s.jobs).some((job) => job.postId === postId && (job.status === 'queued' || job.status === 'running')));
}

export function generatePostImage(post: Post): Promise<unknown> {
  return attempt(() => api.post(`/api/posts/${post.id}/image`, {}));
}

/** Sohbet içinde tek bir gönderinin özeti. */
export function PostCard({ post }: { post: Post }) {
  const openLightbox = useUI((s) => s.openLightbox);
  const generating = usePostJobActive(post.id);
  const platform = getPlatform(post.platform);
  const format = getFormat(post.platform, post.format);
  const cover = post.assets[0];

  if (post.deletedAt) {
    return <p className="rounded-xl bg-sunken px-3.5 py-3 text-[0.88rem] text-ink-3">Bu gönderi çöp kutusuna taşınmış.</p>;
  }

  return (
    <article className="panel flex w-full max-w-[38rem] gap-4 p-3.5 max-sm:flex-col">
      <div className="w-36 flex-none max-sm:w-full">
        {cover ? (
          <button type="button" className="block w-full overflow-hidden rounded-lg bg-sunken" onClick={() => openLightbox(post.assets.map((a) => a.id), 0)}>
            <img src={cover.thumbUrl} alt="" className="developed w-full object-cover" style={{ aspectRatio: `${format.width} / ${format.height}` }} />
          </button>
        ) : (
          <div
            className={cx('grid w-full place-items-center rounded-lg text-center', generating ? 'exposing' : 'border border-dashed border-line-strong')}
            style={{ aspectRatio: `${format.width} / ${format.height}` }}
          >
            {generating ? (
              <span className="text-[0.8rem] font-medium text-ink-2">Görsel üretiliyor</span>
            ) : post.imagePrompt ? (
              <button type="button" className="btn btn-ghost btn-sm !h-auto flex-col !gap-1 !py-2" onClick={() => void generatePostImage(post)}>
                <ImagePlus /> Görseli üret
              </button>
            ) : (
              <span className="px-2 text-[0.78rem] text-ink-3">Görsel yok</span>
            )}
          </div>
        )}
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-2">
          <PlatformBadge platform={post.platform} />
          <h3 className="min-w-0 flex-1 truncate text-[0.95rem] font-semibold">{post.title || platform.label}</h3>
          <span className="note flex-none">
            {post.scheduledAt ? dateTime(post.scheduledAt) : STATUS_LABEL[post.status]}
          </span>
        </header>
        <p className="mt-2 line-clamp-5 text-[0.9rem] leading-relaxed whitespace-pre-wrap text-ink-2 [overflow-wrap:anywhere]">{post.caption}</p>
        {post.hashtags.length > 0 && <p className="mt-1.5 line-clamp-2 text-[0.82rem] text-accent-text">{post.hashtags.join(' ')}</p>}
        <footer className="mt-auto flex flex-wrap gap-1.5 pt-3">
          <Link to={`/icerik/${post.id}`} className="btn btn-outline btn-sm">
            <Pencil /> Düzenle
          </Link>
          <button type="button" className="btn btn-ghost btn-sm" onClick={async () => (await copyText(fullCaption(post))) && toast('Metin kopyalandı.', 'ok')}>
            <Copy /> Metni kopyala
          </button>
        </footer>
      </div>
    </article>
  );
}

/** Birden çok gönderi art arda geldiğinde (içerik planı) derli toplu liste. */
export function PlanList({ posts }: { posts: Post[] }) {
  const live = posts.filter((p) => !p.deletedAt);
  const sorted = [...live].sort((a, b) => (a.scheduledAt ?? '9').localeCompare(b.scheduledAt ?? '9'));
  const missing = live.filter((p) => !p.assets.length && p.imagePrompt);
  return (
    <section className="panel w-full max-w-[38rem] overflow-hidden">
      <header className="flex items-center gap-2 border-b border-line px-4 py-2.5">
        <CalendarDays className="h-4 w-4 text-ink-3" />
        <h3 className="flex-1 text-[0.93rem] font-semibold">İçerik planı · {live.length} gönderi</h3>
        <Link to="/takvim" className="btn btn-ghost btn-sm">Takvimde aç</Link>
      </header>
      <ul>
        {sorted.map((post) => (
          <li key={post.id} className="border-b border-line last:border-0">
            <Link to={`/icerik/${post.id}`} className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-sunken">
              <span className="meta w-14 flex-none">{post.scheduledAt ? shortDate(post.scheduledAt) : '—'}</span>
              <PlatformBadge platform={post.platform} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[0.9rem] font-medium">{post.title || 'Adsız gönderi'}</span>
                <span className="block truncate text-[0.82rem] text-ink-3">{post.caption}</span>
              </span>
              {post.assets[0] && <img src={post.assets[0].thumbUrl} alt="" className="h-9 w-9 flex-none rounded-md object-cover" />}
            </Link>
          </li>
        ))}
      </ul>
      {missing.length > 0 && (
        <footer className="flex items-center justify-between gap-3 border-t border-line bg-bg px-4 py-2.5">
          <span className="text-[0.84rem] text-ink-2">{missing.length} gönderinin görseli henüz üretilmedi.</span>
          <button
            type="button"
            className="btn btn-outline btn-sm"
            onClick={async () => {
              for (const post of missing) await generatePostImage(post);
            }}
          >
            <ImagePlus /> Tümünü üret
          </button>
        </footer>
      )}
    </section>
  );
}
